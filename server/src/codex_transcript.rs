//! Shared presentation for persisted and live app-server items.
use crate::models::{CodexChatMessage, CodexMessageAttachment};
use serde_json::{Value, json};

fn code_block(text: &str, language: &str) -> String {
    let longest = text.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(3.max(longest + 1));
    format!("{fence}{language}\n{text}\n{fence}")
}

fn details(value: &Value) -> String {
    let mut value = value.clone();
    redact_attachment_data(&mut value);
    code_block(
        &serde_json::to_string_pretty(&value).unwrap_or_default(),
        "json",
    )
}

fn redact_attachment_data(value: &mut Value) {
    if input_attachment(value).is_some() {
        if let Some(fields) = value.as_object_mut() {
            for key in [
                "data",
                "file_data",
                "input_audio",
                "url",
                "image_url",
                "imageUrl",
                "dataUrl",
            ] {
                if let Some(data) = fields.get_mut(key) {
                    if key == "data"
                        || key == "input_audio"
                        || data.as_str().is_some_and(|data| data.starts_with("data:"))
                    {
                        *data = json!("[Attachment data]");
                    }
                }
            }
        }
    }
    match value {
        Value::Array(values) => {
            for value in values {
                redact_attachment_data(value);
            }
        }
        Value::Object(fields) => {
            for value in fields.values_mut() {
                redact_attachment_data(value);
            }
        }
        _ => {}
    }
}

fn input_attachment(input: &Value) -> Option<CodexMessageAttachment> {
    let kind = input["type"].as_str()?;
    if !matches!(
        kind,
        "image"
            | "localImage"
            | "input_image"
            | "inputImage"
            | "audio"
            | "localAudio"
            | "input_audio"
            | "file"
            | "input_file"
            | "document"
            | "video"
            | "resource_link"
    ) {
        return None;
    }
    let mut path = input["path"]
        .as_str()
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let source = ["url", "image_url", "imageUrl", "file_url", "uri", "dataUrl"]
        .iter()
        .find_map(|key| input[key].as_str().or_else(|| input[key]["url"].as_str()));
    if path.is_none() {
        path = source
            .and_then(|source| source.strip_prefix("file://"))
            .map(str::to_string);
    }
    let mut url = source
        .filter(|url| {
            url.starts_with("data:") || url.starts_with("https://") || url.starts_with("http://")
        })
        .map(str::to_string);
    let mut mime_type = input["mimeType"]
        .as_str()
        .or_else(|| input["mime_type"].as_str())
        .map(str::to_string);
    if url.is_none() {
        if let Some(data) = input.pointer("/input_audio/data").and_then(Value::as_str) {
            let format = input
                .pointer("/input_audio/format")
                .and_then(Value::as_str)
                .unwrap_or("wav");
            let mime = if format == "mp3" {
                "audio/mpeg".to_string()
            } else {
                format!("audio/{format}")
            };
            url = Some(format!("data:{mime};base64,{data}"));
            mime_type = Some(mime);
        } else if let (Some(data), Some(mime)) = (input["data"].as_str(), mime_type.as_deref()) {
            url = Some(format!("data:{mime};base64,{data}"));
        } else if let Some(data) = input["file_data"]
            .as_str()
            .filter(|data| data.starts_with("data:"))
        {
            url = Some(data.to_string());
        }
    }
    if path.is_none() && url.is_none() {
        return None;
    }
    if mime_type.is_none() {
        mime_type = url
            .as_deref()
            .and_then(|url| url.strip_prefix("data:"))
            .and_then(|data| data.split([';', ',']).next())
            .map(str::to_string)
            .or_else(|| {
                path.as_deref()
                    .and_then(|path| mime_guess::from_path(path).first_raw().map(str::to_string))
            });
    }
    if mime_type.is_none() {
        mime_type = match kind {
            "image" | "localImage" | "input_image" | "inputImage" => Some("image/*".to_string()),
            "audio" | "localAudio" | "input_audio" => Some("audio/*".to_string()),
            "video" => Some("video/*".to_string()),
            _ => None,
        };
    }
    let name = input["name"]
        .as_str()
        .or_else(|| input["filename"].as_str())
        .map(str::to_string)
        .or_else(|| {
            path.as_deref().and_then(|path| {
                std::path::Path::new(path)
                    .file_name()?
                    .to_str()
                    .map(str::to_string)
            })
        })
        .unwrap_or_else(|| {
            format!(
                "{} attachment",
                if kind.contains("image") || kind == "localImage" || kind == "inputImage" {
                    "Image"
                } else if kind.contains("audio") || kind == "localAudio" {
                    "Audio"
                } else {
                    "File"
                }
            )
        });
    Some(CodexMessageAttachment {
        name,
        mime_type,
        path,
        url,
    })
}

fn collect_attachments(value: &Value, attachments: &mut Vec<CodexMessageAttachment>) {
    if let Some(attachment) = input_attachment(value) {
        attachments.push(attachment);
    } else if let Some(values) = value.as_array() {
        for value in values {
            collect_attachments(value, attachments);
        }
    } else if let Some(fields) = value.as_object() {
        for key in ["content", "contentItems", "output", "result"] {
            if let Some(value) = fields.get(key) {
                collect_attachments(value, attachments);
            }
        }
    }
}

fn input_text(content: &[Value]) -> String {
    let has_images = content.iter().any(|input| {
        matches!(
            input["type"].as_str(),
            Some("image" | "localImage" | "input_image" | "inputImage")
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
        .map(|input| {
            if input_attachment(input).is_some() {
                String::new()
            } else {
                match input.get("type").and_then(Value::as_str) {
                    Some("text" | "input_text" | "output_text") => {
                        input["text"].as_str().unwrap_or_default().to_string()
                    }
                    Some("image" | "localImage" | "input_image" | "inputImage") => {
                        "[Image attachment]".into()
                    }
                    Some("audio" | "localAudio" | "input_audio") => "[Audio attachment]".into(),
                    Some("encrypted_content") => "[Encrypted tool content]".into(),
                    Some("skill") => format!("${}", input["name"].as_str().unwrap_or("skill")),
                    Some("mention") => format!("@{}", input["name"].as_str().unwrap_or("mention")),
                    _ => format!(
                        "[{} attachment]\n\n{}",
                        input["type"].as_str().unwrap_or("Unknown"),
                        details(input)
                    ),
                }
            }
        })
        .filter(|text| !text.is_empty())
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
    let mut attachments = Vec::new();
    collect_attachments(item, &mut attachments);
    match item["type"].as_str()? {
        "imageView" => {
            if let Some(attachment) =
                input_attachment(&json!({"type":"localImage", "path":item["path"]}))
            {
                attachments.push(attachment);
            }
        }
        "imageGeneration" => {
            let image =
                if let Some(path) = item["savedPath"].as_str().filter(|path| !path.is_empty()) {
                    json!({"type":"localImage", "path":path})
                } else if let Some(data) = item["result"].as_str().filter(|data| !data.is_empty()) {
                    json!({"type":"image", "url":format!("data:image/png;base64,{data}")})
                } else {
                    Value::Null
                };
            if let Some(attachment) = input_attachment(&image) {
                attachments.push(attachment);
            }
        }
        _ => {}
    }
    let normalized = match item["type"].as_str()? {
        "userMessage" => {
            let content = input_text(
                item["content"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
            );
            (!content.is_empty() || !attachments.is_empty())
                .then(|| ("user".into(), "message".into(), content))
        }
        "agentMessage" => {
            let text = item["text"].as_str().unwrap_or_default();
            (!text.is_empty()
                || !attachments.is_empty()
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
        attachments,
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
        let message = codex_item_message(&input, None, "fallback").unwrap();
        assert!(message.content.is_empty());
        assert_eq!(
            message.attachments[0].path.as_deref(),
            Some("/repo/report.pdf")
        );
        assert_eq!(
            message.attachments[0].mime_type.as_deref(),
            Some("application/pdf")
        );
    }

    #[test]
    fn image_transport_markers_do_not_leak_into_attachment_messages() {
        let item = json!({"type":"userMessage","content":[{"type":"text","text":"<image>"},{"type":"image","url":"data:..."},{"type":"text","text":"</image>"},{"type":"text","text":"Describe this"}]});
        assert_eq!(
            codex_item_message(&item, None, "id").unwrap().content,
            "Describe this"
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
                "Answer",
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
    fn attachments_survive_live_and_persisted_messages_without_text_placeholders() {
        let item = json!({"id":"user", "type":"userMessage", "content":[
            {"type":"localImage", "path":"/uploads/photo.png"},
            {"type":"image", "url":"https://example.com/photo.jpg"},
            {"type":"input_audio", "input_audio":{"format":"mp3", "data":"YQ=="}},
            {"type":"input_file", "filename":"notes.txt", "file_data":"data:text/plain;base64,YQ=="}
        ]});
        for message in [
            codex_item_message(&item, None, "fallback").unwrap(),
            codex_live_item_message(&item, "client").unwrap(),
        ] {
            assert!(message.content.is_empty());
            assert_eq!(message.attachments.len(), 4);
            assert_eq!(message.attachments[0].name, "photo.png");
            assert_eq!(message.attachments[1].mime_type.as_deref(), Some("image/*"));
            assert_eq!(
                message.attachments[2].url.as_deref(),
                Some("data:audio/mpeg;base64,YQ==")
            );
            assert_eq!(message.attachments[3].name, "notes.txt");
        }
    }

    #[test]
    fn tool_images_are_viewable_without_dumping_bytes_into_the_transcript() {
        let item = json!({"type":"mcpToolCall", "tool":"screenshot", "result":{"content":[{"type":"image", "mimeType":"image/png", "data":"aW1hZ2U="}]}});
        let message = codex_item_message(&item, None, "tool").unwrap();
        assert_eq!(
            message.attachments[0].url.as_deref(),
            Some("data:image/png;base64,aW1hZ2U=")
        );
        assert!(!message.content.contains("aW1hZ2U="));
        let generated = codex_item_message(
            &json!({"type":"imageGeneration", "savedPath":"/tmp/generated.png", "result":"bytes"}),
            None,
            "tool",
        )
        .unwrap();
        assert_eq!(
            generated.attachments[0].path.as_deref(),
            Some("/tmp/generated.png")
        );
        let fallback = codex_item_message(
            &json!({"type":"userMessage", "content":[{"type":"image"}]}),
            None,
            "user",
        )
        .unwrap();
        assert_eq!(fallback.content, "[Image attachment]");
        assert!(fallback.attachments.is_empty());
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
