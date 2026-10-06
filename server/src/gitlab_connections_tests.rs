use super::*;
use crate::{agents, codex::CodexManager, groups, models::IntegrationCreate, providers, updater};
use std::{
    collections::HashMap,
    sync::{Arc, atomic::AtomicU64},
};
use tokio::sync::{RwLock, broadcast};

fn user() -> AuthUser {
    AuthUser {
        id: "admin".into(),
        username: "admin".into(),
        role: "admin".into(),
    }
}

async fn fixture() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::connect(&root.path().join("state.sqlite3"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO users VALUES('admin','admin','','admin',0,0,'now')")
        .execute(&db.pool)
        .await
        .unwrap();
    let (live, _) = broadcast::channel(100);
    let state = AppState {
        agents: agents::AgentManager::load(&db).await.unwrap(),
        agent_integrations: crate::agent_integrations::AgentIntegrationManager::new(
            root.path().join("integration-secrets"),
        )
        .await
        .unwrap(),
        db,
        groups: groups::GroupManager::default(),
        providers: providers::ProviderManager::new(root.path().join("accounts")),
        codex: CodexManager::test_unavailable(),
        live,
        sequence: Arc::new(AtomicU64::new(1)),
        pending_inputs: Arc::new(RwLock::new(HashMap::new())),
        active_codex_turns: Default::default(),
        started_codex_threads: Default::default(),
        uploads_dir: root.path().join("uploads"),
        worktrees_dir: root.path().join("worktrees"),
        updater: updater::ServerUpdater::disabled("Test"),
    };
    (root, state)
}

async fn project(state: &AppState, root: &std::path::Path, id: &str) {
    let repo = root.join(id);
    std::fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "test: initialize fixture",
        ],
    ] {
        assert!(
            std::process::Command::new("git")
                .current_dir(&repo)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES(?,?,?,'main','admin','now')")
        .bind(id)
        .bind(id)
        .bind(repo.to_string_lossy().as_ref())
        .execute(&state.db.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn migration_shares_credentials_and_preserves_project_targets_and_task_sources() {
    let (root, state) = fixture().await;
    for id in ["a", "b"] {
        project(&state, root.path(), id).await;
        let config = json!({"baseUrl":"https://gitlab.example/","token":"old-token","project":format!("acme/{id}")});
        sqlx::query("INSERT INTO integrations(id,project_id,provider,name,config_json,created_by,created_at,updated_at) VALUES(?,?,'gitlab','GitLab',?,'admin','now','now')").bind(id).bind(id).bind(config.to_string()).execute(&state.db.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO tasks(id,project_id,title,description,status,branch_name,worktree_path,created_by,created_at,updated_at) VALUES('task','a','Existing','','queued','branch','path','admin','now','now')").execute(&state.db.pool).await.unwrap();
    sqlx::query("INSERT INTO task_sources(task_id,integration_id,provider,external_id) VALUES('task','a','gitlab','1')").execute(&state.db.pool).await.unwrap();
    migrate(&state.db).await.unwrap();
    migrate(&state.db).await.unwrap();
    let Json(connections) = list(State(state.clone())).await.unwrap();
    assert_eq!(connections.len(), 1);
    for id in ["a", "b"] {
        let integration = state.db.integration(id).await.unwrap();
        assert_eq!(integration.project_id, id);
        assert_eq!(integration.config["connectionId"], connections[0].id);
        assert_eq!(integration.config["project"], format!("acme/{id}"));
        assert!(integration.config.get("token").is_none());
        assert!(integration.config.get("baseUrl").is_none());
    }
    let task = state.db.task("task").await.unwrap();
    assert_eq!(task.project_id, "a");
    assert_eq!(task.source.unwrap().external_id, "1");
    let _ = update(
        State(state.clone()),
        Path(connections[0].id.clone()),
        Json(ConnectionInput {
            name: "Updated".into(),
            base_url: "https://gitlab.example".into(),
            token: "new-token".into(),
        }),
    )
    .await
    .unwrap();
    let resolved = resolve(
        &state.db,
        "gitlab",
        &state.db.integration("b").await.unwrap().config,
    )
    .await
    .unwrap();
    assert_eq!(resolved["token"], "new-token");
    assert!(matches!(
        delete(State(state.clone()), Path(connections[0].id.clone())).await,
        Err(AppError::Conflict(_))
    ));
}

#[tokio::test]
async fn shared_connection_syncs_only_into_each_bound_project() {
    let (root, state) = fixture().await;
    // Connections can be configured before any local project exists.
    let (_, Json(connection)) = create(
        State(state.clone()),
        Extension(user()),
        Json(ConnectionInput {
            name: "GitLab".into(),
            base_url: "https://gitlab.example".into(),
            token: "test-token".into(),
        }),
    )
    .await
    .unwrap();
    for config in [
        json!({"targets":[{"kind":"project","identifier":"7"}],"token":"test-token"}),
        json!({"connectionId":"missing","targets":[{"kind":"project","identifier":"7"}]}),
    ] {
        assert!(
            crate::validate_integration(
                &state,
                &IntegrationCreate {
                    provider: "gitlab".into(),
                    name: "Issues".into(),
                    config,
                    enabled: true,
                    sync_interval_minutes: None
                }
            )
            .await
            .is_err()
        );
    }
    let app = axum::Router::new().route("/api/v4/projects/{id}/issues", axum::routing::get(|Path(id): Path<String>, headers: axum::http::HeaderMap| async move {
        assert_eq!(headers["private-token"], "test-token");
        Json(json!([{"id":42,"iid":1,"project_id":id.parse::<i64>().unwrap(),"title":"Imported issue","description":"Details","web_url":"https://gitlab.example/acme/repo/-/issues/1"}]))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let _ = update(
        State(state.clone()),
        Path(connection.id.clone()),
        Json(ConnectionInput {
            name: "GitLab".into(),
            base_url: format!("http://{address}"),
            token: "test-token".into(),
        }),
    )
    .await
    .unwrap();
    for id in ["a", "b"] {
        project(&state, root.path(), id).await;
        let (_, Json(binding)) = crate::create_integration(State(state.clone()), Extension(user()), Path(id.into()), Json(IntegrationCreate { provider: "gitlab".into(), name: "Issues".into(), config: json!({"connectionId":connection.id,"token":"stale-token","targets":[{"kind":"project","identifier":"7"}]}), enabled: true, sync_interval_minutes: None })).await.unwrap();
        assert!(binding.config.get("token").is_none());
        let other = if id == "a" { "b" } else { "a" };
        assert!(matches!(
            crate::sync_integration(
                State(state.clone()),
                Path((other.into(), binding.id.clone()))
            )
            .await,
            Err(AppError::NotFound(_))
        ));
        let Json(result) =
            crate::sync_integration(State(state.clone()), Path((id.into(), binding.id.clone())))
                .await
                .unwrap();
        assert_eq!(result.imported, 1);
        assert_eq!(result.failed, 0);
        let Json(result) =
            crate::sync_integration(State(state.clone()), Path((id.into(), binding.id.clone())))
                .await
                .unwrap();
        assert_eq!(result.imported, 0);
        assert_eq!(result.skipped, 1);
        let Json(tasks) = crate::list_tasks(
            State(state.clone()),
            axum::extract::Query(crate::TaskListQuery {
                project_id: id.into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].project_id, id);
        assert!(tasks[0].worktree_path.contains(&format!("/{id}/")));
        assert_eq!(tasks[0].source.as_ref().unwrap().provider, "gitlab");
    }
    assert!(serde_json::from_value::<crate::TaskListQuery>(json!({})).is_err());
    assert!(matches!(
        delete(State(state.clone()), Path(connection.id.clone())).await,
        Err(AppError::Conflict(_))
    ));
    sqlx::query("DELETE FROM task_sources")
        .execute(&state.db.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM integrations")
        .execute(&state.db.pool)
        .await
        .unwrap();
    delete(State(state.clone()), Path(connection.id))
        .await
        .unwrap();
    let Json(connections) = list(State(state)).await.unwrap();
    assert!(connections.is_empty());
    server.abort();
}
