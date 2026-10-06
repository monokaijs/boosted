use super::*;

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
        pending_inputs: Default::default(),
        active_codex_turns: Default::default(),
        started_codex_threads: Default::default(),
        uploads_dir: root.path().join("uploads"),
        worktrees_dir: root.path().join("worktrees"),
        updater: updater::ServerUpdater::disabled("Test"),
    };
    for id in ["alpha", "beta"] {
        let repo = root.path().join(id);
        std::fs::create_dir(&repo).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            run_git(&repo, &args);
        }
        std::fs::write(repo.join("file.txt"), "original\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-m", "test: initialize fixture"]);
        std::fs::write(repo.join("file.txt"), format!("{id} change\n")).unwrap();
        sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES(?,?,?,'main','admin','now')")
            .bind(id).bind(id).bind(repo.to_string_lossy().as_ref())
            .execute(&state.db.pool).await.unwrap();
    }
    (root, state)
}

fn run_git(repo: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn paths() -> Json<GitPaths> {
    Json(GitPaths {
        paths: vec!["file.txt".into()],
    })
}

#[tokio::test]
async fn project_git_operations_work_without_tasks_and_stay_in_the_project_repository() {
    let (root, state) = fixture().await;
    let repo = root.path().join("alpha");
    let worktree = root.path().join("task-worktree");
    run_git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "task-branch",
            worktree.to_str().unwrap(),
        ],
    );
    std::fs::write(worktree.join("task-only.txt"), "task change\n").unwrap();
    let mut events = state.live.subscribe();
    let id = || AxumPath("alpha".to_string());

    let Json(status) = project_git_status(State(state.clone()), id())
        .await
        .unwrap();
    assert_eq!(status.branch, "main");
    assert_eq!(status.changes.len(), 1);
    assert_eq!(status.changes[0].path, "file.txt");
    let Json(diff) = project_git_diff(
        State(state.clone()),
        id(),
        Query(DiffQuery {
            path: Some("file.txt".into()),
            staged: false,
        }),
    )
    .await
    .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+alpha change"));
    assert!(!diff["diff"].as_str().unwrap().contains("beta change"));

    let Json(staged) = project_git_stage(State(state.clone()), id(), paths())
        .await
        .unwrap();
    assert_eq!(staged.changes[0].index_status, "M");
    let event = events.try_recv().unwrap();
    assert_eq!(event.topic, "project.git");
    assert_eq!(event.data["projectId"], "alpha");
    let Json(diff) = project_git_diff(
        State(state.clone()),
        id(),
        Query(DiffQuery {
            path: Some("file.txt".into()),
            staged: true,
        }),
    )
    .await
    .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+alpha change"));

    let Json(unstaged) = project_git_unstage(State(state.clone()), id(), paths())
        .await
        .unwrap();
    assert_eq!(unstaged.changes[0].index_status, " ");
    let _ = project_git_stage(State(state.clone()), id(), paths())
        .await
        .unwrap();
    let Json(commit) = project_git_commit(
        State(state.clone()),
        id(),
        Json(GitCommitCreate {
            message: "fix: project change".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(commit["commit"].as_str().unwrap().len(), 40);
    assert!(git::status(&repo).await.unwrap().changes.is_empty());

    std::fs::write(repo.join("file.txt"), "discard this\n").unwrap();
    let Json(discarded) = project_git_discard(State(state.clone()), id(), paths())
        .await
        .unwrap();
    assert!(discarded.changes.is_empty());
    assert_eq!(
        std::fs::read_to_string(repo.join("file.txt")).unwrap(),
        "alpha change\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("beta/file.txt")).unwrap(),
        "beta change\n"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("file.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("task-only.txt")).unwrap(),
        "task change\n"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
        .fetch_one(&state.db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
