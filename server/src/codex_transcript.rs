//! Shared presentation for persisted and live app-server items.
use crate::models::CodexChatMessage;
use serde_json::{Value, json};

fn code_block(text: &str, language: &str) -> String {
    let longest = text.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(3.max(longest + 1));
    format!("{fence}{language}\n{text}\n{fence}")
}

fn details(value: &Value) -> String {
    code_block(
        &serde_json::to_string_pretty(value).unwrap_or_default(),
        "json",
    )
}

fn input_text(content: &[Value]) -> String {
    let has_images = content.iter().any(|input| {
        matches!(
            input["type"].as_str(),
            Some("image" | "localImage" | "input_image")
        )
    });
    content
        .iter()
        .filter(|input| {
            !(has_images
                && matches!(
                    input["text"].as_str().map(str::trim),
                    Some("<image>" | "</image>")
                ))
        })
        .map(|input| match input.get("type").and_then(Value::as_str) {
            Some("text" | "input_text" | "output_text") => {
                input["text"].as_str().unwrap_or_default().to_string()
            }
            Some("image" | "localImage" | "input_image") => "[Image attachment]".into(),
            Some("audio" | "localAudio" | "input_audio") => "[Audio attachment]".into(),
            Some("encrypted_content") => "[Encrypted tool content]".into(),
            Some("skill") => format!("${}", input["name"].as_str().unwrap_or("skill")),
            Some("mention") => format!("@{}", input["name"].as_str().unwrap_or("mention")),
            _ => format!(
                "[{} attachment]\n\n{}",
                input["type"].as_str().unwrap_or("Unknown"),
                details(input)
            ),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn tool_text(item: &Value) -> Option<(String, String)> {
    let item_type = item["type"].as_str()?;
    let text = |field: &str| item[field].as_str().unwrap_or_default();
    let (kind, heading) = match item_type {
        "reasoning" => {
            let summary = item["summary"]
                .as_array()
                .map(|summary| {
                    summary
                        .iter()
                        .filter_map(|part| part.as_str().or_else(|| part["text"].as_str()))
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default();
            return (!summary.is_empty()).then(|| {
                (
                    "reasoning".into(),
                    format!(
                        "> **Reasoning summary**\n> {}",
                        summary.replace('\n', "\n> ")
                    ),
                )
            });
        }
        "plan" => return Some(("plan".into(), format!("**Plan**\n\n{}", text("text")))),
        "commandExecution" => {
            let exit = item["exitCode"]
                .as_i64()
                .map(|code| format!(" · exit {code}"))
                .unwrap_or_default();
            let status = text("status");
            let mut body = format!(
                "**Command** · {status}{exit}\n\n{}",
                code_block(text("command"), "sh")
            );
            if !text("aggregatedOutput").is_empty() {
                body.push_str(&format!(
                    "\n\n{}",
                    code_block(text("aggregatedOutput"), "text")
                ));
            }
            return Some(("tool".into(), body));
        }
        "fileChange" => ("tool", "Files changed".to_string()),
        "mcpToolCall" => (
            "tool",
            format!("Tool · {}/{}", text("server"), text("tool")),
        ),
        "dynamicToolCall" => ("tool", format!("Tool · {}", text("tool"))),
        "functionCallOutput" => {
            let output = match &item["output"] {
                Value::String(output) => code_block(output, "text"),
                Value::Array(content) => input_text(content),
                output => details(output),
            };
            return Some((
                "tool".into(),
                format!("**Tool output** · {}\n\n{output}", text("name")),
            ));
        }
        "collabAgentToolCall" | "collabToolCall" => {
            ("tool", format!("Agent collaboration · {}", text("tool")))
        }
        "subAgentActivity" => (
            "tool",
            format!("Subagent · {} · {}", text("agentPath"), text("kind")),
        ),
        "hookPrompt" => ("tool", "Hook context".to_string()),
        "webSearch" => ("tool", format!("Web search · {}", text("query"))),
        "imageView" => ("tool", format!("Viewed image · {}", text("path"))),
        "imageGeneration" => {
            let mut display = item.clone();
            // Image bytes are not useful as text. Preserve the saved artifact link.
            if display["result"].is_string() {
                display["result"] = json!("[Generated image data]");
            }
            let link = if text("savedPath").is_empty() {
                String::new()
            } else {
                format!("\n\n[Generated image](<{}>)", text("savedPath"))
            };
            return Some((
                "tool".into(),
                format!(
                    "**Image generation** · {}{link}\n\n{}",
                    text("status"),
                    details(&display)
                ),
            ));
        }
        "sleep" => {
            return Some((
                "system".into(),
                format!(
                    "*Codex waited {} ms.*",
                    item["durationMs"].as_i64().unwrap_or_default()
                ),
            ));
        }
        "contextCompaction" => {
            return Some((
                "system".into(),
                "*Codex compacted the conversation context.*".into(),
            ));
        }
        "enteredReviewMode" => ("system", "Codex entered review mode".to_string()),
        "exitedReviewMode" => ("system", "Codex completed review mode".to_string()),
        // Future protocol items remain inspectable instead of disappearing.
        _ => ("tool", format!("Codex item · {item_type}")),
    };
    Some((kind.into(), format!("**{heading}**\n\n{}", details(item))))
}

pub(crate) fn codex_item_message(
    item: &Value,
    created_at: Option<String>,
    fallback_id: &str,
) -> Option<CodexChatMessage> {
    let normalized = match item["type"].as_str()? {
        "userMessage" => {
            let content = input_text(
                item["content"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
            );
            (!content.is_empty()).then(|| ("user".into(), "message".into(), content))
        }
        "agentMessage" => {
            let text = item["text"].as_str().unwrap_or_default();
            (!text.is_empty()
                || item["questions"]
                    .as_array()
                    .is_some_and(|questions| !questions.is_empty()))
            .then(|| ("assistant".into(), "message".into(), text.to_string()))
        }
        _ => tool_text(item).map(|(kind, content)| ("assistant".into(), kind, content)),
    };
    normalized.map(|(role, kind, content)| CodexChatMessage {
        id: item["id"].as_str().unwrap_or(fallback_id).to_string(),
        role,
        content,
        kind,
        created_at,
        questions: item
            .get("questions")
            .filter(|questions| questions.is_array())
            .cloned(),
    })
}

pub(crate) fn codex_live_item_message(
    item: &Value,
    client_message_id: &str,
) -> Option<CodexChatMessage> {
    codex_item_message(item, None, "live-item").map(|mut message| {
        if message.role == "user" {
            if let Some(id) = item["clientId"].as_str().filter(|id| !id.is_empty()) {
                message.id = id.to_string();
            } else if !client_message_id.is_empty() {
                message.id = client_message_id.to_string();
            }
        }
        message
    })
}

pub(crate) fn is_question_reply(text: &str) -> bool {
    let Some(body) = text
        .strip_prefix("<send_user_message_question_reply>")
        .and_then(|text| text.strip_suffix("</send_user_message_question_reply>"))
    else {
        return false;
    };
    let Ok(Value::Array(replies)) = serde_json::from_str::<Value>(body.trim()) else {
        return false;
    };
    !replies.is_empty()
        && replies.iter().all(|reply| {
            reply["questionItemId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
                && reply["question"].is_string()
                && reply["answer"]
                    .as_str()
                    .is_some_and(|answer| !answer.trim().is_empty())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_current_protocol_item_has_a_presentation() {
        // Inventory from codex-cli 0.159.3's generated ThreadItem union.
        let items = [
            json!({"type":"userMessage","content":[{"type":"text","text":"Hello"}]}),
            json!({"type":"agentMessage","text":"Hello"}),
            json!({"type":"hookPrompt","fragments":[{"hookRunId":"hook","text":"Context"}]}),
            json!({"type":"functionCallOutput","name":"lookup","output":"Result"}),
            json!({"type":"plan","text":"Build it"}),
            json!({"type":"reasoning","summary":["Summary"],"content":["private"]}),
            json!({"type":"commandExecution","command":"echo hello","status":"completed","aggregatedOutput":"hello","exitCode":0}),
            json!({"type":"fileChange","changes":[{"path":"main.rs","diff":"+hello"}],"status":"completed"}),
            json!({"type":"mcpToolCall","server":"docs","tool":"search","arguments":{"q":"rust"},"result":{"content":[{"type":"text","text":"Found it"}]}}),
            json!({"type":"dynamicToolCall","tool":"lookup","contentItems":[{"type":"inputText","text":"Found it"}]}),
            json!({"type":"collabAgentToolCall","tool":"spawnAgent","receiverThreadIds":["child"]}),
            json!({"type":"subAgentActivity","agentPath":"/root/child","kind":"completed"}),
            json!({"type":"webSearch","query":"rust","results":[{"url":"https://example.com"}]}),
            json!({"type":"imageView","path":"/tmp/image.png"}),
            json!({"type":"sleep","durationMs":123}),
            json!({"type":"imageGeneration","status":"completed","savedPath":"/tmp/image.png","result":"base64-image"}),
            json!({"type":"enteredReviewMode","review":"Review tests"}),
            json!({"type":"exitedReviewMode","review":"Looks good"}),
            json!({"type":"contextCompaction"}),
        ];
        for item in items {
            let message = codex_item_message(&item, Some("timestamp".into()), "fallback")
                .unwrap_or_else(|| panic!("Missing presentation for {}", item["type"]));
            assert!(
                !message.content.is_empty(),
                "Empty presentation for {}",
                item["type"]
            );
            assert_eq!(message.id, "fallback");
            assert_eq!(message.created_at.as_deref(), Some("timestamp"));
        }
    }

    #[test]
    fn unknown_items_and_inputs_remain_inspectable() {
        let item = json!({"id":"future","type":"futureTool","result":{"important":true}});
        let message = codex_item_message(&item, None, "fallback").unwrap();
        assert_eq!(message.id, "future");
        assert_eq!(message.kind, "tool");
        assert!(message.content.contains("important"));
        let input =
            json!({"type":"userMessage","content":[{"type":"document","path":"/repo/report.pdf"}]});
        assert!(
            codex_item_message(&input, None, "fallback")
                .unwrap()
                .content
                .contains("/repo/report.pdf")
        );
    }

    #[test]
    fn image_transport_markers_do_not_leak_into_attachment_messages() {
        let item = json!({"type":"userMessage","content":[{"type":"text","text":"<image>"},{"type":"image","url":"data:..."},{"type":"text","text":"</image>"},{"type":"text","text":"Describe this"}]});
        assert_eq!(
            codex_item_message(&item, None, "id").unwrap().content,
            "[Image attachment]\n\nDescribe this"
        );
        assert_eq!(
            input_text(&[json!({"type":"text","text":"<image>"})]),
            "<image>"
        );
    }

    #[test]
    fn tool_results_errors_and_diffs_are_not_lost() {
        for (item, expected) in [
            (
                json!({"type":"mcpToolCall","tool":"lookup","error":{"message":"Not found"}}),
                "Not found",
            ),
            (
                json!({"type":"dynamicToolCall","tool":"lookup","contentItems":[{"type":"inputText","text":"Answer"}]}),
                "Answer",
            ),
            (
                json!({"type":"fileChange","changes":[{"path":"file","diff":"+added"}]}),
                "+added",
            ),
            (
                json!({"type":"functionCallOutput","name":"lookup","output":[{"type":"input_text","text":"Answer"},{"type":"input_image","image_url":"data:..."}]}),
                "Answer\n\n[Image attachment]",
            ),
        ] {
            assert!(
                codex_item_message(&item, None, "fallback")
                    .unwrap()
                    .content
                    .contains(expected)
            );
        }
    }

    #[test]
    fn only_reasoning_summaries_are_displayed() {
        let item = json!({"type":"reasoning","summary":[{"text":"Public summary"}],"content":["private reasoning"]});
        let message = codex_item_message(&item, None, "fallback").unwrap();
        assert!(message.content.contains("Public summary"));
        assert!(!message.content.contains("private reasoning"));
        assert!(
            codex_item_message(
                &json!({"type":"reasoning","summary":[],"content":["private"]}),
                None,
                "fallback"
            )
            .is_none()
        );
    }

    #[test]
    fn question_only_async_messages_are_preserved() {
        let item = json!({"id":"call-1","type":"agentMessage","text":"","questions":[{"title":"Where?","options":["Here","There"]}]});
        let message = codex_item_message(&item, None, "fallback").unwrap();
        assert_eq!(message.id, "call-1");
        assert_eq!(message.questions.unwrap()[0]["title"], "Where?");
    }

    #[test]
    fn steered_user_replies_keep_their_own_identity() {
        let item = json!({"id":"server-reply","clientId":"reply-client","type":"userMessage","content":[{"type":"text","text":"Reply"}]});
        assert_eq!(
            codex_live_item_message(&item, "original-client")
                .unwrap()
                .id,
            "reply-client"
        );
        let legacy = json!({"id":"server-reply","type":"userMessage","content":[{"type":"text","text":"Reply"}]});
        assert_eq!(
            codex_live_item_message(&legacy, "").unwrap().id,
            "server-reply"
        );
    }

    #[test]
    fn embedded_fences_cannot_break_tool_output_blocks() {
        let item = json!({"type":"commandExecution","command":"echo hello","aggregatedOutput":"```\n# untrusted heading\n```"});
        let message = codex_item_message(&item, None, "fallback").unwrap();
        assert!(
            message
                .content
                .contains("````text\n```\n# untrusted heading\n```\n````")
        );
    }

    #[test]
    fn only_valid_question_replies_can_steer_a_running_turn() {
        let reply = "<send_user_message_question_reply>[{\"questionItemId\":\"id\",\"question\":\"Where?\",\"answer\":\"Here\"}]</send_user_message_question_reply>";
        assert!(is_question_reply(reply));
        for text in [
            "hello",
            "<send_user_message_question_reply>bad</send_user_message_question_reply>",
            "<send_user_message_question_reply>[]</send_user_message_question_reply>",
        ] {
            assert!(!is_question_reply(text));
        }
    }
}
