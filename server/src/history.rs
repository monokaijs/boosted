//! UI-only projections. Never feed these back into persistence or model context.
use crate::{
    error::{AppError, AppResult},
    models::CodexChatMessage,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) const PAGE_SIZE: usize = 50;
#[derive(Default, Deserialize)]
pub(crate) struct HistoryQuery {
    pub before: Option<String>,
}

pub(crate) fn pick(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
            .collect(),
    )
}
pub(crate) fn spawned(action: &Value) -> bool {
    action["status"] == "completed"
        && matches!(action["tool"].as_str(), Some("create_chat" | "fork_chat"))
        && action["chatId"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
}
pub(crate) fn attachment_metadata(message: &mut Value, base: &str) {
    let message_id = message["id"].as_str().unwrap_or_default().to_owned();
    if let Some(attachments) = message["attachments"].as_array_mut() {
        for attachment in attachments {
            let mut meta = pick(attachment, &["id", "kind", "name", "mimeType", "size"]);
            meta["downloadPath"] = json!(format!(
                "{base}/messages/{}/attachments/{}",
                encode(&message_id),
                encode(attachment["id"].as_str().unwrap_or_default())
            ));
            *attachment = meta;
        }
    }
}
pub(crate) fn encode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}
fn visible(message: &Value) -> bool {
    message["content"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
        || message["attachments"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        || message["actions"]
            .as_array()
            .is_some_and(|a| a.iter().any(spawned))
}
pub(crate) fn agent_view(agent: &Value, before: Option<&str>) -> AppResult<Value> {
    let all = agent["messages"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let end = match before {
        Some(id) => all
            .iter()
            .position(|m| m["id"] == id)
            .ok_or_else(|| AppError::BadRequest("Unknown history cursor".into()))?,
        None => all.len(),
    };
    let mut selected: Vec<_> = all[..end]
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, m)| visible(m))
        .take(PAGE_SIZE + 1)
        .collect();
    let has_older = selected.len() > PAGE_SIZE;
    selected.truncate(PAGE_SIZE);
    selected.reverse();
    let mut view = pick(
        agent,
        &[
            "id",
            "createdAt",
            "updatedAt",
            "profile",
            "status",
            "activeGroupId",
            "activeExternalSession",
            "activity",
            "accountId",
            "error",
            "timeZone",
        ],
    );
    view["olderCursor"] = if has_older {
        selected
            .first()
            .map(|(_, m)| m["id"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let base = format!(
        "/agents/{}",
        encode(agent["id"].as_str().unwrap_or_default())
    );
    view["messages"] = json!(
        selected
            .into_iter()
            .map(|(sequence, m)| {
                let mut m = pick(
                    m,
                    &[
                        "id",
                        "role",
                        "content",
                        "createdAt",
                        "readAt",
                        "assistantName",
                        "attachments",
                        "delivery",
                        "inReplyTo",
                    ],
                );
                m["sequence"] = json!(sequence);
                let source = &all[sequence];
                let actions: Vec<_> = source["actions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|a| spawned(a))
                    .map(|a| pick(a, &["id", "tool", "status", "chatId"]))
                    .collect();
                if !actions.is_empty() {
                    m["actions"] = json!(actions);
                }
                attachment_metadata(&mut m, &base);
                m
            })
            .collect::<Vec<_>>()
    );
    // Follow-up state is visible in the profile; execution receipts stay internal.
    view["followUps"] = json!(
        agent["followUps"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| pick(
                f,
                &[
                    "id",
                    "kind",
                    "instructions",
                    "status",
                    "createdAt",
                    "dueAt",
                    "intervalMinutes",
                    "chatId",
                    "runId",
                    "taskId",
                    "projectId",
                    "title",
                    "error",
                    "lastDeliveredAt"
                ]
            ))
            .collect::<Vec<_>>()
    );
    view["lastMessageAt"] = all
        .iter()
        .rev()
        .find(|m| {
            m["role"] == "assistant" && m["content"].as_str().is_some_and(|s| !s.trim().is_empty())
        })
        .map(|m| m["createdAt"].clone())
        .unwrap_or(Value::Null);
    Ok(view)
}
pub(crate) fn revision(item: &Value) -> String {
    format!("{:x}", Sha256::digest(item.to_string().as_bytes()))
}

pub(crate) fn coding_summary(mut message: CodexChatMessage, item: &Value) -> CodexChatMessage {
    if message.kind == "tool" {
        let name = match item["type"].as_str().unwrap_or("tool") {
            "commandExecution" => "Command",
            "fileChange" => "Files changed",
            "dynamicToolCall" | "mcpToolCall" => item["tool"].as_str().unwrap_or("Tool"),
            kind => kind,
        };
        let label: String = name.chars().take(96).collect();
        message.content = format!(
            "**{label}** · {}",
            item["status"].as_str().unwrap_or_default()
        );
        message.detail_revision = Some(revision(item));
        message.attachments.clear();
    }
    for change in &mut message.changes {
        change.diff.clear();
    }
    for attachment in &mut message.attachments {
        if attachment
            .url
            .as_deref()
            .is_some_and(|s| s.starts_with("data:"))
        {
            attachment.url = None;
        }
    }
    message
}

pub(crate) fn task_event_summary(mut event: crate::models::TaskEvent) -> crate::models::TaskEvent {
    if matches!(
        event.kind.as_str(),
        "command" | "command_output" | "file_change"
    ) {
        event.payload = json!({"detailRevision":revision(&event.payload),"exitCode":event.payload["exitCode"],"label": if event.kind == "file_change" { "Files changed" } else { "Command" }});
    } else {
        event.payload = pick(
            &event.payload,
            &[
                "text",
                "message",
                "commentId",
                "replyTo",
                "agentId",
                "agentName",
                "agentIds",
                "agentNames",
                "chatId",
                "questions",
                "revision",
            ],
        );
    }
    event
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_agent_history_is_bounded_visible_and_never_mutated() {
        let messages: Vec<_> = (0..5_000).map(|i| json!({"id":format!("m{i}"),"role":"assistant","content":format!("Reply {i}"),"createdAt":"2026-10-01T00:00:00Z","actions":[{"id":"tool","tool":"run","arguments":{"command":"ARGUMENT".repeat(500)},"result":"RESULT".repeat(1000),"status":"completed"}],"attachments":[{"id":"image","kind":"image","name":"image.png","mimeType":"image/png","size":1000,"dataUrl":"data:image/png;base64,BINARY"}]})).collect();
        let mut agent = json!({"id":"agent","messages":messages,"followUps":[{"id":"follow","result":{"messages":["RECEIPT".repeat(500)]}}]});
        let original = agent.clone();
        let view = agent_view(&agent, None).unwrap();
        assert_eq!(view["messages"].as_array().unwrap().len(), 50);
        assert_eq!(view["messages"][0]["id"], "m4950");
        assert_eq!(view["olderCursor"], "m4950");
        let bytes = view.to_string();
        for hidden in ["ARGUMENT", "RESULT", "RECEIPT", "data:image"] {
            assert!(!bytes.contains(hidden));
        }
        assert_eq!(agent, original);
        agent["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"arrival","content":"New reply"}));
        let older = agent_view(&agent, view["olderCursor"].as_str()).unwrap();
        assert_eq!(older["messages"][49]["id"], "m4949");
        assert!(agent_view(&agent, Some("invalid")).is_err());
        println!(
            "PAYLOAD agent full_bytes={} tail_bytes={} messages=5000 returned=50",
            original.to_string().len(),
            bytes.len()
        );
    }
    #[test]
    fn hidden_actions_do_not_consume_visible_page_and_only_actual_spawn_links_survive() {
        let messages: Vec<_> = (0..200).map(|i|json!({"id":format!("m{i}"),"content":"","actions":[{"id":"a","tool":if i%4==0 {"create_chat"} else {"read_chat"},"status":"completed","chatId":"child","arguments":{"secret":"ARGUMENT"},"result":"RESULT"}]})).collect();
        let view = agent_view(&json!({"id":"a","messages":messages}), None).unwrap();
        assert_eq!(view["messages"].as_array().unwrap().len(), 50);
        assert!(view["olderCursor"].is_null());
        assert_eq!(
            view["messages"][0]["actions"][0],
            json!({"id":"a","tool":"create_chat","status":"completed","chatId":"child"})
        );
    }
    #[test]
    fn coding_summary_excludes_tool_arguments_output_diffs_and_binary_data() {
        let item = json!({"id":"tool","type":"commandExecution","status":"completed","command":"SECRET_ARGUMENT".repeat(1000),"aggregatedOutput":"SECRET_OUTPUT".repeat(1000)});
        let full = crate::codex_transcript::codex_item_message(&item, None, "fallback").unwrap();
        let full_bytes = serde_json::to_vec(&full).unwrap().len();
        let summary = coding_summary(full, &item);
        let bytes = serde_json::to_string(&summary).unwrap();
        assert!(!bytes.contains("SECRET"));
        assert!(summary.detail_revision.is_some());
        assert_eq!(item["aggregatedOutput"].as_str().unwrap().len(), 13000);
        println!(
            "PAYLOAD coding_tool full_bytes={full_bytes} summary_bytes={}",
            bytes.len()
        );
    }
}
