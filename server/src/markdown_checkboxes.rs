use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CheckboxEdit {
    pub expected: String,
    pub offset: usize,
    pub checked: bool,
    pub target: String,
    pub record_id: Option<String>,
}
impl CheckboxEdit {
    pub(crate) fn apply(&self, current: &str) -> AppResult<String> {
        if current != self.expected {
            return Err(AppError::Conflict(
                "Markdown changed. Refresh the source and retry.".into(),
            ));
        }
        // Browser parser offsets count UTF-16 code units, not UTF-8 bytes.
        let mut units = 0;
        let mut byte = None;
        for (index, character) in current.char_indices() {
            if units == self.offset {
                byte = Some(index);
                break;
            }
            units += character.len_utf16();
        }
        let byte = byte.ok_or_else(|| AppError::BadRequest("Invalid checkbox offset".into()))?;
        let bytes = current.as_bytes();
        if byte == 0
            || bytes.get(byte - 1) != Some(&b'[')
            || bytes.get(byte + 1) != Some(&b']')
            || !matches!(bytes[byte], b' ' | b'x' | b'X')
        {
            return Err(AppError::BadRequest("Invalid task marker".into()));
        }
        let mut next = current.to_owned();
        next.replace_range(byte..byte + 1, if self.checked { "x" } else { " " });
        Ok(next)
    }
}

pub(crate) async fn task_checkbox(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<CheckboxEdit>,
) -> AppResult<Json<Task>> {
    let task = state.db.task(&id).await?;
    if matches!(task.status.as_str(), "planning" | "running") {
        return Err(AppError::Conflict(
            "Wait for the task to finish streaming before editing Markdown".into(),
        ));
    }
    if input.target == "file" {
        let reference = input
            .record_id
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("File path required".into()))?;
        let root = Path::new(&task.worktree_path).canonicalize()?;
        let path =
            resolve_workspace_file(&root, reference).or_else(
                |error| match strip_source_location(reference) {
                    Some(path) => resolve_workspace_file(&root, path),
                    None => Err(error),
                },
            )?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| AppError::Forbidden)?
            .to_string_lossy()
            .to_string();
        let file = files::read(&root, &relative).await?;
        let next = input.apply(&file.content)?;
        files::write(&root, &relative, &next, &file.revision).await?;
        refresh_diff_stats(&state, &id).await?;
        state.emit("task.updated", json!({"taskId":id}));
        return Ok(Json(state.db.task(&id).await?));
    }
    let next = input.apply(&input.expected)?;
    let result = match input.target.as_str() {
        "description" => sqlx::query("UPDATE tasks SET description=?,updated_at=? WHERE id=? AND description=? AND status NOT IN ('planning','running')")
            .bind(&next).bind(Utc::now().to_rfc3339()).bind(&id).bind(&input.expected).execute(&state.db.pool).await?,
        "plan" => {
            let revision = input.record_id.as_deref().and_then(|r| r.parse::<i64>().ok()).ok_or_else(|| AppError::BadRequest("Plan revision required".into()))?;
            sqlx::query("UPDATE plans SET markdown=? WHERE task_id=? AND revision=? AND markdown=? AND revision=(SELECT MAX(revision) FROM plans WHERE task_id=?) AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND status NOT IN ('planning','running'))")
                .bind(&next).bind(&id).bind(revision).bind(&input.expected).bind(&id).bind(&id).execute(&state.db.pool).await?
        },
        "event" => {
            let event_id = input.record_id.as_deref().and_then(|r| r.parse::<i64>().ok()).ok_or_else(|| AppError::BadRequest("Event ID required".into()))?;
            // Only message text fields are mutable; tool payloads remain intact.
            sqlx::query("UPDATE task_events SET payload_json=json_set(payload_json,CASE WHEN json_type(payload_json,'$.text')='text' THEN '$.text' ELSE '$.message' END,?) WHERE task_id=? AND id=? AND kind IN ('user_message','agent_message','assistant_message') AND COALESCE(json_extract(payload_json,'$.text'),json_extract(payload_json,'$.message'))=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND status NOT IN ('planning','running'))")
                .bind(&next).bind(&id).bind(event_id).bind(&input.expected).bind(&id).execute(&state.db.pool).await?
        },
        _ => return Err(AppError::BadRequest("Invalid Markdown target".into())),
    };
    if result.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "Markdown changed or is read-only. Refresh the source and retry.".into(),
        ));
    }
    state.emit("task.updated", json!({"taskId":id}));
    Ok(Json(state.db.task(&id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkbox_preserves_bytes_and_checks_conflicts() {
        let source = "😀\r\n1. [X] duplicate\r\n   - [ ] duplicate\r\n```\r\n- [ ] code\r\n```";
        let offset = source[..source.find("[X]").unwrap() + 1]
            .encode_utf16()
            .count();
        let edit = CheckboxEdit {
            expected: source.into(),
            offset,
            checked: false,
            target: "description".into(),
            record_id: None,
        };
        assert_eq!(
            edit.apply(source).unwrap(),
            source.replacen("[X]", "[ ]", 1)
        );
        assert!(matches!(edit.apply("changed"), Err(AppError::Conflict(_))));
        let invalid = CheckboxEdit { offset: 1, ..edit };
        assert!(invalid.apply(source).is_err());
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    async fn fixture() -> (tempfile::TempDir, AppState) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("state.sqlite3"))
            .await
            .unwrap();
        let agents = agents::AgentManager::load(&db).await.unwrap();
        let (live, _) = broadcast::channel(32);
        let state = AppState {
            db,
            agents,
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
        sqlx::query("INSERT INTO users VALUES('admin','admin','','admin',0,0,'now')")
            .execute(&state.db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES('project','Project',?,'main','admin','now')").bind(root.path().to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
        sqlx::query("INSERT INTO tasks(id,project_id,title,description,status,branch_name,worktree_path,created_by,created_at,updated_at) VALUES('task','project','Title','- [ ] task','ready','branch',?,'admin','now','now')").bind(root.path().to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
        (root, state)
    }
    fn edit(target: &str, record: Option<&str>, expected: &str) -> CheckboxEdit {
        CheckboxEdit {
            target: target.into(),
            record_id: record.map(str::to_owned),
            expected: expected.into(),
            offset: expected.find("[ ]").unwrap() + 1,
            checked: true,
        }
    }
    #[tokio::test]
    async fn checkbox_task_persistence_is_atomic_and_never_creates_events_or_runs() {
        let (_root, state) = fixture().await;
        let a = task_checkbox(
            State(state.clone()),
            AxumPath("task".into()),
            Json(edit("description", None, "- [ ] task")),
        );
        let b = task_checkbox(
            State(state.clone()),
            AxumPath("task".into()),
            Json(edit("description", None, "- [ ] task")),
        );
        let (a, b) = tokio::join!(a, b);
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(
            state.db.task("task").await.unwrap().description,
            "- [x] task"
        );
        sqlx::query("INSERT INTO plans(task_id,revision,markdown,steps_json) VALUES('task',1,'- [ ] plan','[]')").execute(&state.db.pool).await.unwrap();
        let _ = task_checkbox(
            State(state.clone()),
            AxumPath("task".into()),
            Json(edit("plan", Some("1"), "- [ ] plan")),
        )
        .await
        .unwrap();
        assert_eq!(
            state
                .db
                .task("task")
                .await
                .unwrap()
                .plan
                .unwrap()
                .markdown
                .as_deref(),
            Some("- [x] plan")
        );
        let event = state
            .db
            .add_event(
                "task",
                "user_message",
                None,
                &json!({"text":"- [ ] message\r\n","extra":"keep"}),
            )
            .await
            .unwrap();
        let _ = task_checkbox(
            State(state.clone()),
            AxumPath("task".into()),
            Json(edit("event", Some(&event.to_string()), "- [ ] message\r\n")),
        )
        .await
        .unwrap();
        let events = state.db.events("task", 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].payload,
            json!({"text":"- [x] message\r\n","extra":"keep"})
        );
        assert!(state.active_codex_turns.read().await.is_empty());
        sqlx::query("UPDATE tasks SET status='running' WHERE id='task'")
            .execute(&state.db.pool)
            .await
            .unwrap();
        assert!(matches!(
            task_checkbox(
                State(state.clone()),
                AxumPath("task".into()),
                Json(edit("description", None, "- [ ] task"))
            )
            .await,
            Err(AppError::Conflict(_))
        ));
    }
    #[tokio::test]
    async fn checkbox_agent_and_group_edits_survive_reload_and_reject_stale_sources() {
        let (_root, mut state) = fixture().await;
        providers::save_document(&state.db, "agents", &json!({"id":"agent","status":"idle","messages":[{"id":"message","content":"- [ ] same"}],"updatedAt":"now"})).await.unwrap();
        state.agents = agents::AgentManager::load(&state.db).await.unwrap();
        let _ = agents::checkbox(
            State(state.clone()),
            AxumPath("agent".into()),
            Json(edit("message", Some("message"), "- [ ] same")),
        )
        .await
        .unwrap();
        let reloaded = agents::AgentManager::load(&state.db).await.unwrap();
        let agent = reloaded.get("agent").await.unwrap();
        assert_eq!(agent["messages"].as_array().unwrap().len(), 1);
        assert_eq!(agent["messages"][0]["content"], "- [x] same");
        assert!(matches!(
            agents::checkbox(
                State(state.clone()),
                AxumPath("agent".into()),
                Json(edit("message", Some("message"), "- [ ] same"))
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        sqlx::query("INSERT INTO groups(id,group_id,data) VALUES('group','group',?)")
            .bind(json!({"id":"group","stopped":true,"version":1}).to_string())
            .execute(&state.db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO group_messages(id,group_id,data) VALUES('message','group',?)")
            .bind(json!({"id":"message","groupId":"group","content":"- [ ] same"}).to_string())
            .execute(&state.db.pool)
            .await
            .unwrap();
        let _ = groups::checkbox(
            State(state.clone()),
            AxumPath("group".into()),
            Json(edit("message", Some("message"), "- [ ] same")),
        )
        .await
        .unwrap();
        let data: String = sqlx::query_scalar("SELECT data FROM group_messages WHERE id='message'")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&data).unwrap()["content"],
            "- [x] same"
        );
        assert!(matches!(
            groups::checkbox(
                State(state.clone()),
                AxumPath("group".into()),
                Json(edit("message", Some("message"), "- [ ] same"))
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM group_messages")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM group_deliveries")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
    #[tokio::test]
    async fn checkbox_file_writes_preserve_bytes_and_reject_stale_previews() {
        let (root, state) = fixture().await;
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "-b", "main"])
                .current_dir(&repo)
                .output()
                .unwrap()
                .status
                .success()
        );
        sqlx::query("UPDATE tasks SET worktree_path=? WHERE id='task'")
            .bind(repo.to_string_lossy().to_string())
            .execute(&state.db.pool)
            .await
            .unwrap();
        let source = "😀\r\n1. [ ] same\r\n   - [X] same\r\n```\r\n- [ ] code\r\n```\r\n";
        std::fs::write(repo.join("tasks.md"), source).unwrap();
        let reference = format!("{}#L2", repo.join("tasks.md").display());
        let mut input = edit("file", Some(&reference), source);
        input.offset = source[..source.find("[ ]").unwrap() + 1]
            .encode_utf16()
            .count();
        let _ = task_checkbox(State(state.clone()), AxumPath("task".into()), Json(input))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.join("tasks.md")).unwrap(),
            source.replacen("[ ]", "[x]", 1)
        );
        assert!(matches!(
            task_checkbox(
                State(state.clone()),
                AxumPath("task".into()),
                Json(edit("file", Some("tasks.md"), source))
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        assert!(state.db.events("task", 0).await.unwrap().is_empty());
        let file = files::read(&repo, "tasks.md").await.unwrap();
        let a = files::write(&repo, "tasks.md", "first", &file.revision);
        let b = files::write(&repo, "tasks.md", "second", &file.revision);
        let (a, b) = tokio::join!(a, b);
        assert_ne!(a.is_ok(), b.is_ok());
    }
    #[tokio::test]
    async fn checkbox_group_task_content_uses_existing_records_without_scheduling() {
        let (_root, state) = fixture().await;
        sqlx::query("INSERT INTO groups(id,group_id,data) VALUES('group','group',?)")
            .bind(json!({"id":"group","stopped":true,"version":1}).to_string())
            .execute(&state.db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO group_tasks(id,group_id,data) VALUES('assignment','group',?)").bind(json!({"id":"assignment","groupId":"group","status":"interrupted","instructions":"- [ ] work","result":"- [ ] done","revision":2}).to_string()).execute(&state.db.pool).await.unwrap();
        let _ = groups::checkbox(
            State(state.clone()),
            AxumPath("group".into()),
            Json(edit("instructions", Some("assignment"), "- [ ] work")),
        )
        .await
        .unwrap();
        let _ = groups::checkbox(
            State(state.clone()),
            AxumPath("group".into()),
            Json(edit("result", Some("assignment"), "- [ ] done")),
        )
        .await
        .unwrap();
        let data: String = sqlx::query_scalar("SELECT data FROM group_tasks WHERE id='assignment'")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        let task: Value = serde_json::from_str(&data).unwrap();
        assert_eq!(task["instructions"], "- [x] work");
        assert_eq!(task["result"], "- [x] done");
        assert_eq!(task["status"], "interrupted");
        let deliveries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM group_deliveries")
            .fetch_one(&state.db.pool)
            .await
            .unwrap();
        assert_eq!(deliveries, 0);
        sqlx::query(
            "UPDATE groups SET data=json_set(data,'$.stopped',json('false')) WHERE id='group'",
        )
        .execute(&state.db.pool)
        .await
        .unwrap();
        assert!(matches!(
            groups::checkbox(
                State(state.clone()),
                AxumPath("group".into()),
                Json(edit("instructions", Some("assignment"), "- [ ] work"))
            )
            .await,
            Err(AppError::Conflict(_))
        ));
    }
}
