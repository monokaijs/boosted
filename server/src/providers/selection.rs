//! One persistent rotation shared by chats, taskboard runs and agent turns.
use super::*;

fn exhausted_until(limits: &Value, now: i64) -> Option<i64> {
    let snapshot = &limits["rateLimits"];
    if snapshot
        .pointer("/credits/unlimited")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return None;
    }
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| {
            let window = &snapshot[key];
            if window["usedPercent"].as_f64()? < 100.0 {
                return None;
            }
            let reset = window["resetsAt"].as_i64();
            // A stale snapshot no longer blocks an account after its window resets.
            match reset {
                Some(reset) if reset <= now => None,
                Some(reset) => Some(reset),
                None => Some(now + 300),
            }
        })
        .max()
}

pub(crate) async fn mark_exhausted(state: &AppState, id: &str) -> AppResult<()> {
    let _guard = state.providers.selection_lock.lock().await;
    let now = Utc::now().timestamp();
    let until = limits(state, id)
        .await
        .ok()
        .and_then(|limits| exhausted_until(&limits, now))
        .unwrap_or(now + 300);
    save_document(
        &state.db,
        "provider-availability",
        &json!({"id":id,"blockedUntil":until}),
    )
    .await
}

/// A rejected start has no completion notification, but still needs to remove
/// this account from rotation when the server reports quota exhaustion.
pub(crate) async fn start_turn(
    state: &AppState,
    client: &CodexClient,
    thread_id: &str,
    params: Value,
) -> AppResult<Value> {
    let result = client.request("turn/start", params).await;
    if let Err(error) = &result {
        if agents::quota_error(&error.to_string()) {
            if let Ok(chat) = document(&state.db, "provider-chats", thread_id).await {
                if let Some(id) = chat["accountId"].as_str() {
                    mark_exhausted(state, id).await?;
                }
            }
        }
    }
    result
}

pub(crate) async fn account_available(state: &AppState, id: &str) -> AppResult<bool> {
    match document(&state.db, "provider-availability", id).await {
        Ok(entry)
            if entry["blockedUntil"]
                .as_i64()
                .is_some_and(|until| until > Utc::now().timestamp()) =>
        {
            return Ok(false);
        }
        Ok(_) | Err(AppError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }
    let account = document(&state.db, "accounts", id).await?;
    if account["status"] != "CONNECTED" || account["providerId"] != "codex" {
        return Ok(false);
    }
    let client = match state.providers.client(&state.db, id).await {
        Ok(client) => client,
        Err(_) => return Ok(false),
    };
    match client.request("account/rateLimits/read", json!({})).await {
        Ok(result) => Ok(exhausted_until(&result, Utc::now().timestamp()).is_none()),
        // API-key accounts and older transports may not expose quota. Unknown
        // quota is usable; a known quota failure must never become a fallback.
        Err(error) => Ok(!agents::quota_error(&error.to_string())),
    }
}

pub(crate) async fn choose_account(
    state: &AppState,
    requested: Option<&str>,
    excluded: &HashSet<String>,
) -> AppResult<String> {
    select_account(state, requested, excluded, true).await
}

async fn select_account(
    state: &AppState,
    requested: Option<&str>,
    excluded: &HashSet<String>,
    advance: bool,
) -> AppResult<String> {
    // Keep the availability check and cursor write atomic across concurrent runs.
    let _guard = state.providers.selection_lock.lock().await;
    let accounts = documents(&state.db, "accounts").await?;
    if let Some(id) = requested {
        if !excluded.contains(id)
            && accounts.iter().any(|account| account["id"] == id)
            && account_available(state, id).await?
        {
            return Ok(id.to_owned());
        }
    }
    let last = match document(&state.db, "provider-settings", "account-rotation").await {
        Ok(cursor) => cursor["lastAccountId"].as_str().map(str::to_owned),
        Err(AppError::NotFound(_)) => None,
        Err(error) => return Err(error),
    };
    let start = last
        .as_deref()
        .and_then(|id| accounts.iter().position(|account| account["id"] == id))
        .map(|index| index + 1)
        .unwrap_or(0);
    for offset in 0..accounts.len() {
        let account = &accounts[(start + offset) % accounts.len()];
        let Some(id) = account["id"].as_str() else {
            continue;
        };
        if excluded.contains(id) || !account_available(state, id).await? {
            continue;
        }
        if advance {
            save_document(
                &state.db,
                "provider-settings",
                &json!({"id":"account-rotation","lastAccountId":id}),
            )
            .await?;
        }
        return Ok(id.to_owned());
    }
    Err(AppError::Conflict(
        "No connected Codex account has available quota. Check Providers or wait for a quota reset"
            .into(),
    ))
}

/// Catalog reads peek at the next account without spending a rotation slot.
/// The shared CLI account remains available when no managed accounts exist.
pub(crate) async fn new_work_client(
    state: &AppState,
    advance: bool,
) -> AppResult<(Option<String>, CodexClient)> {
    if documents(&state.db, "accounts").await?.is_empty() {
        return Ok((None, state.codex.client().await?));
    }
    let id = select_account(state, None, &HashSet::new(), advance).await?;
    let client = state.providers.client(&state.db, &id).await?;
    Ok((Some(id), client))
}

pub(crate) async fn task_client(state: &AppState, task: &Task) -> AppResult<CodexClient> {
    if let Some(thread_id) = &task.provider_thread_id {
        let lock = state.providers.chat_lock(thread_id).await;
        let _guard = lock.lock().await;
        agents::prepare_chat_account_locked(state, thread_id).await?;
        return client_for_thread(state, thread_id).await;
    }
    let lock = state
        .providers
        .chat_lock(&format!("task:{}", task.id))
        .await;
    let _guard = lock.lock().await;
    match document(&state.db, "task-provider", &task.id).await {
        Ok(owner) => {
            if let Some(id) = owner["accountId"].as_str() {
                if account_available(state, id).await? {
                    return state.providers.client(&state.db, id).await;
                }
            } else {
                return state.codex.client().await;
            }
        }
        Err(AppError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }
    let (id, client) = new_work_client(state, true).await?;
    save_document(
        &state.db,
        "task-provider",
        &json!({"id":task.id,"accountId":id}),
    )
    .await?;
    Ok(client)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    async fn fixture() -> (tempfile::TempDir, AppState) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("test.sqlite3"))
            .await
            .unwrap();
        let program = root.path().join("fake-codex");
        std::fs::write(
            &program,
            include_str!("../../tests/fixtures/codex-app-server.py"),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let agents = agents::AgentManager::load(&db).await.unwrap();
        let (live, _) = broadcast::channel(100);
        let state = AppState {
            db,
            agents,
            agent_integrations: crate::agent_integrations::AgentIntegrationManager::new(
                root.path().join("integration-secrets"),
            )
            .await
            .unwrap(),
            groups: groups::GroupManager::default(),
            providers: ProviderManager::test_with_program(root.path().join("accounts"), program),
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
        for id in ["a", "b", "c"] {
            save_document(&state.db, "accounts", &json!({"id":id,"providerId":"codex","status":"CONNECTED","settings":{},"runtimeDefaults":{}})).await.unwrap();
        }
        (root, state)
    }

    fn set_limits(state: &AppState, id: &str, limits: Value) {
        let home = state.providers.home.join(id);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("test-limits.json"), limits.to_string()).unwrap();
    }

    async fn select(state: &AppState) -> String {
        choose_account(state, None, &HashSet::new()).await.unwrap()
    }

    #[tokio::test]
    async fn round_robin_is_shared_persistent_and_catalog_reads_do_not_advance_it() {
        let (_root, mut state) = fixture().await;
        assert_eq!(
            new_work_client(&state, false).await.unwrap().0.as_deref(),
            Some("a")
        );
        assert_eq!(select(&state).await, "a");
        assert_eq!(
            agents::choose_account(&state, None, &HashSet::new())
                .await
                .unwrap(),
            "b"
        );
        assert_eq!(select(&state).await, "c");
        let program = state.providers.test_program.clone().unwrap();
        state.providers = ProviderManager::test_with_program(state.providers.home.clone(), program);
        assert_eq!(select(&state).await, "a");
        assert_eq!(
            choose_account(&state, Some("c"), &HashSet::new())
                .await
                .unwrap(),
            "c"
        );
        assert_eq!(select(&state).await, "b");
    }

    #[tokio::test]
    async fn concurrent_selections_rotate_atomically() {
        let (_root, state) = fixture().await;
        let mut workers = Vec::new();
        for _ in 0..12 {
            let state = state.clone();
            workers.push(tokio::spawn(async move { select(&state).await }));
        }
        let mut counts = HashMap::new();
        for worker in workers {
            *counts.entry(worker.await.unwrap()).or_insert(0) += 1;
        }
        for id in ["a", "b", "c"] {
            assert_eq!(counts[id], 4);
        }
    }

    #[tokio::test]
    async fn exhausted_disconnected_and_excluded_accounts_are_skipped_and_resets_rejoin() {
        let (_root, state) = fixture().await;
        let now = Utc::now().timestamp();
        set_limits(
            &state,
            "a",
            json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":now+3600}}}),
        );
        set_limits(
            &state,
            "b",
            json!({"rateLimits":{"primary":{"usedPercent":10},"secondary":{"usedPercent":100,"resetsAt":now+7200}}}),
        );
        assert_eq!(
            choose_account(&state, Some("a"), &HashSet::new())
                .await
                .unwrap(),
            "c"
        );
        assert!(
            choose_account(&state, None, &HashSet::from(["c".into()]))
                .await
                .is_err()
        );
        let mut account = document(&state.db, "accounts", "c").await.unwrap();
        account["status"] = json!("DISCONNECTED");
        save_document(&state.db, "accounts", &account)
            .await
            .unwrap();
        assert!(matches!(
            new_work_client(&state, true).await,
            Err(AppError::Conflict(_))
        ));
        set_limits(
            &state,
            "a",
            json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":now-1}}}),
        );
        assert_eq!(select(&state).await, "a");
    }

    #[tokio::test]
    async fn unknown_quota_is_usable_but_recent_quota_failures_stay_blocked() {
        let (_root, state) = fixture().await;
        // Use an unavailable-quota response without a quota-failure signal.
        set_limits(&state, "a", json!({"error":"Unsupported method"}));
        set_limits(&state, "b", json!({"rateLimits":null}));
        assert_eq!(select(&state).await, "a");
        mark_exhausted(&state, "a").await.unwrap();
        assert_eq!(select(&state).await, "b");
        assert!(!account_available(&state, "a").await.unwrap());
        save_document(
            &state.db,
            "provider-availability",
            &json!({"id":"a","blockedUntil":Utc::now().timestamp()-1}),
        )
        .await
        .unwrap();
        assert!(account_available(&state, "a").await.unwrap());
    }

    async fn create_chat(state: &AppState, cwd: &Path) -> CodexChat {
        create_codex_chat(
            State(state.clone()),
            Json(CodexChatCreate {
                cwd: cwd.to_string_lossy().into(),
                model: None,
            }),
        )
        .await
        .unwrap()
        .1
        .0
    }

    fn message(text: &str) -> CodexMessageCreate {
        CodexMessageCreate {
            message: text.into(),
            client_message_id: None,
            model: None,
            reasoning_effort: None,
            service_tier: None,
            approval_policy: None,
            access_mode: Some("readOnly".into()),
            collaboration_mode: None,
            attachment_ids: vec![],
        }
    }

    #[tokio::test]
    async fn regular_chats_rotate_and_keep_their_owner_for_followups_and_catalogs() {
        let (root, state) = fixture().await;
        let first = create_chat(&state, root.path()).await;
        let second = create_chat(&state, root.path()).await;
        assert_eq!(
            document(&state.db, "provider-chats", &first.id)
                .await
                .unwrap()["accountId"],
            "a"
        );
        assert_eq!(
            document(&state.db, "provider-chats", &second.id)
                .await
                .unwrap()["accountId"],
            "b"
        );
        let _ = read_codex_options(
            State(state.clone()),
            Query(HashMap::from([("threadId".into(), first.id.clone())])),
        )
        .await
        .unwrap();
        let _ = send_codex_message(
            State(state.clone()),
            AxumPath(first.id.clone()),
            Json(message("COMPLETE")),
        )
        .await
        .unwrap();
        assert_eq!(
            document(&state.db, "provider-chats", &first.id)
                .await
                .unwrap()["accountId"],
            "a"
        );
        assert_eq!(select(&state).await, "c");
    }

    #[tokio::test]
    async fn taskboard_runs_use_rotation_and_route_steering_and_stops_to_the_owner() {
        let (root, state) = fixture().await;
        sqlx::query("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('user','user','','admin','now')").execute(&state.db.pool).await.unwrap();
        sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES('project','Project',?,'main','user','now')").bind(root.path().to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
        for id in ["task-a", "task-b"] {
            sqlx::query("INSERT INTO tasks(id,project_id,title,description,status,branch_name,worktree_path,created_by,created_at,updated_at) VALUES(?,'project','Task','Task description','planning',?,?, 'user','now','now')")
                .bind(id).bind(id).bind(root.path().to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
            sqlx::query("INSERT INTO task_options(task_id,base_branch,access_mode) VALUES(?,'main','readOnly')").bind(id).execute(&state.db.pool).await.unwrap();
            start_plan(state.clone(), id.into(), "Inspect project".into())
                .await
                .unwrap();
        }
        for (id, owner) in [("task-a", "a"), ("task-b", "b")] {
            let task = state.db.task(id).await.unwrap();
            let thread = task.provider_thread_id.as_deref().unwrap();
            assert_eq!(
                document(&state.db, "provider-chats", thread).await.unwrap()["accountId"],
                owner
            );
            let _ = send_task_message(
                State(state.clone()),
                Extension(AuthUser {
                    id: "user".into(),
                    username: "user".into(),
                    role: "admin".into(),
                }),
                AxumPath(id.into()),
                Json(MessageCreate {
                    message: "Keep going".into(),
                }),
            )
            .await
            .unwrap();
            let _ = stop_task(State(state.clone()), AxumPath(id.into()))
                .await
                .unwrap();
            let log =
                std::fs::read_to_string(state.providers.home.join(owner).join("rpc-log.jsonl"))
                    .unwrap();
            assert!(log.contains("turn/steer"));
            assert!(log.contains("turn/interrupt"));
        }
        let Json(chats) = list_codex_chats(
            State(state.clone()),
            Query(CodexChatListQuery { cwd: None }),
        )
        .await
        .unwrap();
        assert!(
            chats.is_empty(),
            "Task threads must not leak into the chat list"
        );
        assert_eq!(select(&state).await, "c");
    }

    #[tokio::test]
    async fn rejected_quota_starts_block_the_account_without_a_completion_event() {
        let (root, state) = fixture().await;
        let chat = create_chat(&state, root.path()).await;
        let error = send_codex_message(
            State(state.clone()),
            AxumPath(chat.id.clone()),
            Json(message("REJECT_QUOTA")),
        )
        .await
        .unwrap_err();
        assert!(agents::quota_error(&error.to_string()));
        assert!(!account_available(&state, "a").await.unwrap());
        assert!(!state.active_codex_turns.read().await.contains_key(&chat.id));
        assert_eq!(select(&state).await, "b");
    }

    #[tokio::test]
    async fn exhausted_chat_moves_with_its_history_and_runtime_before_the_next_turn() {
        let (root, state) = fixture().await;
        let chat = create_chat(&state, root.path()).await;
        set_limits(
            &state,
            "a",
            json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":Utc::now().timestamp()+3600}}}),
        );
        let _ = send_codex_message(
            State(state.clone()),
            AxumPath(chat.id.clone()),
            Json(message("COMPLETE")),
        )
        .await
        .unwrap();
        assert_eq!(
            document(&state.db, "provider-chats", &chat.id)
                .await
                .unwrap()["accountId"],
            "b"
        );
        let Json(thread) = read_codex_chat(State(state.clone()), AxumPath(chat.id))
            .await
            .unwrap();
        assert_eq!(thread.chat.model.as_deref(), Some("exact-alpha"));
        assert!(
            thread
                .messages
                .iter()
                .any(|message| message.content == "COMPLETE")
        );
        assert_eq!(thread.runtime_defaults.unwrap()["accessMode"], "readOnly");
    }
}
