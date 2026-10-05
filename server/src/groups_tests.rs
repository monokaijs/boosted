use super::*;
use std::time::Duration;

#[tokio::test]
async fn group_list_tracks_incoming_messages_without_counting_user_or_role_updates() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let Json(initial) = list(State(state.clone())).await.unwrap();
    assert!(initial.iter().find(|summary| summary.id == id(&g)).unwrap().last_message_at.is_none());
    for (index, sender_type, content) in [(1, "agent", "Reply"), (2, "user", "Next task"), (3, "agent", " ")] {
        let message = json!({"id":format!("message-{index}"),"groupId":id(&g),"sequence":index,"senderType":sender_type,"content":content,"createdAt":format!("2026-10-05T09:0{index}:00Z")});
        sqlx::query("INSERT INTO group_messages VALUES(?,?,?)")
            .bind(id(&message)).bind(id(&g)).bind(message.to_string())
            .execute(&state.db.pool).await.unwrap();
    }
    let Json(summaries) = list(State(state.clone())).await.unwrap();
    assert_eq!(summaries.iter().find(|summary| summary.id == id(&g)).unwrap().last_message_at.as_deref(), Some("2026-10-05T09:01:00Z"));
}

fn user() -> AuthUser {
    AuthUser {
        id: "admin".into(),
        username: "admin".into(),
        role: "admin".into(),
    }
}
async fn fixture() -> (tempfile::TempDir, AppState, String) {
    let root = tempfile::tempdir().unwrap();
    let db = Database::connect(&root.path().join("state.sqlite3"))
        .await
        .unwrap();
    let agents = agents::AgentManager::load(&db).await.unwrap();
    let (live, _) = broadcast::channel(4096);
    let mut state = AppState {
        db,
        agents,
        groups: GroupManager::default(),
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
    let (_, Json(peer)) = agents::create_agent(State(state.clone()), Json(json!({"name":"Nova"})))
        .await
        .unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Test"],
        vec!["config", "user.email", "test@example.com"],
    ] {
        assert!(std::process::Command::new("git")
            .current_dir(&repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    std::fs::write(repo.join("baseline.txt"), "original").unwrap();
    assert!(std::process::Command::new("git")
        .current_dir(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(std::process::Command::new("git")
        .current_dir(&repo)
        .args(["commit", "-m", "test: initialize temporary fixture"])
        .output()
        .unwrap()
        .status
        .success());
    std::fs::write(
        repo.join("baseline.txt"),
        "private-only existing user changes",
    )
    .unwrap();
    sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES('project','Project',?,'main','admin','now')").bind(repo.to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = root.path().join("fake-codex");
        std::fs::write(
            &script,
            include_str!("../tests/fixtures/group-app-server.py"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        state.providers =
            providers::ProviderManager::test_with_program(root.path().join("accounts"), script);
    }
    providers::save_document(&state.db,"accounts",&json!({"id":"account","providerId":"codex","status":"CONNECTED","settings":{},"runtimeDefaults":{"model":"exact-alpha"}})).await.unwrap();
    (root, state, string(&peer, "id"))
}
async fn group(state: &AppState, peer: &str, project: bool) -> Value {
    let (_,Json(v))=create(State(state.clone()),Extension(user()),Json(json!({"name":"Team","memberIds":["pock",peer],"projectId":if project{Some("project")}else{None}}))).await.unwrap();
    serde_json::to_value(v).unwrap()
}
async fn human(
    state: &AppState,
    group: &str,
    content: &str,
    recipients: Vec<&str>,
    client: &str,
) -> Value {
    send(
        State(state.clone()),
        AxumPath(group.into()),
        Extension(user()),
        Json(json!({"content":content,"clientMessageId":client,"recipientIds":recipients})),
    )
    .await
    .unwrap()
    .0
}
async fn context_for(
    state: &AppState,
    group: &str,
    agent: &str,
    root: &str,
    task: Option<&Value>,
    purpose: &str,
) -> GroupContext {
    let c = GroupContext {
        group_id: group.into(),
        agent_id: agent.into(),
        root_id: root.into(),
        delivery_id: uuid(),
        task_id: task.map(|t| id(t).into()),
        execution_id: uuid(),
        purpose: purpose.into(),
    };
    put(&state.db,"group_executions",group,&json!({"id":c.execution_id,"groupId":group,"agentId":agent,"taskId":c.task_id,"status":"running","activity":"thinking"})).await.unwrap();
    c
}
async fn settle(state: &AppState, group: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            tick(state).await.unwrap();
            let view = snapshot(state, group).await.unwrap();
            if view["requests"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["completed"] == true)
                && !state
                    .groups
                    .active
                    .lock()
                    .await
                    .values()
                    .any(|(c, _)| c.group_id == group)
            {
                return view;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("Group did not settle")
}

#[test]
fn group_tools_match_the_current_turn_purpose() {
    let base: Value = serde_json::from_str(include_str!("agent-tools.json")).unwrap();
    for purpose in ["message", "execute", "review"] {
        let specs = tools(base.clone(), purpose);
        let available = |name: &str| {
            specs
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == name)
        };
        for name in [
            "read_group_context",
            "create_group_task",
            "claim_group_task",
            "send_group_message",
        ] {
            assert!(available(name), "{name} must be available during {purpose}");
        }
        for name in [
            "create_chat",
            "send_message",
            "watch_chat",
            "block_group_task",
            "submit_group_result",
        ] {
            assert_eq!(
                available(name),
                purpose == "execute",
                "{name} during {purpose}"
            );
        }
        assert_eq!(available("review_group_task"), purpose == "review");
    }
}

#[tokio::test]
async fn leader_message_queues_assignment_without_execution_tools_or_human_intervention() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, true).await;
    let source = human(
        &state,
        id(&g),
        "Investigate torrent downloads",
        vec![],
        "torrent",
    )
    .await;
    let leader = context_for(&state, id(&g), "pock", id(&source), None, "message").await;
    for (name, args) in [
        (
            "block_group_task",
            json!({"reason":"Coding tools unavailable"}),
        ),
        (
            "submit_group_result",
            json!({"result":"Done","verification":"Checked"}),
        ),
        (
            "review_group_task",
            json!({"revision":1,"decision":"approve","evidence":"Checked"}),
        ),
    ] {
        let error = execute_tool(&state, &leader, name, &args, name, &[])
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Tool unavailable in this group turn");
    }
    assert!(all(&state.db, "group_receipts", id(&g))
        .await
        .unwrap()
        .is_empty());
    let task = execute_tool(
        &state,
        &leader,
        "create_group_task",
        &json!({"title":"Investigate torrent downloads","instructions":"Find why downloads never start","expectedResult":"Evidence and verified fix","ownerId":peer}),
        "assign",
        &[source.clone()],
    ).await.unwrap();
    assert_eq!(task["status"], "queued");
    assert_eq!(task["workingDirectory"], g["workingDirectory"]);
    let deliveries: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM group_deliveries WHERE group_id=? AND json_extract(data,'$.taskId')=?",
    )
    .bind(id(&g))
    .bind(id(&task))
    .fetch_all(&state.db.pool)
    .await
    .unwrap();
    assert_eq!(deliveries.len(), 1);
    let delivery: Value = serde_json::from_str(&deliveries[0]).unwrap();
    assert_eq!(delivery["agentId"], peer);
    assert_eq!(delivery["purpose"], "execute");
    assert_eq!(delivery["status"], "queued");
    assert_eq!(delivery["rootId"], source["id"]);
}

#[tokio::test]
async fn natural_language_management_is_delivered_to_the_leader_and_applied_through_agent_tools() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let (_, Json(extra)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Extra"})))
            .await
            .unwrap();
    human(
        &state,
        id(&g),
        "Add Extra as developer and reviewer",
        vec![],
        "add",
    )
    .await;
    let added = settle(&state, id(&g)).await;
    assert!(added["memberIds"]
        .as_array()
        .unwrap()
        .contains(&extra["id"]));
    assert_eq!(
        added["memberRoles"][id(&extra)]["roles"],
        json!(["developer", "reviewer"])
    );
    assert!(added["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["tool"] == "manage_group" && r["status"] == "completed"));
    human(
        &state,
        id(&g),
        "Remove Nova from the group",
        vec![],
        "remove",
    )
    .await;
    let removed = settle(&state, id(&g)).await;
    assert!(!removed["memberIds"]
        .as_array()
        .unwrap()
        .contains(&json!(peer)));
    human(
        &state,
        id(&g),
        "Give Pock leader and designer roles",
        vec![],
        "multiple",
    )
    .await;
    let declared = settle(&state, id(&g)).await;
    assert_eq!(
        declared["memberRoles"]["pock"]["roles"],
        json!(["coordinator", "designer"])
    );
    assert_eq!(
        declared["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["kind"] == "roles")
            .count(),
        3
    );
    assert!(declared["executions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|execution| execution["agentId"] == "pock"));
}

#[tokio::test]
async fn natural_language_project_assignment_and_unassignment_use_leader_tools() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    human(
        &state,
        id(&g),
        "Assign Project to this group",
        vec![],
        "assign",
    )
    .await;
    let assigned = settle(&state, id(&g)).await;
    assert_eq!(assigned["projectId"], "project");
    assert_eq!(
        assigned["workingDirectory"],
        state.db.project("project").await.unwrap().repo_path
    );
    assert!(!assigned["initialGitState"].is_null());
    assert!(assigned["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["content"] == "Group project: Project."));
    human(
        &state,
        id(&g),
        "Unassign the group project",
        vec![],
        "unassign",
    )
    .await;
    let unassigned = settle(&state, id(&g)).await;
    for field in ["projectId", "workingDirectory", "initialGitState"] {
        assert!(unassigned[field].is_null());
    }
    assert_eq!(unassigned["memberRoles"], g["memberRoles"]);
    assert!(unassigned["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["content"] == "Group project unassigned."));
    assert!(unassigned["executions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|execution| execution["agentId"] == "pock"));
}

#[tokio::test]
async fn project_management_is_atomic_authorized_and_preserves_existing_task_directories() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(
        &state,
        id(&g),
        "Assign Project and rename the group",
        vec![],
        "project",
    )
    .await;
    let leader = context_for(&state, id(&g), "pock", id(&source), None, "message").await;
    let specialist = context_for(&state, id(&g), &peer, id(&source), None, "message").await;
    let args = json!({"sourceMessageId":source["id"],"projectId":"project","name":"Project team"});
    assert!(execute_tool(
        &state,
        &specialist,
        "manage_group",
        &args,
        "not-leader",
        &[source.clone()]
    )
    .await
    .is_err());
    assert!(execute_tool(
        &state,
        &leader,
        "manage_group",
        &args,
        "no-human-source",
        &[]
    )
    .await
    .is_err());
    for (index, invalid) in [json!("missing"), json!(42), json!("")].iter().enumerate() {
        assert!(execute_tool(&state, &leader, "manage_group", &json!({"sourceMessageId":source["id"],"projectId":invalid,"name":"Wrong","memberRoles":{&peer:{"roles":["reviewer"]}}}), &format!("invalid-project-{index}"), &[source.clone()]).await.is_err());
        let view = snapshot(&state, id(&g)).await.unwrap();
        assert_eq!(view["name"], g["name"]);
        assert_eq!(view["memberRoles"], g["memberRoles"]);
        assert_eq!(view["messages"].as_array().unwrap().len(), 1);
    }
    let result = execute_tool(
        &state,
        &leader,
        "manage_group",
        &args,
        "assign",
        &[source.clone()],
    )
    .await
    .unwrap();
    let replay = execute_tool(
        &state,
        &leader,
        "manage_group",
        &args,
        "assign-replay",
        &[source.clone()],
    )
    .await
    .unwrap();
    assert_eq!(result, replay);
    let task = create_assignment(&state, id(&g), id(&source), &json!({"title":"Existing work","instructions":"Work","expectedResult":"Verified","ownerId":peer})).await.unwrap();
    assert_eq!(task["workingDirectory"], result["workingDirectory"]);
    execute_tool(
        &state,
        &leader,
        "manage_group",
        &json!({"sourceMessageId":source["id"],"projectId":null}),
        "unassign",
        &[source],
    )
    .await
    .unwrap();
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(view["name"], "Project team");
    assert!(view["projectId"].is_null());
    assert_eq!(
        view["tasks"][0]["workingDirectory"],
        task["workingDirectory"]
    );
    let next = create_assignment(&state, id(&g), task["rootId"].as_str().unwrap(), &json!({"title":"Future work","instructions":"Work","expectedResult":"Verified","ownerId":"pock"})).await.unwrap();
    assert_ne!(next["workingDirectory"], task["workingDirectory"]);
}

#[tokio::test]
async fn human_chat_management_adds_removes_and_declares_multiple_roles_durably() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let (_, Json(extra)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Extra"})))
            .await
            .unwrap();
    let source = human(
        &state,
        id(&g),
        "Add Extra as developer and reviewer. Give Pock leader and designer roles.",
        vec![],
        "roles",
    )
    .await;
    let c = context_for(&state, id(&g), "pock", id(&source), None, "message").await;
    let catalog = execute_tool(&state, &c, "list_group_agents", &json!({}), "catalog", &[])
        .await
        .unwrap();
    assert!(catalog
        .as_array()
        .unwrap()
        .iter()
        .any(|agent| agent["id"] == extra["id"] && agent["name"] == "Extra"));
    assert!(catalog
        .as_array()
        .unwrap()
        .iter()
        .all(|agent| agent.as_object().unwrap().len() == 2));
    let args = json!({"sourceMessageId":source["id"],"memberIds":["pock",peer,extra["id"]],"memberRoles":{"pock":{"roles":["coordinator","designer"]},id(&extra):{"roles":["developer","reviewer"],"responsibilities":"API work and independent review"}}});
    let result = execute_tool(
        &state,
        &c,
        "manage_group",
        &args,
        "manage",
        &[source.clone()],
    )
    .await
    .unwrap();
    let replay = execute_tool(
        &state,
        &c,
        "manage_group",
        &args,
        "replay",
        &[source.clone()],
    )
    .await
    .unwrap();
    assert_eq!(result, replay);
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(view["memberIds"], args["memberIds"]);
    assert_eq!(
        view["memberRoles"][id(&extra)]["roles"],
        json!(["developer", "reviewer"])
    );
    let declarations: Vec<&Value> = view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["kind"] == "roles")
        .collect();
    assert_eq!(declarations.len(), 1);
    assert!(declarations[0]["content"]
        .as_str()
        .unwrap()
        .contains("Extra — developer, reviewer"));
    assert!(declarations[0]["content"]
        .as_str()
        .unwrap()
        .contains("Pock — leader, designer"));
    migrate(&state.db).await.unwrap();
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["memberRoles"],
        view["memberRoles"]
    );
    let _ = resume(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    let remove = human(
        &state,
        id(&g),
        "Remove Nova from the group",
        vec![],
        "remove",
    )
    .await;
    let c = context_for(&state, id(&g), "pock", id(&remove), None, "message").await;
    execute_tool(
        &state,
        &c,
        "manage_group",
        &json!({"sourceMessageId":remove["id"],"memberIds":["pock",extra["id"]]}),
        "remove",
        &[remove],
    )
    .await
    .unwrap();
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(view["memberIds"], json!(["pock", extra["id"]]));
    assert!(view["memberRoles"].get(&peer).is_none());
    assert!(state.agents.get(&peer).await.is_ok());
    assert!(all(&state.db, "group_deliveries", id(&g))
        .await
        .unwrap()
        .iter()
        .filter(|delivery| delivery["agentId"] == peer)
        .all(|delivery| delivery["status"] == "cancelled"));
}

#[tokio::test]
async fn management_rejects_peer_authority_duplicate_leaders_and_unsafe_removal_atomically() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Change roles", vec![], "roles").await;
    let leader = context_for(&state, id(&g), "pock", id(&source), None, "message").await;
    let specialist = context_for(&state, id(&g), &peer, id(&source), None, "message").await;
    let valid = json!({"sourceMessageId":source["id"],"memberRoles":{&peer:{"roles":["developer","reviewer"]}}});
    assert!(execute_tool(
        &state,
        &specialist,
        "manage_group",
        &valid,
        "specialist",
        &[source.clone()]
    )
    .await
    .is_err());
    assert!(
        execute_tool(&state, &leader, "manage_group", &valid, "no-source", &[])
            .await
            .is_err()
    );
    let fake = json!({"id":source["id"],"senderType":"agent"});
    assert!(execute_tool(
        &state,
        &leader,
        "manage_group",
        &valid,
        "peer-source",
        &[fake]
    )
    .await
    .is_err());
    let before = snapshot(&state, id(&g)).await.unwrap();
    for (index, patch) in [
        json!({&peer:{"roles":["coordinator","developer"]}}),
        json!({"pock":{"roles":["developer","reviewer"]}}),
        json!({&peer:{"roles":[]}}),
        json!({&peer:{"roles":["reviewer","reviewer"]}}),
        json!({"unknown":{"roles":["developer"]}}),
    ]
    .iter()
    .enumerate()
    {
        assert!(execute_tool(
            &state,
            &leader,
            "manage_group",
            &json!({"sourceMessageId":source["id"],"memberRoles":patch}),
            &format!("invalid-{index}"),
            &[source.clone()]
        )
        .await
        .is_err());
        let view = snapshot(&state, id(&g)).await.unwrap();
        assert_eq!(view["memberRoles"], before["memberRoles"]);
        assert_eq!(view["messages"], before["messages"]);
    }
    let (_, Json(extra)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Extra"})))
            .await
            .unwrap();
    create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"Owned","instructions":"Work","expectedResult":"Verified","ownerId":peer}),
    )
    .await
    .unwrap();
    assert!(execute_tool(
        &state,
        &leader,
        "manage_group",
        &json!({"sourceMessageId":source["id"],"memberIds":["pock",extra["id"]]}),
        "remove-owner",
        &[source.clone()]
    )
    .await
    .is_err());
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["memberIds"],
        before["memberIds"]
    );
    assert!(execute_tool(
        &state,
        &leader,
        "manage_group",
        &json!({"sourceMessageId":source["id"],"memberIds":["pock"]}),
        "one-member",
        &[source]
    )
    .await
    .is_err());
}

#[tokio::test]
async fn leader_handoff_preserves_other_roles_and_redirects_queued_default_messages() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(
        &state,
        id(&g),
        "Make Nova the leader, keep Pock as designer and reviewer",
        vec![],
        "handoff",
    )
    .await;
    let queued = human(&state, id(&g), "Build the UI", vec![], "queued").await;
    let c = context_for(&state, id(&g), "pock", id(&source), None, "message").await;
    execute_tool(&state,&c,"manage_group",&json!({"sourceMessageId":source["id"],"memberRoles":{"pock":{"roles":["designer","reviewer"]},&peer:{"roles":["developer","coordinator"]}}}),"handoff",&[source]).await.unwrap();
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(planning_agent(&view, &queued), peer);
    assert_eq!(
        view["memberRoles"]["pock"]["roles"],
        json!(["designer", "reviewer"])
    );
    assert_eq!(
        get(&state.db, "group_messages", id(&queued)).await.unwrap()["recipientIds"],
        json!([peer])
    );
    assert!(view["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["messageId"] == queued["id"])
        .all(|d| d["agentId"] == peer));
    let next = human(&state, id(&g), "Next task", vec![], "next").await;
    assert_eq!(next["recipientIds"], json!([peer]));
    let args = json!({"title":"Implement","instructions":"Build","expectedResult":"Verified","ownerId":"pock"});
    assert!(
        execute_tool(&state, &c, "create_group_task", &args, "old-leader", &[])
            .await
            .is_err()
    );
    let new = context_for(&state, id(&g), &peer, id(&queued), None, "message").await;
    assert!(
        execute_tool(&state, &new, "create_group_task", &args, "new-leader", &[])
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn removing_the_old_leader_allows_an_explicit_successor_without_default_role_conflicts() {
    let (_root, state, peer) = fixture().await;
    let (_, Json(extra)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Extra"})))
            .await
            .unwrap();
    let (_, Json(group)) = create(
        State(state.clone()),
        Extension(user()),
        Json(json!({"name":"Team","memberIds":["pock",peer,extra["id"]]})),
    )
    .await
    .unwrap();
    let group = serde_json::to_value(group).unwrap();
    let source = human(
        &state,
        id(&group),
        "Remove Pock and make Extra the leader",
        vec![],
        "handoff",
    )
    .await;
    let c = context_for(&state, id(&group), "pock", id(&source), None, "message").await;
    execute_tool(&state,&c,"manage_group",&json!({"sourceMessageId":source["id"],"memberIds":[peer,extra["id"]],"memberRoles":{id(&extra):{"roles":["coordinator","reviewer"]}}}),"replace",&[source]).await.unwrap();
    let view = snapshot(&state, id(&group)).await.unwrap();
    assert_eq!(planning_agent(&view, &Value::Null), id(&extra));
    assert_eq!(view["memberRoles"][&peer]["roles"], json!(["developer"]));
    assert_eq!(
        view["memberRoles"][id(&extra)]["roles"],
        json!(["coordinator", "reviewer"])
    );
}

#[tokio::test]
async fn specialist_answers_and_review_outcomes_wake_only_the_leader() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Investigate", vec![], "root").await;
    let leader = context_for(&state, id(&g), "pock", id(&source), None, "message").await;
    let request = execute_tool(
        &state,
        &leader,
        "request_group_peers",
        &json!({"content":"Investigate the API","recipientIds":[peer]}),
        "delegate",
        &[],
    )
    .await
    .unwrap();
    let delivery = all(&state.db, "group_deliveries", id(&g))
        .await
        .unwrap()
        .into_iter()
        .find(|d| d["messageId"] == request["id"])
        .unwrap();
    let mut worker = context_for(&state, id(&g), &peer, id(&source), None, "message").await;
    worker.delivery_id = string(&delivery, "id");
    let answer = execute_tool(
        &state,
        &worker,
        "send_group_message",
        &json!({"content":"The API is ready"}),
        "answer",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(answer["recipientIds"], json!(["pock"]));
    let mut task = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do A","expectedResult":"Verified","ownerId":peer}),
    )
    .await
    .unwrap();
    task["status"] = json!("completed");
    save_task(&state, id(&g), &mut task).await.unwrap();
    save_task(&state, id(&g), &mut task).await.unwrap();
    let deliveries = all(&state.db, "group_deliveries", id(&g)).await.unwrap();
    assert_eq!(
        deliveries
            .iter()
            .filter(|d| d["messageId"] == answer["id"])
            .count(),
        1
    );
    let events: Vec<&Value> = deliveries
        .iter()
        .filter(|d| d["event"]["taskId"] == task["id"])
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["agentId"], "pock");
    assert!(events[0]["taskId"].is_null());
    migrate(&state.db).await.unwrap();
    assert!(snapshot(&state, id(&g)).await.unwrap()["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["event"]["taskId"] == task["id"]));
}

#[tokio::test]
async fn roles_persist_validate_and_upgrade_existing_groups() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    assert_eq!(g["memberRoles"]["pock"]["role"], "coordinator");
    assert_eq!(g["memberRoles"][&peer]["role"], "developer");
    let (_, Json(minimal)) = create(State(state.clone()), Extension(user()), Json(json!({"name":"Minimal roles","memberIds":["pock",peer],"memberRoles":{"pock":{"role":"coordinator"},&peer:{"role":"reviewer"}}}))).await.unwrap();
    assert_eq!(
        get(&state.db, "groups", &minimal.summary.id).await.unwrap()["memberRoles"][&peer]
            ["responsibilities"],
        ""
    );
    let roles = json!({"pock":{"role":"developer","roles":["developer"],"responsibilities":"Backend APIs"},&peer:{"role":"coordinator","roles":["coordinator"],"responsibilities":"Plan and delegate"}});
    // Editing roles obeys the same stop requirement as roster changes.
    assert!(update(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Json(json!({"memberRoles":roles}))
    )
    .await
    .is_err());
    let _ = stop(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    let _ = update(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Json(json!({"memberRoles":roles})),
    )
    .await
    .unwrap();
    assert_eq!(
        get(&state.db, "groups", id(&g)).await.unwrap()["memberRoles"],
        roles
    );
    migrate(&state.db).await.unwrap();
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["memberRoles"],
        roles
    );
    for invalid in [
        json!({"pock":{"role":"coordinator"},&peer:{"role":"coordinator"}}),
        json!({"pock":{"role":"developer"},&peer:{"role":"reviewer"}}),
        json!({"pock":{"role":"coordinator"}}),
        json!({"pock":{"role":"coordinator"},"unknown":{"role":"developer"}}),
        json!({"pock":{"role":"coordinator"},&peer:{"role":"invalid"}}),
        json!({"pock":{"role":"coordinator"},&peer:{"role":"developer","responsibilities":"a".repeat(4001)}}),
    ] {
        assert!(update(
            State(state.clone()),
            AxumPath(id(&g).into()),
            Json(json!({"memberIds":["pock",peer],"memberRoles":invalid}))
        )
        .await
        .is_err());
        assert_eq!(
            snapshot(&state, id(&g)).await.unwrap()["memberRoles"],
            roles
        );
        assert!(create(
            State(state.clone()),
            Extension(user()),
            Json(json!({"name":"Invalid","memberIds":["pock",peer],"memberRoles":invalid}))
        )
        .await
        .is_err());
    }
    // Old records receive stable defaults without requiring a manual role migration.
    let mut old = get(&state.db, "groups", id(&g)).await.unwrap();
    old.as_object_mut().unwrap().remove("memberRoles");
    put(&state.db, "groups", id(&g), &old).await.unwrap();
    let upgraded = snapshot(&state, id(&g)).await.unwrap();
    let Json(summaries) = list(State(state.clone())).await.unwrap();
    assert_eq!(upgraded["memberRoles"]["pock"]["role"], "coordinator");
    assert_eq!(
        serde_json::to_value(
            summaries
                .iter()
                .find(|summary| summary.id == id(&g))
                .unwrap()
        )
        .unwrap()["memberRoles"],
        upgraded["memberRoles"]
    );
}

#[tokio::test]
async fn only_the_leader_can_create_assignments_even_when_specialists_are_mentioned() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let root = human(&state, id(&g), "Build", vec![], "root").await;
    let a = context_for(&state, id(&g), "pock", id(&root), None, "message").await;
    let b = context_for(&state, id(&g), &peer, id(&root), None, "message").await;
    let args = json!({"title":"API","instructions":"Build API","expectedResult":"Verified","ownerId":peer});
    let duplicate = json!({"title":"Different title, same work","instructions":"Build API","expectedResult":"Verified","ownerId":peer});
    let (planner, specialist) = tokio::join!(
        execute_tool(&state, &a, "create_group_task", &args, "planner-task", &[]),
        execute_tool(
            &state,
            &b,
            "create_group_task",
            &duplicate,
            "duplicate-task",
            &[]
        )
    );
    assert!(planner.is_ok());
    assert!(specialist.is_err());
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let missing_owner = json!({"title":"UI","instructions":"Build UI","expectedResult":"Verified"});
    assert!(execute_tool(
        &state,
        &a,
        "create_group_task",
        &missing_owner,
        "no-owner",
        &[]
    )
    .await
    .is_err());
    let current = execute_tool(&state, &b, "read_group_context", &json!({}), "context", &[])
        .await
        .unwrap();
    assert_eq!(current["memberRole"]["role"], "developer");
    assert_eq!(current["planningAgentId"], "pock");
    // A targeted specialist can answer, but planning still belongs to the leader.
    let direct = human(&state, id(&g), "Investigate", vec![&peer], "direct").await;
    let c = context_for(&state, id(&g), &peer, id(&direct), None, "message").await;
    assert!(
        execute_tool(&state, &c, "create_group_task", &args, "direct-task", &[])
            .await
            .is_err()
    );
    let current = execute_tool(
        &state,
        &c,
        "read_group_context",
        &json!({}),
        "direct-context",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(current["planningAgentId"], "pock");
    // A peer request cannot create a second planner for the same root.
    assert!(
        execute_tool(&state, &b, "create_group_task", &args, "peer-task", &[])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn reviews_prefer_the_reviewer_role_and_roster_changes_keep_one_coordinator() {
    let (_root, state, peer) = fixture().await;
    let (_, Json(reviewer)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Reviewer"})))
            .await
            .unwrap();
    let (_, Json(group)) = create(
        State(state.clone()),
        Extension(user()),
        Json(json!({"name":"Roles","memberIds":["pock",peer,reviewer["id"]]})),
    )
    .await
    .unwrap();
    let g = serde_json::to_value(group).unwrap();
    let root = human(&state, id(&g), "Build", vec![], "root").await;
    let mut task = create_assignment(
        &state,
        id(&g),
        id(&root),
        &json!({"title":"A","instructions":"Do A","expectedResult":"Verified","ownerId":peer}),
    )
    .await
    .unwrap();
    schedule_review(&state, id(&g), &mut task).await.unwrap();
    assert_eq!(task["reviewerId"], reviewer["id"]);
    let _ = stop(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    let _ = update(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Json(json!({"memberIds":[peer,reviewer["id"]]})),
    )
    .await
    .unwrap();
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(view["memberRoles"][&peer]["role"], "coordinator");
    assert_eq!(view["memberRoles"][id(&reviewer)]["role"], "reviewer");
    assert!(view["memberRoles"].get("pock").is_none());
    assert_eq!(planning_agent(&view, &root), peer);
}

#[tokio::test]
async fn broadcast_mentions_retry_ids_and_human_authorship() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    assert!(g["projectId"].is_null());
    let message = human(&state, id(&g), "Hello", vec![], "same").await;
    human(&state, id(&g), "Hello", vec![], "same").await;
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(view["messages"].as_array().unwrap().len(), 1);
    assert_eq!(view["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(message["recipientIds"], json!(["pock"]));
    assert_eq!(message["senderId"], "admin");
    assert_eq!(message["sequence"], 1);
    human(&state, id(&g), "Only Nova", vec![&peer], "next").await;
    let deliveries = all(&state.db, "group_messages", id(&g)).await.unwrap();
    assert_eq!(deliveries[1]["recipientIds"], json!([peer]));
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["deliveries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(send(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Extension(user()),
        Json(json!({"content":"bad","clientMessageId":"bad","recipientIds":["missing"]}))
    )
    .await
    .is_err());
    let request = get(&state.db, "group_requests", id(&message))
        .await
        .unwrap();
    assert_eq!(request["turnCount"], 0);
}
#[cfg(unix)]
#[tokio::test]
async fn leader_quietly_forwards_greetings_preserving_identity_sender_and_recipients() {
    let (root, state, _) = fixture().await;
    let (_, Json(coral)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Coral"})))
            .await
            .unwrap();
    let (_, Json(alice)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Alice"})))
            .await
            .unwrap();
    let (_, Json(g)) = create(
        State(state.clone()),
        Extension(user()),
        Json(json!({"name":"DiningConnect","memberIds":[id(&coral),id(&alice)]})),
    )
    .await
    .unwrap();
    let g = serde_json::to_value(g).unwrap();
    let first = human(&state, id(&g), "Chào ae", vec![id(&coral)], "hello").await;
    settle(&state, id(&g)).await;
    let second = send(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Extension(user()),
        Json(json!({"content":"FORWARD_TO_ALICE","recipientIds":[id(&coral)],"clientMessageId":"address-alice",
            "attachments":[{"id":"note","name":"note.txt","kind":"file","dataUrl":"data:text/plain;base64,aGVsbG8="}]})),
    )
    .await
    .unwrap()
    .0;
    let view = settle(&state, id(&g)).await;
    assert!(view["tasks"].as_array().unwrap().is_empty());
    assert_eq!(
        state.agents.get(id(&coral)).await.unwrap()["profile"]["name"],
        "Coral"
    );
    assert_eq!(
        state.agents.get(id(&alice)).await.unwrap()["profile"]["name"],
        "Alice"
    );

    let log =
        std::fs::read_to_string(root.path().join("accounts/account/group-rpc-log.jsonl")).unwrap();
    let prompts: Vec<Value> = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|rpc| rpc["method"] == "turn/start")
        .map(|rpc| {
            serde_json::from_str(rpc["params"]["input"][0]["text"].as_str().unwrap()).unwrap()
        })
        .collect();
    assert_eq!(prompts.len(), 3);
    for (prompt, message) in prompts.iter().zip([&first, &second]) {
        assert_eq!(
            prompt["agentIdentity"],
            json!({"agentId":id(&coral),"name":"Coral"})
        );
        let delivered = &prompt["currentGroupMessages"][0];
        assert_eq!(delivered["id"], message["id"]);
        assert_eq!(delivered["senderType"], "user");
        assert_eq!(delivered["senderId"], "admin");
        assert_eq!(delivered["senderName"], "admin");
        assert_eq!(delivered["recipientIds"], json!([id(&coral)]));
        assert_eq!(delivered["content"], message["content"]);
    }
    assert!(
        prompts[1]["conversationHistory"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["senderId"] == id(&coral)
                && message["senderName"] == "Coral"
                && message["senderType"] == "agent")
    );
    let forwarded = &prompts[2];
    assert_eq!(
        forwarded["agentIdentity"],
        json!({"agentId":id(&alice),"name":"Alice"})
    );
    assert_eq!(forwarded["currentUserMessages"][0]["id"], second["id"]);
    assert_eq!(forwarded["currentGroupMessages"][0]["senderId"], "admin");
    assert_eq!(forwarded["currentGroupMessages"][0]["senderName"], "admin");
    assert_eq!(forwarded["attachmentContext"][0]["id"], "note");
    assert_eq!(forwarded["attachmentContext"][0]["text"], "hello");
    assert_eq!(
        forwarded["currentGroupMessages"][0]["content"],
        "FORWARD_TO_ALICE"
    );
    assert_eq!(
        forwarded["currentGroupMessages"][0]["recipientIds"],
        json!([id(&coral)])
    );
    assert_eq!(
        forwarded["groupContext"]["currentDelivery"]["agentId"],
        id(&alice)
    );
    assert_eq!(
        forwarded["groupContext"]["currentDelivery"]["event"],
        json!({"type":"forwarded_message","forwardedBy":id(&coral)})
    );
    let replies: Vec<_> = view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["rootId"] == second["id"] && message["senderType"] == "agent")
        .collect();
    assert_eq!(
        replies.len(),
        1,
        "Only Alice should reply after Coral forwards the greeting"
    );
    assert_eq!(replies[0]["senderId"], id(&alice));
    assert_eq!(replies[0]["inReplyTo"], second["id"]);
    assert_eq!(
        replies[0]["recipientIds"],
        json!([]),
        "Alice's reply must not wake Coral again"
    );
    assert_eq!(
        get(&state.db, "group_messages", id(&second)).await.unwrap(),
        second
    );
    assert!(
        view["receipts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|receipt| receipt["tool"] == "forward_group_message"
                && receipt["status"] == "completed")
    );
}

#[test]
fn greeting_routing_requires_one_named_peer_and_preserves_possible_nicknames() {
    let mut view = json!({"members":[
        {"id":"coral","profile":{"name":"Coral"}},
        {"id":"alice","profile":{"name":"Alice"}}
    ],"messages":[]});
    let mut message = json!({"id":"current","senderType":"user","recipientIds":["coral"]});
    for greeting in [
        "hello alice",
        "Hello Alice!",
        "HELLO, @ALICE",
        "Chào Alice",
        "Xin chào Alice.",
        "hi: alice",
    ] {
        message["content"] = json!(greeting);
        assert_eq!(
            greeting_recipient(&view, &message, "coral"),
            Some("alice".into()),
            "{greeting}"
        );
    }
    for content in [
        "hello coral",
        "hello Coco",
        "Alice joined the group",
        "say hello Alice",
        "hello Alice and Coral",
        "hello Alice, how are you?",
        "hialice",
        "\"hello Alice\"",
    ] {
        message["content"] = json!(content);
        assert_eq!(
            greeting_recipient(&view, &message, "coral"),
            None,
            "{content}"
        );
    }
    message["content"] = json!("hello alice");
    message["senderType"] = json!("agent");
    assert_eq!(greeting_recipient(&view, &message, "coral"), None);
    message["senderType"] = json!("user");
    for nickname in [
        "I'll call you Alice",
        "Your nickname is Alice",
        "Từ giờ anh sẽ gọi em là Alice",
    ] {
        view["messages"] = json!([{"id":"nickname","senderType":"user","recipientIds":["coral"],"content":nickname},message]);
        assert_eq!(
            greeting_recipient(&view, &message, "coral"),
            None,
            "{nickname}"
        );
    }
    view["messages"] = json!([{"id":"earlier","senderType":"user","recipientIds":["coral"],"content":"Alice joined the group"},message]);
    assert_eq!(
        greeting_recipient(&view, &message, "coral"),
        Some("alice".into())
    );
    view["members"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"other-alice","profile":{"name":"ALICE"}}));
    assert_eq!(greeting_recipient(&view, &message, "coral"), None);
}

#[cfg(unix)]
#[tokio::test]
async fn greeting_routing_bypasses_a_leader_model_that_refuses_to_forward() {
    let (root, state, _) = fixture().await;
    let (_, Json(coral)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Coral"})))
            .await
            .unwrap();
    let (_, Json(alice)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Alice"})))
            .await
            .unwrap();
    let (_, Json(g)) = create(
        State(state.clone()),
        Extension(user()),
        Json(json!({"name":"DiningConnect","memberIds":[id(&coral),id(&alice)]})),
    )
    .await
    .unwrap();
    let g = serde_json::to_value(g).unwrap();
    for (index, greeting) in ["hello alice", "hello alice", "Chào Alice"]
        .into_iter()
        .enumerate()
    {
        let source = human(
            &state,
            id(&g),
            greeting,
            vec![id(&coral)],
            &format!("greeting-{index}"),
        )
        .await;
        let view = settle(&state, id(&g)).await;
        let replies: Vec<_> = view["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["rootId"] == source["id"] && message["senderType"] == "agent")
            .collect();
        assert_eq!(
            replies.len(),
            1,
            "Only the intended agent should reply to {greeting}"
        );
        assert_eq!(replies[0]["senderId"], id(&alice));
        assert_eq!(replies[0]["inReplyTo"], source["id"]);
        assert_eq!(replies[0]["recipientIds"], json!([]));
        assert!(view["tasks"].as_array().unwrap().is_empty());
        assert_eq!(
            get(&state.db, "group_messages", id(&source)).await.unwrap(),
            source
        );
    }
    let log =
        std::fs::read_to_string(root.path().join("accounts/account/group-rpc-log.jsonl")).unwrap();
    let starts: Vec<Value> = log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|rpc| rpc["method"] == "turn/start")
        .map(|rpc| {
            serde_json::from_str(rpc["params"]["input"][0]["text"].as_str().unwrap()).unwrap()
        })
        .collect();
    assert_eq!(starts.len(), 3);
    for prompt in starts {
        assert_eq!(
            prompt["agentIdentity"]["agentId"],
            id(&alice),
            "The leader model must never run for these greetings"
        );
        assert_eq!(prompt["currentGroupMessages"][0]["senderId"], "admin");
        assert_eq!(
            prompt["groupContext"]["currentDelivery"]["event"],
            json!({"type":"forwarded_message","forwardedBy":id(&coral)})
        );
    }
}

#[tokio::test]
async fn forwarding_requires_current_human_source_and_leader_and_deduplicates_delivery() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let old = human(&state, id(&g), "Earlier", vec![], "earlier").await;
    let long_client_id = "x".repeat(200);
    let source = human(&state, id(&g), "Chào Nova", vec![], &long_client_id).await;
    assert!(id(&source).len() > 200);
    let leader = context_for(&state, id(&g), "pock", id(&source), None, "message").await;
    let specialist = context_for(&state, id(&g), &peer, id(&source), None, "message").await;
    let valid = json!({"sourceMessageId":source["id"],"recipientIds":[peer]});
    assert!(
        execute_tool(
            &state,
            &specialist,
            "forward_group_message",
            &valid,
            "peer",
            &[source.clone()]
        )
        .await
        .is_err()
    );
    assert!(
        execute_tool(
            &state,
            &leader,
            "forward_group_message",
            &valid,
            "no-source",
            &[]
        )
        .await
        .is_err()
    );
    let peer_message = json!({"id":source["id"],"senderType":"agent"});
    assert!(
        execute_tool(
            &state,
            &leader,
            "forward_group_message",
            &valid,
            "peer-source",
            &[peer_message]
        )
        .await
        .is_err()
    );
    let mut execution = leader.clone();
    execution.purpose = "execute".into();
    assert!(
        execute_tool(
            &state,
            &execution,
            "forward_group_message",
            &valid,
            "assignment",
            &[source.clone()]
        )
        .await
        .is_err()
    );
    let before = snapshot(&state, id(&g)).await.unwrap();
    for args in [
        json!({"sourceMessageId":old["id"],"recipientIds":[peer]}),
        json!({"sourceMessageId":source["id"],"recipientIds":[]}),
        json!({"sourceMessageId":source["id"],"recipientIds":["pock"]}),
        json!({"sourceMessageId":source["id"],"recipientIds":[peer,"outside-group"]}),
        json!({"sourceMessageId":source["id"],"recipientIds":[peer,peer]}),
    ] {
        assert!(
            execute_tool(
                &state,
                &leader,
                "forward_group_message",
                &args,
                "invalid",
                &[source.clone()]
            )
            .await
            .is_err()
        );
    }
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["deliveries"],
        before["deliveries"]
    );
    let first = execute_tool(
        &state,
        &leader,
        "forward_group_message",
        &valid,
        "forward",
        &[source.clone()],
    )
    .await
    .unwrap();
    let second = execute_tool(
        &state,
        &leader,
        "forward_group_message",
        &valid,
        "retry",
        &[source.clone()],
    )
    .await
    .unwrap();
    assert_eq!(first, second);
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(
        view["messages"], before["messages"],
        "Routing posts no additional bubble"
    );
    let deliveries: Vec<_> = view["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["rootId"] == source["id"])
        .collect();
    assert_eq!(deliveries.len(), 2);
    let delivery = deliveries.iter().find(|d| d["agentId"] == peer).unwrap();
    assert_eq!(delivery["messageId"], source["id"]);
    assert_eq!(
        delivery["event"],
        json!({"type":"forwarded_message","forwardedBy":"pock"})
    );
    assert!(view["tasks"].as_array().unwrap().is_empty());
    let _ = stop(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    assert!(
        execute_tool(
            &state,
            &leader,
            "forward_group_message",
            &valid,
            "stopped",
            &[source]
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn ordinary_replies_are_shared_without_fanout_and_operations_are_durable() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let root = human(&state, id(&g), "Hello", vec!["pock"], "root").await;
    let c = context_for(&state, id(&g), "pock", id(&root), None, "message").await;
    let args = json!({"content":"Visible to all"});
    let a = execute_tool(&state, &c, "send_group_message", &args, "call", &[])
        .await
        .unwrap();
    let b = execute_tool(&state, &c, "send_group_message", &args, "call", &[])
        .await
        .unwrap();
    assert_eq!(a, b);
    let new_context = context_for(&state, id(&g), "pock", id(&root), None, "message").await;
    let duplicate = execute_tool(
        &state,
        &new_context,
        "send_group_message",
        &args,
        "other-call",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(a, duplicate);
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["deliveries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    execute_tool(
        &state,
        &c,
        "request_group_peers",
        &json!({"content":"Review approach","recipientIds":[peer]}),
        "peer",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["deliveries"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(state.agents.get("pock").await.unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(execute_tool(
        &state,
        &c,
        "send_group_message",
        &json!({"content":"Spoof","senderId":peer}),
        "spoof",
        &[]
    )
    .await
    .is_err());
}
#[tokio::test]
async fn simultaneous_claims_produce_one_owner_and_duplicate_proposals_reuse_task() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let root = human(&state, id(&g), "Build", vec![], "root").await;
    let input = json!({"title":"Implement","instructions":"Work","expectedResult":"Verified"});
    let task = create_assignment(&state, id(&g), id(&root), &input)
        .await
        .unwrap();
    assert_eq!(
        task,
        create_assignment(&state, id(&g), id(&root), &input)
            .await
            .unwrap()
    );
    let a = context_for(&state, id(&g), "pock", id(&root), None, "message").await;
    let b = context_for(&state, id(&g), &peer, id(&root), None, "message").await;
    let args = json!({"taskId":task["id"]});
    let (first, second) = tokio::join!(
        execute_tool(&state, &a, "claim_group_task", &args, "claim-a", &[]),
        execute_tool(&state, &b, "claim_group_task", &args, "claim-b", &[])
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let saved = checked_task(&state, id(&g), id(&task)).await.unwrap();
    assert!(saved["ownerId"] == "pock" || saved["ownerId"] == peer);
}
#[tokio::test]
async fn mandatory_review_rejects_self_approval_and_changed_files_then_releases_dependency() {
    let (root, state, peer) = fixture().await;
    let g = group(&state, &peer, true).await;
    let source = human(&state, id(&g), "Build", vec![], "root").await;
    let mut task=create_assignment(&state,id(&g),id(&source),&json!({"title":"A","instructions":"Edit","expectedResult":"Good","ownerId":"pock","fileResponsibilities":["a.txt"]})).await.unwrap();
    let dependent=create_assignment(&state,id(&g),id(&source),&json!({"title":"B","instructions":"Next","expectedResult":"Good","ownerId":peer,"dependencyIds":[task["id"]]})).await.unwrap();
    std::fs::write(root.path().join("repo/a.txt"), "first").unwrap();
    task["status"] = json!("running");
    put(&state.db, "group_tasks", id(&g), &task).await.unwrap();
    let c = context_for(&state, id(&g), "pock", id(&source), Some(&task), "execute").await;
    submit(
        &state,
        &c,
        &json!({"result":"Done","verification":"Checked"}),
    )
    .await
    .unwrap();
    let awaiting = checked_task(&state, id(&g), id(&task)).await.unwrap();
    assert_eq!(awaiting["status"], "awaiting_review");
    assert_eq!(awaiting["reviewerId"], peer);
    assert!(review_task(
        &state,
        id(&g),
        id(&task),
        "pock",
        &json!({"revision":awaiting["revision"],"decision":"approve","evidence":"No"})
    )
    .await
    .is_err());
    std::fs::write(root.path().join("repo/a.txt"), "changed by another task").unwrap();
    assert!(review_task(
        &state,
        id(&g),
        id(&task),
        &peer,
        &json!({"revision":awaiting["revision"],"decision":"approve","evidence":"Stale"})
    )
    .await
    .is_err());
    let current = checked_task(&state, id(&g), id(&task)).await.unwrap();
    assert!(current["revision"].as_i64().unwrap() > awaiting["revision"].as_i64().unwrap());
    let approved=review_task(&state,id(&g),id(&task),&peer,&json!({"revision":current["revision"],"decision":"approve","evidence":"Verified new contents"})).await.unwrap();
    assert_eq!(approved["status"], "completed");
    assert_eq!(
        checked_task(&state, id(&g), id(&dependent)).await.unwrap()["status"],
        "queued"
    );
    assert_eq!(
        all(&state.db, "group_reviews", id(&g)).await.unwrap().len(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("repo/baseline.txt")).unwrap(),
        "private-only existing user changes"
    );
}
#[tokio::test]
async fn cyclic_dependencies_cross_group_tasks_and_unsafe_paths_are_rejected() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Build", vec![], "root").await;
    let a = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do A","expectedResult":"A"}),
    )
    .await
    .unwrap();
    let b = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"B","instructions":"Do B","expectedResult":"B","dependencyIds":[a["id"]]}),
    )
    .await
    .unwrap();
    let _ = stop(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    assert!(patch_task(
        State(state.clone()),
        AxumPath((id(&g).into(), id(&a).into())),
        Json(json!({"dependencyIds":[b["id"]]}))
    )
    .await
    .is_err());
    let other = group(&state, &peer, false).await;
    assert!(checked_task(&state, id(&other), id(&a)).await.is_err());
    assert!(create_assignment(&state,id(&g),id(&source),&json!({"title":"Unsafe","instructions":"Do","expectedResult":"Good","fileResponsibilities":["../secret"]})).await.is_err());
}
#[tokio::test]
async fn restart_preserves_pending_work_but_requires_explicit_resume() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Build", vec![], "root").await;
    let mut task = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do","expectedResult":"Good","ownerId":"pock"}),
    )
    .await
    .unwrap();
    task["status"] = json!("running");
    put(&state.db, "group_tasks", id(&g), &task).await.unwrap();
    put(
        &state.db,
        "group_executions",
        id(&g),
        &json!({
            "id":"waiting-child", "groupId":g["id"], "agentId":"pock",
            "taskId":task["id"], "rootId":source["id"], "status":"waiting",
            "childRunId":"interrupted-child"
        }),
    )
    .await
    .unwrap();
    migrate(&state.db).await.unwrap();
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(view["stopped"], true);
    assert_eq!(view["stopReason"], "restart");
    assert_eq!(view["tasks"][0]["status"], "interrupted");
    assert_eq!(view["executions"][0]["status"], "interrupted");
    assert_eq!(view["executions"][0]["childRunId"], "interrupted-child");
    assert!(!pending(&state, "pock").await.unwrap());
    let _ = resume(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert_eq!(view["stopped"], false);
    assert_eq!(view["tasks"][0]["status"], "queued");
    assert_eq!(
        view["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["taskId"] == task["id"])
            .count(),
        1
    );
}
#[tokio::test]
async fn editing_roster_requires_stopped_group_and_preserves_unfinished_owners() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    assert!(update(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Json(json!({"name":"Changed"}))
    )
    .await
    .is_err());
    let source = human(&state, id(&g), "Work", vec![], "root").await;
    create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do","expectedResult":"Good","ownerId":peer}),
    )
    .await
    .unwrap();
    let (_, Json(extra)) =
        agents::create_agent(State(state.clone()), Json(json!({"name":"Extra"})))
            .await
            .unwrap();
    let _ = stop(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    assert!(update(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Json(json!({"memberIds":["pock",extra["id"]]}))
    )
    .await
    .is_err());
    let _ = update(
        State(state.clone()),
        AxumPath(id(&g).into()),
        Json(json!({"name":"Renamed"})),
    )
    .await
    .unwrap();
    assert_eq!(snapshot(&state, id(&g)).await.unwrap()["name"], "Renamed");
}

#[cfg(unix)]
#[tokio::test]
async fn two_peers_exchange_requests_execute_in_shared_checkout_and_review_each_other() {
    let (root, state, peer) = fixture().await;
    let g = group(&state, &peer, true).await;
    human(&state, id(&g), "WORK", vec![], "root").await;
    let view = settle(&state, id(&g)).await;
    assert_eq!(view["tasks"].as_array().unwrap().len(), 2);
    for task in view["tasks"].as_array().unwrap() {
        assert_eq!(task["status"], "completed");
        assert_ne!(task["ownerId"], task["reviewerId"]);
        assert_eq!(task["workingDirectory"], g["workingDirectory"]);
    }
    assert!(
        view["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["kind"] == "request"),
        "messages={} receipts={}",
        view["messages"],
        view["receipts"]
    );
    assert!(view["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["tool"] == "fileChange" && r["status"] == "completed"));
    assert!(view["reviews"].as_array().unwrap().len() >= 2);
    assert!(root.path().join("repo/pock.txt").exists());
    assert!(root
        .path()
        .join("repo")
        .join(format!("{peer}.txt"))
        .exists());
    assert_eq!(
        std::fs::read_to_string(root.path().join("repo/baseline.txt")).unwrap(),
        "private-only existing user changes"
    );
    assert!(state.agents.get("pock").await.unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(state.agents.get("pock").await.unwrap()["status"], "idle");

    let log =
        std::fs::read_to_string(root.path().join("accounts/account/group-rpc-log.jsonl")).unwrap();
    let mut saw_peer_delivery = false;
    for rpc in log
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
    {
        if rpc["method"] != "turn/start" {
            continue;
        }
        let prompt: Value =
            serde_json::from_str(rpc["params"]["input"][0]["text"].as_str().unwrap()).unwrap();
        let context = &prompt["groupContext"];
        if context["execution"]["purpose"] != "message" {
            assert_eq!(prompt["currentUserMessages"], json!([]));
            continue;
        }
        if context["currentDelivery"]["event"]["type"] == "task_update" {
            assert_eq!(prompt["currentUserMessages"], json!([]));
            assert_eq!(context["execution"]["agentId"], context["leaderId"]);
            continue;
        }
        let delivered = view["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["id"] == context["currentDelivery"]["messageId"])
            .unwrap();
        let current = &prompt["currentGroupMessages"][0];
        for field in [
            "id",
            "content",
            "senderType",
            "senderId",
            "senderName",
            "recipientIds",
            "kind",
        ] {
            assert_eq!(current[field], delivered[field], "delivery lost {field}");
        }
        if delivered["senderType"] == "agent" {
            saw_peer_delivery = true;
            assert_eq!(prompt["currentUserMessages"], json!([]));
        } else {
            assert_eq!(prompt["currentUserMessages"][0]["id"], delivered["id"]);
        }
    }
    assert!(
        saw_peer_delivery,
        "the fixture must exercise a peer request"
    );
    assert!(view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["senderId"] == "pock"
            && message["content"] == "Team result: verified assignments completed"));
}
#[cfg(unix)]
#[tokio::test]
async fn child_coding_runs_wake_group_owners_without_direct_followups() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, true).await;
    human(&state, id(&g), "CHILD", vec![], "root").await;
    let view = settle(&state, id(&g)).await;
    assert!(view["executions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["outcome"]["messages"][0] == "Child verification passed"));
    assert!(view["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["tool"] == "create_chat" && !r["chatId"].is_null()));
    assert!(state.agents.get("pock").await.unwrap()["followUps"]
        .as_array()
        .unwrap()
        .is_empty());
    let chats = providers::documents(&state.db, "provider-chats")
        .await
        .unwrap();
    assert!(chats.iter().all(|c| c["groupId"] == g["id"]));
}
#[cfg(unix)]
#[tokio::test]
async fn stop_interrupts_only_its_group_and_cleans_native_terminals() {
    let (root, state, peer) = fixture().await;
    let a = group(&state, &peer, false).await;
    let b = group(&state, &peer, false).await;
    human(&state, id(&a), "HOLD", vec!["pock"], "a").await;
    human(&state, id(&b), "HOLD", vec![&peer], "b").await;
    tick(&state).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if std::fs::read_to_string(root.path().join("accounts/account/group-rpc-log.jsonl"))
                .unwrap_or_default()
                .contains("turn/start")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let _ = stop(State(state.clone()), AxumPath(id(&a).into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while agent_active(&state, "pock").await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        get(&state.db, "groups", id(&b)).await.unwrap()["stopped"],
        false
    );
    assert!(agent_active(&state, &peer).await);
    let log =
        std::fs::read_to_string(root.path().join("accounts/account/group-rpc-log.jsonl")).unwrap();
    assert!(log.contains("turn/interrupt"));
    assert!(log.contains("thread/backgroundTerminals/clean"));
    let _ = stop(State(state.clone()), AxumPath(id(&b).into()))
        .await
        .unwrap();
}

#[tokio::test]
async fn deletion_removes_owned_records_and_usage_but_preserves_other_groups_and_files() {
    let (root, state, peer) = fixture().await;
    let a = group(&state, &peer, true).await;
    let b = group(&state, &peer, false).await;
    human(&state,id(&a),"Saved message",vec![],"a").await;
    human(&state,id(&b),"Keep this",vec![],"b").await;
    for table in ["group_tasks","group_reviews","group_executions","group_receipts","group_operations"] {
        put(&state.db,table,id(&a),&json!({"id":format!("a-{table}"),"groupId":id(&a),"status":"completed"})).await.unwrap();
    }
    agent_usage::record_scoped(&state.db,"pock","usage-a",&json!({"tokenUsage":{"total":{"totalTokens":100}}}),Some(id(&a)),true).await.unwrap();
    let mut events = state.live.subscribe();
    let Json(deleted) = delete(State(state.clone()),AxumPath(id(&a).into())).await.unwrap();
    assert_eq!(deleted["deleted"],true);
    for table in ["groups","group_messages","group_tasks","group_reviews","group_executions","group_receipts","group_operations","group_requests","group_members","group_deliveries","group_usage_buckets"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE group_id=?")).bind(id(&a)).fetch_one(&state.db.pool).await.unwrap();
        assert_eq!(count,0,"{table} leaked deleted records");
    }
    assert_eq!(snapshot(&state,id(&b)).await.unwrap()["messages"][0]["content"],"Keep this");
    assert!(state.agents.get("pock").await.is_ok());
    assert!(root.path().join("repo/baseline.txt").exists());
    assert!(matches!(delete(State(state.clone()),AxumPath(id(&a).into())).await,Err(AppError::NotFound(_))));
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|e| e.topic == "group.deleted"));
    assert!(agent_usage::read_group_usage(State(state.clone()),AxumPath(id(&a).into()),Query(agent_usage::UsageQuery{days:Some(7)})).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn deletion_interrupts_running_turns_without_stopping_another_group() {
    let (root,state,peer) = fixture().await;
    let a = group(&state,&peer,false).await;
    let b = group(&state,&peer,false).await;
    human(&state,id(&a),"HOLD",vec!["pock"],"a").await;
    human(&state,id(&b),"HOLD",vec![&peer],"b").await;
    tick(&state).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3),async {
        while !std::fs::read_to_string(root.path().join("accounts/account/group-rpc-log.jsonl")).unwrap_or_default().contains("turn/start") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let _ = delete(State(state.clone()),AxumPath(id(&a).into())).await.unwrap();
    assert!(!agent_active(&state,"pock").await);
    assert!(agent_active(&state,&peer).await);
    assert_eq!(get(&state.db,"groups",id(&b)).await.unwrap()["stopped"],false);
    tick(&state).await.unwrap();
    assert!(get(&state.db,"groups",id(&a)).await.is_err());
    assert!(all(&state.db,"group_executions",id(&a)).await.unwrap().is_empty());
    let _ = stop(State(state.clone()),AxumPath(id(&b).into())).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn group_usage_tracks_native_agent_and_child_streams_with_cached_tokens() {
    let (_root,state,peer) = fixture().await;
    let g = group(&state,&peer,true).await;
    human(&state,id(&g),"CHILD",vec![],"root").await;
    settle(&state,id(&g)).await;
    let Json(usage) = agent_usage::read_group_usage(State(state.clone()),AxumPath(id(&g).into()),Query(agent_usage::UsageQuery{days:Some(7)})).await.unwrap();
    assert!(usage["trackedSince"].is_string());
    assert_eq!(usage["series"].as_array().unwrap().len(),2);
    let mut total = 0;
    for series in usage["series"].as_array().unwrap() {
        for bucket in series["buckets"].as_array().unwrap() {
            let tokens = bucket["tokens"].as_i64().unwrap();
            assert_eq!(tokens,bucket["inputTokens"].as_i64().unwrap()+bucket["outputTokens"].as_i64().unwrap());
            assert!(bucket["cachedTokens"].as_i64().unwrap()>0);
            assert_eq!(bucket["detailedTokens"],bucket["tokens"]);
            total += tokens;
        }
    }
    let agent_total: i64 = sqlx::query_scalar("SELECT SUM(tokens) FROM agent_usage_buckets").fetch_one(&state.db.pool).await.unwrap();
    // Two child coding runs of 250 tokens each are included only in group usage.
    assert_eq!(total,agent_total+500);
    let chats = providers::documents(&state.db,"provider-chats").await.unwrap();
    assert_eq!(chats.len(),2);
    let _ = delete(State(state.clone()),AxumPath(id(&g).into())).await.unwrap();
    for chat in chats {
        let kept = document(&state.db,"provider-chats",id(&chat)).await.unwrap();
        for key in ["groupId","groupTaskId","groupRootId","groupAgentId"] {
            assert!(kept[key].is_null(),"{key} still refers to a deleted group");
        }
        assert_eq!(kept["dispatchPaused"],true);
    }
}
#[tokio::test]
async fn exchange_limit_preserves_deliveries_and_continue_resets_budget() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Hello", vec![], "root").await;
    let mut request = get(&state.db, "group_requests", id(&source)).await.unwrap();
    request["turnCount"] = json!(32);
    put(&state.db, "group_requests", id(&g), &request)
        .await
        .unwrap();
    tick(&state).await.unwrap();
    assert_eq!(
        get(&state.db, "group_requests", id(&source)).await.unwrap()["limited"],
        true
    );
    assert!(state.groups.active.lock().await.is_empty());
    assert_eq!(
        snapshot(&state, id(&g)).await.unwrap()["deliveries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let _ = resume(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap();
    let continued = get(&state.db, "group_requests", id(&source)).await.unwrap();
    assert_eq!(continued["limited"], false);
    assert_eq!(continued["turnCount"], 0);
}

#[tokio::test]
async fn final_completion_rechecks_approved_snapshots_after_parallel_changes() {
    let (root, state, peer) = fixture().await;
    let g = group(&state, &peer, true).await;
    let source = human(&state, id(&g), "Build", vec![], "root").await;
    let mut task=create_assignment(&state,id(&g),id(&source),&json!({"title":"A","instructions":"Edit","expectedResult":"Good","ownerId":"pock","fileResponsibilities":["a.txt"]})).await.unwrap();
    std::fs::write(root.path().join("repo/a.txt"), "reviewed").unwrap();
    task["status"] = json!("completed");
    task["reviewerId"] = json!(peer);
    task["fingerprints"] = fingerprints(&task).await.unwrap();
    put(&state.db, "group_tasks", id(&g), &task).await.unwrap();
    sqlx::query("UPDATE group_deliveries SET status='handled',data=json_set(data,'$.status','handled') WHERE group_id=?").bind(id(&g)).execute(&state.db.pool).await.unwrap();
    std::fs::write(root.path().join("repo/a.txt"), "changed after approval").unwrap();
    check_completion(&state).await.unwrap();
    assert_eq!(
        checked_task(&state, id(&g), id(&task)).await.unwrap()["status"],
        "awaiting_review"
    );
    assert_eq!(
        get(&state.db, "group_requests", id(&source)).await.unwrap()["completed"],
        false
    );
}
#[cfg(unix)]
#[tokio::test]
async fn four_slot_limit_and_global_agent_lease_are_enforced() {
    let (_root, state, peer) = fixture().await;
    let mut roster = vec!["pock".to_owned(), peer];
    for n in 0..4 {
        let (_, Json(agent)) = agents::create_agent(
            State(state.clone()),
            Json(json!({"name":format!("Peer {n}")})),
        )
        .await
        .unwrap();
        roster.push(string(&agent, "id"));
    }
    let (_, Json(group)) = create(
        State(state.clone()),
        Extension(user()),
        Json(json!({"name":"Many peers","memberIds":roster})),
    )
    .await
    .unwrap();
    let roster = members(&state.db, &group.summary.id).await.unwrap();
    human(
        &state,
        &group.summary.id,
        "HOLD",
        roster.iter().map(String::as_str).collect(),
        "root",
    )
    .await;
    tick(&state).await.unwrap();
    assert_eq!(state.groups.active.lock().await.len(), 4);
    assert_eq!(
        snapshot(&state, &group.summary.id).await.unwrap()["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["status"] == "queued")
            .count(),
        2
    );
    assert!(state.agents.reserve_group("pock").await.unwrap().is_none());
    let _ = stop(State(state.clone()), AxumPath(group.summary.id))
        .await
        .unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn http_authentication_two_agent_execution_and_explicit_restart_recovery() {
    let (_root, state, peer) = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = router(state.clone(), Path::new("web/dist"), None, false, vec![]);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::new();
    let base = format!("http://{address}/api/v1/groups");
    assert_eq!(
        client.get(&base).send().await.unwrap().status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let (token, _) = create_session(&state.db, state.db.user("admin").await.unwrap())
        .await
        .unwrap();
    let created: Value = client
        .post(&base)
        .bearer_auth(&token)
        .json(&json!({"name":"HTTP team","memberIds":["pock",peer],"projectId":"project"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!("{base}/{}", id(&created));
    let message: Value = client
        .post(format!("{url}/messages"))
        .bearer_auth(&token)
        .json(&json!({"content":"WORK","clientMessageId":"http-request","recipientIds":[]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(message["senderId"], "admin");
    let settled = settle(&state, id(&created)).await;
    assert_eq!(settled["tasks"].as_array().unwrap().len(), 2);
    let response: Value = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(response["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|task| task["status"] == "completed"));
    assert_eq!(
        client
            .post(format!("{url}/tasks/{}/reviews", id(&settled["tasks"][0])))
            .bearer_auth(&token)
            .json(&json!({"decision":"approve","reviewerId":"pock"}))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::CONFLICT
    );
    let stopped = client
        .post(format!("{url}/stop"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(stopped.json::<Value>().await.unwrap()["stopped"], true);
    client
        .post(format!("{url}/messages"))
        .bearer_auth(&token)
        .json(&json!({"content":"Later","clientMessageId":"queued"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    // Re-run startup migration, as the server does when reopening its database.
    migrate(&state.db).await.unwrap();
    let recovered: Value = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(recovered["stopped"], true);
    assert_eq!(recovered["stopReason"], "restart");
    tick(&state).await.unwrap();
    assert!(state.groups.active.lock().await.is_empty());
    let resumed: Value = client
        .post(format!("{url}/resume"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resumed["stopped"], false);
    server.abort();
}

#[tokio::test]
async fn blocked_task_retry_can_complete_without_old_failed_delivery_blocking_root() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Build", vec![], "root").await;
    let mut task = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do","expectedResult":"Good","ownerId":"pock"}),
    )
    .await
    .unwrap();
    task["status"] = json!("running");
    put(&state.db, "group_tasks", id(&g), &task).await.unwrap();
    let owner = context_for(&state, id(&g), "pock", id(&source), Some(&task), "execute").await;
    let other = context_for(&state, id(&g), &peer, id(&source), Some(&task), "execute").await;
    assert!(block_task(
        &state,
        &other,
        &json!({"reason":"Cannot impersonate owner"})
    )
    .await
    .is_err());
    let blocked = execute_tool(
        &state,
        &owner,
        "block_group_task",
        &json!({"reason":"Missing credential"}),
        "block",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(blocked["status"], "blocked");
    sqlx::query("UPDATE group_deliveries SET status=CASE WHEN json_extract(data,'$.taskId') IS NULL THEN 'handled' ELSE 'failed' END,data=json_set(data,'$.status',CASE WHEN json_extract(data,'$.taskId') IS NULL THEN 'handled' ELSE 'failed' END) WHERE group_id=?")
        .bind(id(&g)).execute(&state.db.pool).await.unwrap();
    let retried = retry_task(
        State(state.clone()),
        AxumPath((id(&g).into(), id(&task).into())),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(retried["status"], "queued");
    task = retried;
    task["status"] = json!("running");
    put(&state.db, "group_tasks", id(&g), &task).await.unwrap();
    let submitted = submit(
        &state,
        &owner,
        &json!({"result":"Recovered","verification":"Verified"}),
    )
    .await
    .unwrap();
    review_task(&state, id(&g), id(&task), &peer, &json!({"revision":submitted["revision"],"decision":"approve","evidence":"Checked recovered result"})).await.unwrap();
    sqlx::query("UPDATE group_deliveries SET status='handled',data=json_set(data,'$.status','handled') WHERE group_id=? AND status='queued'")
        .bind(id(&g)).execute(&state.db.pool).await.unwrap();
    check_completion(&state).await.unwrap();
    assert_eq!(
        get(&state.db, "group_requests", id(&source)).await.unwrap()["completed"],
        true
    );
}

#[tokio::test]
async fn resume_repairs_assignment_dispatch_lost_between_state_and_enqueue() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Build", vec![], "root").await;
    let task = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do","expectedResult":"Good","ownerId":"pock"}),
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM group_deliveries WHERE json_extract(data,'$.taskId')=?")
        .bind(id(&task))
        .execute(&state.db.pool)
        .await
        .unwrap();
    migrate(&state.db).await.unwrap();
    let view = resume(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap()
        .0;
    assert_eq!(view["tasks"][0]["recovery"], true);
    assert_eq!(
        view["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["taskId"] == task["id"])
            .count(),
        1
    );
    let again = resume(State(state.clone()), AxumPath(id(&g).into()))
        .await
        .unwrap()
        .0;
    assert_eq!(
        again["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["taskId"] == task["id"])
            .count(),
        1
    );
}

/// Interactive UI smoke test backed by the same deterministic native transport.
/// Visit the printed URL, sign in as admin / group-fixture-password, and create
/// a project group with Pock and Nova. WORK exercises parallel tasks and reviews.
/// A human-created owned task with instructions HOLD can be stopped and recovered.
/// Write "restart" to the printed control path to reopen the HTTP server and agent
/// state, or "exit" to finish. This never uses the developer's production database.
#[cfg(unix)]
#[tokio::test]
#[ignore = "interactive browser smoke test; stops after 15 minutes or an exit control"]
async fn manual_group_ui_server() {
    let (root, mut state, _) = fixture().await;
    sqlx::query("UPDATE users SET password_hash=? WHERE id='admin'")
        .bind(hash_password("group-fixture-password").unwrap())
        .execute(&state.db.pool)
        .await
        .unwrap();
    let control = root.path().join("control");
    let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut pending_listener = Some(listener);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    println!(
        "GROUP_UI_URL=http://{address}\nGROUP_UI_CONTROL={}",
        control.display()
    );
    loop {
        let listener = match pending_listener.take() {
            Some(listener) => listener,
            None => tokio::net::TcpListener::bind(address).await.unwrap(),
        };
        let app = router(state.clone(), &web, None, true, vec![]);
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let scheduler_state = state.clone();
        let scheduler = tokio::spawn(async move {
            loop {
                tick(&scheduler_state).await.unwrap();
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        });
        let command = loop {
            if tokio::time::Instant::now() >= deadline {
                break "exit".to_owned();
            }
            if let Ok(command) = std::fs::read_to_string(&control) {
                std::fs::remove_file(&control).unwrap();
                break command.trim().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        };
        let group_ids: Vec<String> = sqlx::query_scalar("SELECT id FROM groups")
            .fetch_all(&state.db.pool)
            .await
            .unwrap();
        for group_id in group_ids {
            let _ = stop(State(state.clone()), AxumPath(group_id))
                .await
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !state.groups.active.lock().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        scheduler.abort();
        server.abort();
        let _ = server.await;
        if command == "exit" {
            break;
        }
        migrate(&state.db).await.unwrap();
        state.agents = agents::AgentManager::load(&state.db).await.unwrap();
        state.groups = GroupManager::default();
        println!("GROUP_UI_RESTARTED");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn projectless_execution_and_review_share_the_owners_runtime_and_file_snapshots() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    human(&state, id(&g), "WORK", vec![], "projectless").await;
    let view = settle(&state, id(&g)).await;
    for task in view["tasks"].as_array().unwrap() {
        let directory = Path::new(task["workingDirectory"].as_str().unwrap());
        assert!(directory.ends_with(Path::new("assistant-runtime").join(string(task, "ownerId"))));
        let filename = format!("{}.txt", string(task, "ownerId"));
        assert_eq!(
            std::fs::read_to_string(directory.join(&filename)).unwrap(),
            format!("Verified {}", string(task, "ownerId"))
        );
        assert!(task["fingerprints"].get(&filename).is_some());
        assert_ne!(task["reviewerId"], task["ownerId"]);
        let review = view["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["taskId"] == task["id"])
            .unwrap();
        assert_eq!(review["fingerprints"], task["fingerprints"]);
    }
}

#[tokio::test]
async fn requested_changes_return_to_owner_and_task_cancellation_requires_retry() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "Build", vec![], "root").await;
    let mut task = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do","expectedResult":"Good","ownerId":"pock"}),
    )
    .await
    .unwrap();
    task["status"] = json!("running");
    put(&state.db, "group_tasks", id(&g), &task).await.unwrap();
    let owner = context_for(&state, id(&g), "pock", id(&source), Some(&task), "execute").await;
    let submitted = submit(
        &state,
        &owner,
        &json!({"result":"First","verification":"Checked"}),
    )
    .await
    .unwrap();
    let changed = review_task(&state, id(&g), id(&task), &peer, &json!({"revision":submitted["revision"],"decision":"request_changes","evidence":"Cover the invalid input case"})).await.unwrap();
    assert_eq!(changed["status"], "queued");
    assert_eq!(changed["ownerId"], "pock");
    assert_eq!(changed["error"], "Cover the invalid input case");
    assert!(snapshot(&state, id(&g)).await.unwrap()["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["taskId"] == task["id"] && d["agentId"] == "pock" && d["purpose"] == "execute"));
    let cancelled = cancel_task(
        State(state.clone()),
        AxumPath((id(&g).into(), id(&task).into())),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(cancelled["status"], "cancelled");
    assert!(submit(
        &state,
        &owner,
        &json!({"result":"Late","verification":"Checked"})
    )
    .await
    .is_err());
    let retried = retry_task(
        State(state.clone()),
        AxumPath((id(&g).into(), id(&task).into())),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(retried["status"], "queued");
    assert!(retried["revision"].as_i64().unwrap() > changed["revision"].as_i64().unwrap());
    assert_eq!(
        get(&state.db, "groups", id(&g)).await.unwrap()["stopped"],
        false
    );
}

#[cfg(unix)]
#[tokio::test]
async fn exhausted_quota_is_visible_on_the_assignment_without_polluting_direct_chat() {
    let (_root, state, peer) = fixture().await;
    let g = group(&state, &peer, false).await;
    let source = human(&state, id(&g), "QUOTA", vec!["pock"], "quota").await;
    let task = create_assignment(
        &state,
        id(&g),
        id(&source),
        &json!({"title":"A","instructions":"Do","expectedResult":"Good","ownerId":"pock"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tick(&state).await.unwrap();
            if checked_task(&state, id(&g), id(&task)).await.unwrap()["status"] == "blocked"
                && !agent_active(&state, "pock").await
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .unwrap();
    let view = snapshot(&state, id(&g)).await.unwrap();
    assert!(view["tasks"][0]["error"]
        .as_str()
        .unwrap()
        .contains("Rate limit exceeded"));
    assert!(view["executions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["error"]
            .as_str()
            .is_some_and(|e| e.contains("Rate limit exceeded"))));
    let direct = state.agents.get("pock").await.unwrap();
    assert!(direct["error"].is_null());
    assert!(direct["messages"].as_array().unwrap().is_empty());
}
