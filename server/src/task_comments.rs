//! Agent mentions turn task comments into ordinary, durable agent requests.
use super::*;

fn mentioned_agents(message: &str, agents: &[Value]) -> AppResult<Vec<String>> {
    let mut recipients = Vec::new();
    for (offset, _) in message.match_indices('@') {
        // An email address or a word containing @ is not an agent mention.
        if message[..offset]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '@')
        {
            continue;
        }
        let rest = &message[offset + 1..];
        let mut matches = Vec::new();
        for agent in agents {
            let Some(name) = agent["profile"]["name"].as_str() else {
                continue;
            };
            for token in [name.to_owned(), format!("({name})")] {
                if let Some(prefix) = rest.get(..token.len()) {
                    if prefix.eq_ignore_ascii_case(&token)
                        && rest[token.len()..]
                            .chars()
                            .next()
                            .is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '-')
                    {
                        matches.push((token.len(), agent["id"].as_str().unwrap().to_owned()));
                    }
                }
            }
        }
        matches.sort_by(|a, b| b.0.cmp(&a.0));
        if let Some((length, id)) = matches.first() {
            if matches
                .iter()
                .any(|(other_length, other_id)| other_length == length && other_id != id)
            {
                return Err(AppError::BadRequest("This agent name is ambiguous. Give the agents distinct names before mentioning them.".into()));
            }
            if !recipients.contains(id) {
                recipients.push(id.clone());
            }
        } else if rest.starts_with('(') || rest.chars().next().is_some_and(char::is_alphanumeric) {
            return Err(AppError::BadRequest(
                "Unknown agent mention. Choose an agent from the mention suggestions.".into(),
            ));
        }
    }
    Ok(recipients)
}

pub(super) async fn post(
    state: &AppState,
    user: &AuthUser,
    task_id: &str,
    message: &str,
) -> AppResult<()> {
    let message = message.trim();
    if message.is_empty() || message.chars().count() > 32_000 {
        return Err(AppError::BadRequest(
            "Provide a comment of up to 32,000 characters".into(),
        ));
    }
    let task = state.db.task(task_id).await?;
    let project = state.db.project(&task.project_id).await?;
    let Json(agents) = agents::list_agents(State(state.clone())).await;
    let recipients = mentioned_agents(message, &agents)?;
    let names: Vec<_> = agents
        .iter()
        .filter(|agent| recipients.iter().any(|id| agent["id"] == id.as_str()))
        .map(|agent| agent["profile"]["name"].clone())
        .collect();
    let comment_id = Uuid::new_v4().to_string();
    let attachments: Vec<_> = sqlx::query("SELECT name,mime_type,path FROM task_attachments WHERE task_id=?")
        .bind(task_id).fetch_all(&state.db.pool).await?.iter()
        .map(|row| json!({"name":row.get::<String,_>("name"),"mimeType":row.get::<String,_>("mime_type"),"path":row.get::<String,_>("path")})).collect();
    let conversation: Vec<_> = state
        .db
        .events(task_id, 0)
        .await?
        .into_iter()
        .rev()
        .filter(|event| matches!(event.kind.as_str(), "user_message" | "agent_message"))
        .take(30)
        .map(|event| json!({"kind":event.kind,"payload":event.payload}))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    state
        .event(
            task_id,
            "user_message",
            Some(&user.id),
            json!({"text":message,"commentId":comment_id,"agentIds":recipients,"agentNames":names}),
        )
        .await?;
    for agent_id in recipients {
        let context = json!({"taskId":task_id,"commentId":comment_id,"title":task.title,
            "description":task.description,"projectId":project.id,"workingDirectory":task.worktree_path,"projectWorkingDirectory":project.repo_path,
            "options":{"model":task.model,"reasoningEffort":task.reasoning_effort,"accessMode":task.access_mode},"attachments":attachments,
            "source":task.source,"plan":task.plan,"conversation":conversation});
        if let Err(error) = agents::enqueue_message(
            state,
            &agent_id,
            json!({"content":message,"clientMessageId":format!("task:{comment_id}:{agent_id}")}),
            Some(context.clone()),
        )
        .await
        {
            state.event(task_id, "agent_message", None,
                json!({"text":format!("Could not notify the agent: {error}"),"replyTo":comment_id,"agentId":agent_id,"failed":true})).await?;
        }
    }
    Ok(())
}

pub(super) async fn reply(
    state: &AppState,
    agent_id: &str,
    current: &[Value],
    content: &str,
    chat_id: Option<&str>,
) -> AppResult<()> {
    let agent = state.agents.get(agent_id).await?;
    let mut sources = current.to_vec();
    if sources.is_empty() {
        // Watched chats continue to reply to the initiating comment after the first turn.
        let ids: HashSet<_> = agent["followUps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|followup| followup["status"] == "processing")
            .filter_map(|followup| followup["sourceMessageIds"].as_array())
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        sources = agent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["id"].as_str().is_some_and(|id| ids.contains(id)))
            .cloned()
            .collect();
    }
    let linked_task = if let Some(chat_id) = chat_id {
        providers::document(&state.db, "provider-chats", chat_id)
            .await
            .ok()
            .and_then(|chat| chat["taskId"].as_str().map(str::to_owned))
    } else {
        None
    };
    let mut posted = HashSet::new();
    for source in sources {
        let context = &source["taskContext"];
        let (Some(task_id), Some(comment_id)) =
            (context["taskId"].as_str(), context["commentId"].as_str())
        else {
            continue;
        };
        if chat_id.is_some() && linked_task.as_deref() != Some(task_id) {
            continue;
        }
        if !posted.insert((task_id.to_owned(), comment_id.to_owned())) {
            continue;
        }
        state
            .event(
                task_id,
                "agent_message",
                None,
                json!({"text":content,"replyTo":comment_id,"agentId":agent_id,
                "agentName":agent["profile"]["name"],"chatId":chat_id}),
            )
            .await?;
    }
    Ok(())
}

pub(super) fn attach_chat(current: &[Value], chat: &mut Value) {
    if let Some(context) = current
        .iter()
        .map(|message| &message["taskContext"])
        .find(|context| {
            context["taskId"].is_string() && context["workingDirectory"] == chat["workingDirectory"]
        })
    {
        chat["taskId"] = context["taskId"].clone();
        chat["taskCommentId"] = context["commentId"].clone();
        chat["projectId"] = context["projectId"].clone();
        chat["projectWorkingDirectory"] = context["projectWorkingDirectory"].clone();
    }
}

pub(super) async fn chat_started(state: &AppState, chat_id: &str, turn_id: &str) -> AppResult<()> {
    let Ok(mut chat) = providers::document(&state.db, "provider-chats", chat_id).await else {
        return Ok(());
    };
    let Some(task_id) = chat["taskId"].as_str().map(str::to_owned) else {
        return Ok(());
    };
    chat["taskTurnId"] = json!(turn_id);
    providers::save_document(&state.db, "provider-chats", &chat).await?;
    state.set_task_state(&task_id, "running", None).await
}

pub(super) async fn chat_event(
    state: &AppState,
    chat_id: &str,
    turn_id: &str,
    method: &str,
    params: &Value,
) -> AppResult<()> {
    if !matches!(
        method,
        "turn/completed"
            | "serverRequest/resolved"
            | "item/tool/requestUserInput"
            | "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
    ) {
        return Ok(());
    }
    let Ok(chat) = providers::document(&state.db, "provider-chats", chat_id).await else {
        return Ok(());
    };
    let Some(task_id) = chat["taskId"].as_str() else {
        return Ok(());
    };
    if chat["taskTurnId"] != turn_id {
        return Ok(());
    }
    let status = if method == "turn/completed" {
        match params["turn"]["status"].as_str() {
            Some("failed") => "failed",
            Some("interrupted") => "queued",
            _ => "review",
        }
    } else if method == "serverRequest/resolved" {
        "running"
    } else {
        "needs_input"
    };
    let error = (status == "failed").then(|| params["turn"]["error"].to_string());
    state
        .set_task_state(task_id, status, error.as_deref())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn agents() -> Vec<Value> {
        vec![
            json!({"id":"coral","profile":{"name":"Coral"}}),
            json!({"id":"coral-team","profile":{"name":"Coral Team"}}),
        ]
    }
    #[test]
    fn mentions_resolve_names_and_boundaries_without_matching_emails() {
        assert_eq!(
            mentioned_agents("@coral please plan; @Coral do it", &agents()).unwrap(),
            vec!["coral"]
        );
        assert_eq!(
            mentioned_agents("@(Coral Team) why a panel?", &agents()).unwrap(),
            vec!["coral-team"]
        );
        assert_eq!(
            mentioned_agents("@Coral Team plan with @Coral", &agents()).unwrap(),
            vec!["coral-team", "coral"]
        );
        assert!(
            mentioned_agents("hello coral@example.com", &agents())
                .unwrap()
                .is_empty()
        );
        assert!(
            mentioned_agents("A plain comment", &agents())
                .unwrap()
                .is_empty()
        );
        assert!(mentioned_agents("@Coraline do it", &agents()).is_err());
    }
    #[test]
    fn duplicate_names_are_rejected_instead_of_dispatching_to_the_wrong_agent() {
        let mut entries = agents();
        entries.push(json!({"id":"other","profile":{"name":"Coral"}}));
        assert!(mentioned_agents("@Coral do it", &entries).is_err());
    }
}
