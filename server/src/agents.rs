//! Persistent PockCode agents using native, isolated Codex app-server sessions.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use providers::{document, documents, save_document, text};
use std::time::Duration;
use tokio::sync::{Mutex, watch};

const DEFAULT_PERSONALITY: &str =
    "Friendly, clear, and concise. Be practical about coding work and explain blockers directly.";
#[derive(Clone, Default)]
pub(crate) struct AgentManager {
    states: Arc<Mutex<HashMap<String, Value>>>,
    workers: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}
impl AgentManager {
    pub async fn load(db: &Database) -> AppResult<Self> {
        let manager = Self::default();
        for mut agent in documents(db, "agents").await? {
            agent["status"] = json!("idle");
            agent["typing"] = json!(false);
            if let Some(messages) = agent["messages"].as_array_mut() {
                for message in messages {
                    if message["delivery"] == "processing" {
                        message["delivery"] = json!("queued");
                    }
                }
            }
            if let Some(followups) = agent["followUps"].as_array_mut() {
                for followup in followups {
                    if followup["status"] == "processing" {
                        followup["status"] = json!("ready");
                    }
                }
            }
            save_document(db, "agents", &agent).await?;
            manager
                .states
                .lock()
                .await
                .insert(agent["id"].as_str().unwrap().into(), agent);
        }
        if manager.states.lock().await.is_empty() {
            let agent = new_agent("pock".into(), "Pock".into(), DEFAULT_PERSONALITY.into());
            save_document(db, "agents", &agent).await?;
            manager.states.lock().await.insert("pock".into(), agent);
        }
        Ok(manager)
    }
    pub async fn uses_account(&self, id: &str) -> bool {
        self.states
            .lock()
            .await
            .values()
            .any(|a| a["status"] == "running" && a["accountId"] == id)
    }
    async fn get(&self, id: &str) -> AppResult<Value> {
        self.states
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("Agent not found".into()))
    }
}
fn new_agent(id: String, name: String, personality: String) -> Value {
    let now = Utc::now().to_rfc3339();
    json!({"id":id,"createdAt":now,"updatedAt":now,"profile":{"name":name,"personality":personality},"messages":[],"followUps":[],"status":"idle","typing":false,"accountId":null,"error":null})
}
async fn change<F>(state: &AppState, id: &str, update: F) -> AppResult<Value>
where
    F: FnOnce(&mut Value) -> AppResult<()>,
{
    let mut states = state.agents.states.lock().await;
    let current = states
        .get_mut(id)
        .ok_or_else(|| AppError::NotFound("Agent not found".into()))?;
    let mut next = current.clone();
    update(&mut next)?;
    // Strict monotonic timestamps let the copied UI reject late polling responses.
    let previous = next["updatedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc));
    let now = Utc::now().timestamp_millis();
    let previous = previous.map(|old| old.timestamp_millis()).unwrap_or(0);
    let timestamp = chrono::DateTime::from_timestamp_millis(now.max(previous + 1)).unwrap();
    next["updatedAt"] = json!(timestamp.to_rfc3339());
    save_document(&state.db, "agents", &next).await?;
    *current = next.clone();
    state.emit("assistant.updated", next.clone());
    Ok(next)
}
pub(crate) async fn list_agents(State(state): State<AppState>) -> Json<Vec<Value>> {
    let mut agents:Vec<_> = state.agents.states.lock().await.values().map(|a| json!({"id":a["id"],"profile":a["profile"],"status":a["status"],"accountId":a["accountId"],"createdAt":a["createdAt"],"updatedAt":a["updatedAt"]})).collect();
    agents.sort_by_key(|a| a["createdAt"].as_str().unwrap_or_default().to_owned());
    Json(agents)
}
pub(crate) async fn create_agent(
    State(state): State<AppState>,
    Json(input): Json<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let name = text(&input, "name", 80)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let personality = if input["personality"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        text(&input, "personality", 2000)?
    } else {
        DEFAULT_PERSONALITY.into()
    };
    let agent = new_agent(Uuid::new_v4().to_string(), name, personality);
    save_document(&state.db, "agents", &agent).await?;
    state
        .agents
        .states
        .lock()
        .await
        .insert(agent["id"].as_str().unwrap().into(), agent.clone());
    state.emit("assistant.updated", agent.clone());
    Ok((StatusCode::CREATED, Json(agent)))
}
pub(crate) async fn read_agent(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(state.agents.get(&id).await?))
}
pub(crate) async fn send_message(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    let content = text(&input, "content", 32_000)?;
    validate_attachments(input.get("attachments"))?;
    if let Some(account_id) = input["accountId"].as_str() {
        let account = document(&state.db, "accounts", account_id).await?;
        if account["status"] != "CONNECTED" {
            return Err(AppError::Conflict(
                "Connect this provider account first".into(),
            ));
        }
    }
    let message_id = input["clientMessageId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 200)
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let updated = change(&state,&id,|agent| {
        if agent["messages"].as_array().unwrap().iter().any(|m|m["id"] == message_id) { return Ok(()); }
        let mut message = json!({"id":message_id,"role":"user","content":content,"createdAt":Utc::now().to_rfc3339(),"delivery":"queued"});
        if let Some(attachments) = input.get("attachments") {message["attachments"] = attachments.clone();}
        if let Some(account) = input.get("accountId") {message["requestedAccountId"] = account.clone();}
        if let Some(zone) = input["timeZone"].as_str().filter(|s| s.len() <= 100) {agent["timeZone"] = json!(zone);}
        agent["messages"].as_array_mut().unwrap().push(message); agent["error"] = Value::Null; Ok(())
    }).await?;
    start_worker(state.clone(), id.clone()).await?;
    Ok(Json(if updated["status"] == "running" {
        updated
    } else {
        state.agents.get(&id).await?
    }))
}
pub(crate) async fn stop_agent(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    if let Some(sender) = state.agents.workers.lock().await.get(&id) {
        let _ = sender.send(true);
    }
    Ok(Json(
        change(&state, &id, |agent| {
            for message in agent["messages"].as_array_mut().unwrap() {
                if message["delivery"] == "queued" {
                    message["delivery"] = json!("cancelled");
                }
            }
            agent["typing"] = json!(false);
            Ok(())
        })
        .await?,
    ))
}
pub(crate) async fn update_avatar(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    let avatar = text(&input, "avatar", 2_000_000)?;
    validate_image(&avatar)?;
    Ok(Json(
        change(&state, &id, |a| {
            a["profile"]["avatar"] = json!(avatar);
            Ok(())
        })
        .await?,
    ))
}
pub(crate) async fn cancel_followup(
    State(state): State<AppState>,
    AxumPath((id, followup_id)): AxumPath<(String, String)>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        change(&state, &id, |a| {
            let followup = a["followUps"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|f| f["id"] == followup_id)
                .ok_or_else(|| AppError::NotFound("Follow-up not found".into()))?;
            followup["status"] = json!("cancelled");
            Ok(())
        })
        .await?,
    ))
}
fn validate_image(value: &str) -> AppResult<Vec<u8>> {
    let (header, data) = value
        .split_once(',')
        .ok_or_else(|| AppError::BadRequest("Invalid image".into()))?;
    if !matches!(
        header,
        "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
    ) {
        return Err(AppError::BadRequest(
            "Choose a PNG, JPEG or WebP image".into(),
        ));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| AppError::BadRequest("Invalid image encoding".into()))?;
    if bytes.is_empty() || bytes.len() > 5 * 1024 * 1024 {
        return Err(AppError::BadRequest("Image exceeds the 5 MB limit".into()));
    }
    let valid = match header {
        "data:image/png;base64" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "data:image/jpeg;base64" => bytes.starts_with(b"\xff\xd8\xff"),
        _ => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
    };
    if !valid {
        return Err(AppError::BadRequest("Invalid image contents".into()));
    }
    Ok(bytes)
}
fn validate_attachments(value: Option<&Value>) -> AppResult<()> {
    let Some(value) = value else { return Ok(()) };
    let attachments = value
        .as_array()
        .ok_or_else(|| AppError::BadRequest("Attachments must be an array".into()))?;
    if attachments.len() > 10 {
        return Err(AppError::BadRequest(
            "At most 10 attachments are allowed".into(),
        ));
    }
    let mut total = 0;
    for attachment in attachments {
        text(attachment, "name", 255)?;
        text(attachment, "id", 200)?;
        let data = text(attachment, "dataUrl", 8 * 1024 * 1024)?;
        let bytes = if attachment["kind"] == "image" {
            if let Some(encoded) = data.strip_prefix("data:image/gif;base64,") {
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| AppError::BadRequest("Invalid GIF image".into()))?;
                if !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
                    return Err(AppError::BadRequest("Invalid GIF image".into()));
                }
                bytes
            } else {
                validate_image(&data)?
            }
        } else {
            let (header, encoded) = data
                .split_once(',')
                .ok_or_else(|| AppError::BadRequest("Invalid attachment".into()))?;
            if !header.starts_with("data:") || !header.ends_with(";base64") {
                return Err(AppError::BadRequest("Invalid attachment encoding".into()));
            }
            STANDARD
                .decode(encoded)
                .map_err(|_| AppError::BadRequest("Invalid attachment encoding".into()))?
        };
        total += bytes.len();
        if bytes.len() > 5 * 1024 * 1024 || total > 10 * 1024 * 1024 {
            return Err(AppError::BadRequest(
                "Attachment size limit exceeded".into(),
            ));
        }
    }
    Ok(())
}
async fn start_worker(state: AppState, id: String) -> AppResult<()> {
    let mut workers = state.agents.workers.lock().await;
    if workers.contains_key(&id) {
        return Ok(());
    }
    let agent = state.agents.get(&id).await?;
    let pending = agent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["delivery"] == "queued")
        || agent["followUps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["status"] == "ready");
    if !pending {
        return Ok(());
    }
    let (sender, receiver) = watch::channel(false);
    workers.insert(id.clone(), sender);
    change(&state, &id, |a| {
        a["status"] = json!("running");
        a["error"] = Value::Null;
        Ok(())
    })
    .await?;
    drop(workers);
    tokio::spawn(async move {
        let result = run_queue(&state, &id, receiver).await;
        let _ = change(&state, &id, |a| {
            a["status"] = json!("idle");
            a["typing"] = json!(false);
            if let Err(error) = &result {
                a["error"] = json!(error.to_string());
                for message in a["messages"].as_array_mut().unwrap() {
                    if message["delivery"] == "processing" {
                        message["delivery"] = json!("handled");
                    }
                }
                for followup in a["followUps"].as_array_mut().unwrap() {
                    if followup["status"] == "processing" {
                        followup["status"] = json!("failed");
                        followup["error"] = json!(error.to_string());
                    }
                }
            }
            Ok(())
        })
        .await;
        state.agents.workers.lock().await.remove(&id);
    });
    Ok(())
}
async fn run_queue(state: &AppState, id: &str, mut cancel: watch::Receiver<bool>) -> AppResult<()> {
    loop {
        if *cancel.borrow() {
            return Ok(());
        }
        let snapshot = change(state, id, |a| {
            for message in a["messages"].as_array_mut().unwrap() {
                if message["delivery"] == "queued" {
                    message["delivery"] = json!("processing");
                    message["readAt"] = json!(Utc::now().to_rfc3339());
                }
            }
            for f in a["followUps"].as_array_mut().unwrap() {
                if f["status"] == "ready" {
                    f["status"] = json!("processing");
                }
            }
            Ok(())
        })
        .await?;
        let current: Vec<_> = snapshot["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["delivery"] == "processing")
            .cloned()
            .collect();
        let background: Vec<_> = snapshot["followUps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["status"] == "processing")
            .cloned()
            .collect();
        if current.is_empty() && background.is_empty() {
            return Ok(());
        }
        let requested = current
            .iter()
            .rev()
            .find_map(|m| m["requestedAccountId"].as_str())
            .or(snapshot["accountId"].as_str());
        let mut account_id = choose_account(state, requested, &HashSet::new()).await?;
        change(state, id, |a| {
            a["accountId"] = json!(account_id);
            Ok(())
        })
        .await?;
        let mut excluded = HashSet::new();
        let result = loop {
            let latest = state.agents.get(id).await?;
            let result = tokio::select! {
                result = run_turn(state, id, &latest, &current, &background, &account_id) => result,
                _ = cancel.changed() => Err(AppError::Conflict("Agent stopped".into()))
            };
            if !*cancel.borrow()
                && result
                    .as_ref()
                    .err()
                    .is_some_and(|e| quota_error(&e.to_string()))
            {
                excluded.insert(account_id.clone());
                if let Ok(next) = choose_account(state, None, &excluded).await {
                    account_id = next;
                    change(state, id, |a| {
                        a["accountId"] = json!(account_id);
                        a["typing"] = json!(false);
                        Ok(())
                    })
                    .await?;
                    continue;
                }
            }
            break result;
        };
        let success = result.is_ok();
        let stopped = *cancel.borrow();
        change(state, id, |a| {
            for message in a["messages"].as_array_mut().unwrap() {
                if current.iter().any(|m| m["id"] == message["id"]) {
                    message["delivery"] = json!(if stopped { "cancelled" } else { "handled" });
                }
            }
            for followup in a["followUps"].as_array_mut().unwrap() {
                if background.iter().any(|f| f["id"] == followup["id"])
                    && followup["status"] != "cancelled"
                {
                    if success {
                        followup["lastDeliveredAt"] = json!(Utc::now().to_rfc3339());
                        if let Some(minutes) = followup["intervalMinutes"].as_i64() {
                            followup["status"] = json!("waiting");
                            followup["dueAt"] = json!(
                                (Utc::now() + chrono::Duration::minutes(minutes)).to_rfc3339()
                            );
                        } else {
                            followup["status"] = json!("completed");
                        }
                    } else {
                        followup["status"] = json!("failed");
                        followup["error"] = json!(result.as_ref().unwrap_err().to_string());
                    }
                }
            }
            Ok(())
        })
        .await?;
        result?;
    }
}
async fn choose_account(
    state: &AppState,
    requested: Option<&str>,
    excluded: &HashSet<String>,
) -> AppResult<String> {
    let accounts = documents(&state.db, "accounts").await?;
    if let Some(id) = requested {
        if !excluded.contains(id)
            && accounts
                .iter()
                .any(|a| a["id"] == id && a["status"] == "CONNECTED")
        {
            return Ok(id.into());
        }
    }
    let mut candidates = Vec::new();
    for account in accounts.iter().filter(|a| a["status"] == "CONNECTED") {
        let id = account["id"].as_str().unwrap();
        if excluded.contains(id) {
            continue;
        }
        if let Ok(limits) = providers::limits(state, id).await {
            let capacity = remaining_capacity(&limits);
            if capacity > 0.0 {
                candidates.push((capacity, id.to_owned()));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
    candidates
        .first()
        .map(|a| a.1.clone())
        .or_else(|| {
            if excluded.is_empty() {
                accounts
                    .iter()
                    .find(|a| a["status"] == "CONNECTED")
                    .and_then(|a| a["id"].as_str())
                    .map(str::to_owned)
            } else {
                None
            }
        })
        .ok_or_else(|| {
            AppError::Conflict("Connect a Codex account with available quota in Providers".into())
        })
}
fn remaining_capacity(limits: &Value) -> f64 {
    ["primary", "secondary"]
        .iter()
        .filter_map(|key| limits["rateLimits"][*key]["usedPercent"].as_f64())
        .map(|used| 100.0 - used)
        .reduce(f64::min)
        .unwrap_or(0.0)
}
async fn run_turn(
    state: &AppState,
    id: &str,
    snapshot: &Value,
    current: &[Value],
    background: &[Value],
    account_id: &str,
) -> AppResult<()> {
    let account = document(&state.db, "accounts", account_id).await?;
    let home = providers::account_home(&state.providers, &account)?;
    let client = CodexClient::for_account(&home, true).await?;
    let result = run_turn_with_client(state, id, snapshot, current, background, &client).await;
    client.shutdown().await;
    result
}

async fn run_turn_with_client(
    state: &AppState,
    id: &str,
    snapshot: &Value,
    current: &[Value],
    background: &[Value],
    client: &CodexClient,
) -> AppResult<()> {
    let mut notifications = client.subscribe();
    let tools: Value = serde_json::from_str(include_str!("agent-tools.json"))?;
    let config = client
        .request("config/read", json!({"includeLayers":false}))
        .await?;
    let servers = config
        .pointer("/config/mcp_servers")
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .keys()
                .map(|name| (name.clone(), json!({"command":"codex","enabled":false})))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    let cwd = state
        .providers
        .home
        .parent()
        .unwrap_or(&state.providers.home)
        .join("assistant-runtime")
        .join(id);
    tokio::fs::create_dir_all(&cwd).await?;
    let thread = client.request("thread/start", json!({
        "cwd":cwd, "ephemeral":true, "approvalPolicy":"never", "sandbox":"read-only",
        "baseInstructions":include_str!("agent-instructions.txt"),
        "developerInstructions":"Only use supplied Boosted tools. Do not use shell, filesystem, web, MCP or delegation tools.",
        "dynamicTools":tools,
        "config":{"features.shell_tool":false,"features.apply_patch_tool":false,"features.multi_agent":false,"web_search":"disabled","mcp_servers":servers}
    })).await?;
    let thread_id = thread
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Codex did not create the agent thread".into()))?
        .to_owned();
    let mut model_profile = snapshot["profile"].clone();
    if model_profile.get("avatar").is_some() {
        model_profile.as_object_mut().unwrap().remove("avatar");
        model_profile["hasAvatar"] = json!(true);
    }
    let history: Vec<_> = snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .take(120)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|mut message| {
            if let Some(content) = message["content"].as_str() {
                message["content"] = json!(
                    content
                        .chars()
                        .rev()
                        .take(8000)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<String>()
                );
            }
            if let Some(attachments) = message["attachments"].as_array_mut() {
                for attachment in attachments {
                    attachment.as_object_mut().unwrap().remove("dataUrl");
                }
            }
            if let Some(actions) = message["actions"].as_array_mut() {
                for action in actions {
                    if let Some(result) = action["result"].as_str() {
                        action["result"] = json!(result.chars().take(2000).collect::<String>());
                    }
                }
            }
            message
        })
        .collect();
    let mut visual = Vec::new();
    let mut available_images = Vec::new();
    let mut attachment_context = Vec::new();
    for message in current {
        if let Some(attachments) = message["attachments"].as_array() {
            for attachment in attachments {
                if attachment["kind"] == "image" {
                    let description = json!({"id":attachment["id"],"name":attachment["name"]});
                    available_images.push(description.clone());
                    visual.push(
                        json!({"type":"text","text":format!("Attached image: {description}")}),
                    );
                    visual.push(json!({"type":"image","url":attachment["dataUrl"]}));
                } else {
                    let decoded = attachment["dataUrl"]
                        .as_str()
                        .and_then(|s| s.split_once(','))
                        .and_then(|(_, data)| STANDARD.decode(data).ok());
                    let contents = decoded
                        .as_ref()
                        .and_then(|bytes| std::str::from_utf8(bytes).ok())
                        .map(|text| text.chars().take(20_000).collect::<String>());
                    attachment_context.push(json!({"id":attachment["id"],"name":attachment["name"],"text":contents,"unreadable":contents.is_none()}));
                }
            }
        }
    }
    let original_messages: Vec<_> = snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| {
            background.iter().any(|event| {
                event["sourceMessageIds"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&message["id"]))
            })
        })
        .map(|message| json!({"id":message["id"],"content":message["content"]}))
        .collect();
    let prompt = json!({
        "savedProfile":model_profile,"currentTime":Utc::now().to_rfc3339(),
        "userTimeZone":snapshot["timeZone"].as_str().unwrap_or("UTC"),
        "conversationHistory":history,"currentUserMessages":current.iter()
            .map(|message|json!({"id":message["id"],"content":message["content"]})).collect::<Vec<_>>(),
        "originalUserMessages":original_messages,"backgroundEvents":background,
        "availableImages":available_images,"attachmentContext":attachment_context,
        "recoveryInstructions":"Inspect saved successful actions and already sent replies. Never repeat them after a retry or server restart."
    });
    let mut input = vec![json!({"type":"text","text":prompt.to_string()})];
    input.extend(visual);
    client
        .request(
            "turn/start",
            json!({"threadId":thread_id,"input":input,
        "approvalPolicy":"never","sandboxPolicy":{"type":"readOnly","networkAccess":false}}),
        )
        .await?;
    let mut calls = 0;
    let mut call_results: HashMap<String, Value> = HashMap::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    loop {
        let event = match tokio::time::timeout_at(deadline, notifications.recv()).await {
            Ok(Ok(event)) => event,
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                return Err(AppError::Internal(
                    "Agent event stream overflowed. Completed actions are saved".into(),
                ));
            }
            Ok(Err(error)) => return Err(AppError::Internal(error.to_string())),
            Err(_) => {
                return Err(AppError::Internal(
                    "Agent timed out. Completed actions are saved".into(),
                ));
            }
        };
        let params = &event["params"];
        if params["threadId"] != thread_id {
            continue;
        }
        match event["method"].as_str().unwrap_or_default() {
            "item/tool/call" => {
                if current.is_empty() && !background.is_empty() {
                    let latest = state.agents.get(id).await?;
                    let cancelled = background.iter().all(|event| {
                        latest["followUps"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|followup| followup["id"] == event["id"])
                            .is_some_and(|followup| followup["status"] == "cancelled")
                    });
                    if cancelled {
                        return Err(AppError::Conflict("Follow-up cancelled".into()));
                    }
                }
                let call_id = params["callId"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| event["id"].to_string());
                let response = if let Some(previous) = call_results.get(&call_id) {
                    previous.clone()
                } else {
                    calls += 1;
                    let result = if calls > 24 {
                        Err(AppError::Conflict(
                            "Action limit reached. Ask the user to continue".into(),
                        ))
                    } else {
                        execute_tool(
                            state,
                            id,
                            params["tool"].as_str().unwrap_or_default(),
                            &params["arguments"],
                            &call_id,
                            current,
                        )
                        .await
                    };
                    let response = match result {
                        Ok(value) => {
                            json!({"success":true,"contentItems":[{"type":"inputText","text":value.to_string()}]})
                        }
                        Err(error) => {
                            json!({"success":false,"contentItems":[{"type":"inputText","text":json!({"error":error.to_string()}).to_string()}]})
                        }
                    };
                    call_results.insert(call_id, response.clone());
                    response
                };
                client.respond(event["id"].clone(), response).await?;
            }
            "turn/completed" => {
                let status = params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if status == "failed" || status == "interrupted" {
                    return Err(AppError::Internal(
                        params
                            .pointer("/turn/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("Agent stopped")
                            .into(),
                    ));
                }
                return Ok(());
            }
            _ => {}
        }
    }
}
async fn send_agent_reply(
    state: &AppState,
    id: &str,
    content: &str,
    current: &[Value],
) -> AppResult<Value> {
    let message_id = Uuid::new_v4().to_string();
    let agent=change(state,id,|agent| {
        let follow_up_ids:Vec<_>=agent["followUps"].as_array().unwrap().iter().filter(|f|f["status"]=="processing").map(|f|f["id"].clone()).collect();
        let reply=json!({"id":message_id,"role":"assistant","content":content,
            "assistantName":agent["profile"]["name"],"createdAt":Utc::now().to_rfc3339(),
            "inReplyTo":current.iter().map(|message|message["id"].clone()).collect::<Vec<_>>(),"followUpIds":follow_up_ids});
        agent["messages"].as_array_mut().unwrap().push(reply);
        agent["typing"]=json!(false);Ok(())
    }).await?;
    state.emit("assistant.message",json!({"agentId":id,"messageId":message_id,"assistantName":agent["profile"]["name"],"content":content,"proactive":current.is_empty()}));
    Ok(json!({"messageId":message_id}))
}
async fn execute_tool(
    state: &AppState,
    id: &str,
    name: &str,
    args: &Value,
    call_id: &str,
    current: &[Value],
) -> AppResult<Value> {
    let specs: Value = serde_json::from_str(include_str!("agent-tools.json"))?;
    let spec = specs
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .ok_or_else(|| AppError::BadRequest("Unknown agent tool".into()))?;
    let properties = spec["inputSchema"]["properties"].as_object().unwrap();
    let fields = args
        .as_object()
        .ok_or_else(|| AppError::BadRequest("Tool arguments must be an object".into()))?;
    if fields.keys().any(|key| !properties.contains_key(key)) {
        return Err(AppError::BadRequest("Unexpected tool argument".into()));
    }
    if let Some(required) = spec["inputSchema"]["required"].as_array() {
        for key in required {
            if !fields.contains_key(key.as_str().unwrap()) {
                return Err(AppError::BadRequest(format!(
                    "{} is required",
                    key.as_str().unwrap()
                )));
            }
        }
    }
    for (key, value) in fields {
        if let Some(kind) = properties[key]["type"].as_str() {
            let valid = match kind {
                "string" => value.is_string(),
                "boolean" => value.is_boolean(),
                "integer" => value.is_i64(),
                "number" => value.is_number(),
                "array" => value.is_array(),
                "object" => value.is_object(),
                _ => true,
            };
            if !valid {
                return Err(AppError::BadRequest(format!("Invalid {key}")));
            }
        }
    }
    let conversational = matches!(name, "set_typing" | "send_agent_message");
    let receipt_id = Uuid::new_v4().to_string();
    if !conversational {
        change(state,id,|a|{a["typing"]=json!(false);let assistant_name=a["profile"]["name"].clone();a["messages"].as_array_mut().unwrap().push(json!({"id":receipt_id,"role":"assistant","content":"","assistantName":assistant_name,"createdAt":Utc::now().to_rfc3339(),"actions":[{"id":call_id,"tool":name,"arguments":args,"status":"running"}]}));Ok(())}).await?;
    }
    let result = tool_action(state, id, name, args, current).await;
    if !conversational {
        change(state, id, |a| {
            let receipt = a["messages"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|m| m["id"] == receipt_id)
                .unwrap();
            let action = &mut receipt["actions"][0];
            action["status"] = json!(if result.is_ok() {
                "completed"
            } else {
                "failed"
            });
            action["result"] = json!(match &result {
                Ok(value) => value.to_string(),
                Err(error) => json!({"error":error.to_string()}).to_string(),
            });
            if let Ok(value) = &result {
                for key in ["chatId", "workingDirectory"] {
                    if let Some(v) = value.get(key) {
                        action[key] = v.clone();
                    }
                }
            }
            Ok(())
        })
        .await?;
    }
    result
}
async fn tool_action(
    state: &AppState,
    id: &str,
    name: &str,
    args: &Value,
    current: &[Value],
) -> AppResult<Value> {
    let required = |field: &str, limit| text(args, field, limit);
    match name {
        "set_typing" => {
            let typing = args["typing"]
                .as_bool()
                .ok_or_else(|| AppError::BadRequest("typing is required".into()))?;
            change(state, id, |a| {
                a["typing"] = json!(typing);
                Ok(())
            })
            .await?;
            Ok(json!({"typing":typing}))
        }
        "send_agent_message" => {
            if state.agents.get(id).await?["typing"] != true {
                return Err(AppError::Conflict("Call set_typing(true) before composing each message, then retry send_agent_message".into()));
            }
            send_agent_reply(state, id, &required("content", 1200)?, current).await
        }
        "get_profile" => {
            let agent = state.agents.get(id).await?;
            Ok(
                json!({"profile":agent["profile"],"defaults":{"name":"Pock","personality":DEFAULT_PERSONALITY}}),
            )
        }
        "update_profile" => {
            if args.get("name").is_none() && args.get("personality").is_none() {
                return Err(AppError::BadRequest("Provide a name or personality".into()));
            }
            let name = args.get("name").map(|_| required("name", 80)).transpose()?;
            let personality = args
                .get("personality")
                .map(|_| required("personality", 2000))
                .transpose()?;
            let agent = change(state, id, |a| {
                if let Some(name) = name {
                    a["profile"]["name"] =
                        json!(name.split_whitespace().collect::<Vec<_>>().join(" "));
                }
                if let Some(personality) = personality {
                    a["profile"]["personality"] = json!(personality);
                }
                Ok(())
            })
            .await?;
            Ok(json!({"profile":agent["profile"]}))
        }
        "generate_avatar" => {
            let avatar = generate_avatar(args)?;
            let agent = change(state, id, |a| {
                a["profile"]["avatar"] = json!(avatar);
                Ok(())
            })
            .await?;
            Ok(
                json!({"name":agent["profile"]["name"],"avatarUpdated":true,"format":"svg","width":512,"height":512}),
            )
        }
        "list_workspaces" => Ok(json!(
            state
                .db
                .projects()
                .await?
                .iter()
                .map(|p| json!({"id":p.id,"name":p.name,"path":p.repo_path}))
                .collect::<Vec<_>>()
        )),
        "list_chats" => {
            let Json(chats) = list_codex_chats(
                State(state.clone()),
                Query(CodexChatListQuery {
                    cwd: args["workingDirectory"].as_str().map(str::to_owned),
                }),
            )
            .await?;
            let mut list = Vec::new();
            for chat in chats {
                let meta = document(&state.db, "provider-chats", &chat.id)
                    .await
                    .unwrap_or(json!({}));
                list.push(json!({"id":chat.id,"title":chat.title,"workingDirectory":chat.cwd,"status":if state.active_codex_turns.read().await.contains_key(&chat.id){"RUNNING"}else{"IDLE"},"accountId":meta["accountId"],"autoRotateAccount":meta["autoRotateAccount"]}));
            }
            Ok(json!(list))
        }
        "read_chat" => {
            let chat_id = required("chatId", 200)?;
            let Json(thread) =
                read_codex_chat(State(state.clone()), AxumPath(chat_id.clone())).await?;
            let meta = document(&state.db, "provider-chats", &chat_id)
                .await
                .unwrap_or(json!({}));
            Ok(
                json!({"chatId":chat_id,"workingDirectory":thread.chat.cwd,"chat":thread.chat,"settings":meta,"messages":thread.messages.into_iter().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>()}),
            )
        }
        "list_accounts" => {
            let Json(accounts) = providers::list_accounts(State(state.clone())).await?;
            let mut list = Vec::new();
            for account in accounts {
                let limits = if account["status"] == "CONNECTED" {
                    providers::limits(state, account["id"].as_str().unwrap())
                        .await
                        .ok()
                } else {
                    None
                };
                list.push(json!({"id":account["id"],"displayName":account["displayName"],"providerId":account["providerId"],"status":account["status"],"limits":limits.and_then(|l|l.get("rateLimits").cloned())}));
            }
            Ok(json!(list))
        }
        "schedule_follow_up" => {
            let due = required("dueAt", 100)?;
            let timestamp = chrono::DateTime::parse_from_rfc3339(&due).map_err(|_| {
                AppError::BadRequest("dueAt needs an ISO timestamp with a timezone".into())
            })?;
            if timestamp <= Utc::now() {
                return Err(AppError::BadRequest("dueAt must be in the future".into()));
            }
            let interval = args["intervalMinutes"].as_i64();
            if interval.is_some_and(|v| !(1..=525600).contains(&v)) {
                return Err(AppError::BadRequest("Invalid follow-up interval".into()));
            }
            add_followup(state,id,json!({"kind":"schedule","instructions":required("instructions",4000)?,"dueAt":timestamp.to_rfc3339(),"intervalMinutes":interval,"sourceMessageIds":current.iter().map(|m|m["id"].clone()).collect::<Vec<_>>() })).await
        }
        "list_follow_ups" => Ok(state.agents.get(id).await?["followUps"].clone()),
        "cancel_follow_up" => {
            let followup_id = required("followUpId", 200)?;
            let Json(agent) = cancel_followup(
                State(state.clone()),
                AxumPath((id.into(), followup_id.clone())),
            )
            .await?;
            Ok(agent["followUps"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["id"] == followup_id)
                .unwrap()
                .clone())
        }
        "watch_chat" => {
            let chat_id = required("chatId", 200)?;
            let run_id = match args["runId"].as_str() {
                Some(id) => id.to_owned(),
                None => match state.active_codex_turns.read().await.get(&chat_id).cloned() {
                    Some(id) => id,
                    None => {
                        let result = providers::client_for_thread(state, &chat_id)
                            .await?
                            .request(
                                "thread/read",
                                json!({"threadId":chat_id,"includeTurns":true}),
                            )
                            .await?;
                        result
                            .pointer("/thread/turns")
                            .and_then(Value::as_array)
                            .and_then(|turns| turns.last())
                            .and_then(|turn| turn["id"].as_str())
                            .ok_or_else(|| {
                                AppError::Conflict("This chat has no coding run to watch".into())
                            })?
                            .into()
                    }
                },
            };
            add_followup(state,id,json!({"kind":"run","chatId":chat_id,"runId":run_id,"instructions":required("instructions",4000)?,"sourceMessageIds":current.iter().map(|m|m["id"].clone()).collect::<Vec<_>>() })).await
        }
        "create_chat" => {
            let directory = required("workingDirectory", 4000)?;
            if !state
                .db
                .projects()
                .await?
                .iter()
                .any(|p| p.repo_path == directory)
            {
                return Err(AppError::BadRequest(
                    "Open this project in Boosted before creating its chat".into(),
                ));
            }
            let account_id = required("accountId", 200)?;
            let account = document(&state.db, "accounts", &account_id).await?;
            if account["status"] != "CONNECTED" {
                return Err(AppError::Conflict("Connect this account first".into()));
            }
            let client = state.providers.client(&state.db, &account_id).await?;
            let response=client.request("thread/start",json!({"cwd":directory,"model":account["runtimeDefaults"]["model"],"approvalPolicy":"never","sandbox":"read-only","serviceName":"boosted","config":{"personality":account["settings"]["personality"].as_str().unwrap_or("pragmatic")}})).await?;
            let chat_id = response
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("Codex returned no thread".into()))?
                .to_owned();
            let chat = json!({"id":chat_id,"title":required("title",200)?,"accountId":account_id,"workingDirectory":directory,"autoRotateAccount":args["autoRotateAccount"].as_bool().unwrap_or(false),"runtimeDefaults":account["runtimeDefaults"],"createdAt":Utc::now().to_rfc3339()});
            save_document(&state.db, "provider-chats", &chat).await?;
            state
                .started_codex_threads
                .write()
                .await
                .insert(chat_id.clone(), response);
            let _ = client
                .request(
                    "thread/name/set",
                    json!({"threadId":chat_id,"name":chat["title"]}),
                )
                .await;
            let mut result = json!({"chatId":chat_id,"workingDirectory":directory,"chat":chat});
            if let Some(prompt) = args["prompt"].as_str().filter(|s| !s.trim().is_empty()) {
                match dispatch_chat(
                    state,
                    &chat_id,
                    prompt,
                    args["watch"].as_bool().unwrap_or(true),
                    id,
                    current,
                )
                .await
                {
                    Ok(run) => {
                        result["runId"] = run["runId"].clone();
                        if let Some(f) = run.get("followUpId") {
                            result["followUpId"] = f.clone();
                        }
                    }
                    Err(error) => result["dispatchError"] = json!(error.to_string()),
                }
            }
            state.emit("provider-chats.updated", json!({"chatId":chat_id}));
            Ok(result)
        }
        "send_message" => {
            let chat_id = required("chatId", 200)?;
            let content = required("content", 32_000)?;
            if let Some(turn_id) = state.active_codex_turns.read().await.get(&chat_id).cloned() {
                if args["steer"] == true {
                    let result=providers::client_for_thread(state,&chat_id).await?.request("turn/steer",json!({"threadId":chat_id,"expectedTurnId":turn_id,"input":[{"type":"text","text":content}]})).await?;
                    return Ok(
                        json!({"chatId":chat_id,"runId":turn_id,"status":"RUNNING","result":result}),
                    );
                }
                let queued = json!({"id":Uuid::new_v4().to_string(),"chatId":chat_id,"content":content,"agentId":id,"watch":args["watch"].as_bool().unwrap_or(true),"current":current,"createdAt":Utc::now().to_rfc3339()});
                save_document(&state.db, "chat-queue", &queued).await?;
                return Ok(json!({"chatId":chat_id,"runId":queued["id"],"status":"QUEUED"}));
            }
            dispatch_chat(
                state,
                &chat_id,
                &content,
                args["watch"].as_bool().unwrap_or(true),
                id,
                current,
            )
            .await
        }
        "stop_chat" => {
            let chat_id = required("chatId", 200)?;
            stop_codex_turn(State(state.clone()), AxumPath(chat_id.clone())).await?;
            Ok(json!({"chatId":chat_id,"status":"CANCELLED"}))
        }
        "move_chat" => {
            let chat_id = required("chatId", 200)?;
            let account_id = move_chat(state, &chat_id, args["accountId"].as_str()).await?;
            Ok(json!({"chatId":chat_id,"accountId":account_id}))
        }
        "set_failover" => {
            let chat_id = required("chatId", 200)?;
            let mut chat = chat_metadata(state, &chat_id).await?;
            chat["autoRotateAccount"] = json!(
                args["enabled"]
                    .as_bool()
                    .ok_or_else(|| AppError::BadRequest("enabled is required".into()))?
            );
            save_document(&state.db, "provider-chats", &chat).await?;
            Ok(json!({"chatId":chat_id,"chat":chat}))
        }
        "fork_chat" => {
            let original = required("chatId", 200)?;
            let client = providers::client_for_thread(state, &original).await?;
            let response = client
                .request("thread/fork", json!({"threadId":original}))
                .await?;
            let chat_id = response
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("No forked thread".into()))?
                .to_owned();
            if let Ok(mut chat) = document(&state.db, "provider-chats", &original).await {
                chat["id"] = json!(chat_id);
                save_document(&state.db, "provider-chats", &chat).await?;
            }
            let chat = codex_chat(&response["thread"]);
            state
                .started_codex_threads
                .write()
                .await
                .insert(chat_id.clone(), response);
            Ok(json!({"chatId":chat_id,"workingDirectory":chat.cwd,"chat":chat}))
        }
        "rename_chat" => {
            let chat_id = required("chatId", 200)?;
            if state.active_codex_turns.read().await.contains_key(&chat_id) {
                return Err(AppError::Conflict(
                    "Wait for this chat to finish before renaming it".into(),
                ));
            }
            let title = required("title", 200)?;
            providers::client_for_thread(state, &chat_id)
                .await?
                .request("thread/name/set", json!({"threadId":chat_id,"name":title}))
                .await?;
            if let Ok(mut chat) = document(&state.db, "provider-chats", &chat_id).await {
                chat["title"] = json!(title);
                save_document(&state.db, "provider-chats", &chat).await?;
            }
            Ok(json!({"chatId":chat_id,"title":title}))
        }
        _ => Err(AppError::BadRequest("Unknown agent tool".into())),
    }
}
async fn add_followup(state: &AppState, id: &str, mut followup: Value) -> AppResult<Value> {
    followup["id"] = json!(Uuid::new_v4().to_string());
    followup["createdAt"] = json!(Utc::now().to_rfc3339());
    followup["status"] = json!("waiting");
    let mut result = followup.clone();
    change(state, id, |a| {
        if followup["kind"] == "run" {
            if let Some(existing) = a["followUps"].as_array().unwrap().iter().find(|f| {
                f["kind"] == "run"
                    && f["runId"] == followup["runId"]
                    && f["chatId"] == followup["chatId"]
                    && f["status"] != "cancelled"
            }) {
                result = existing.clone();
                return Ok(());
            }
        }
        a["followUps"].as_array_mut().unwrap().push(followup);
        Ok(())
    })
    .await?;
    Ok(result)
}
async fn dispatch_chat(
    state: &AppState,
    chat_id: &str,
    content: &str,
    watch: bool,
    agent_id: &str,
    current: &[Value],
) -> AppResult<Value> {
    let defaults = providers::runtime_defaults(state, chat_id)
        .await?
        .unwrap_or(json!({"accessMode":"fullAccess","approvalPolicy":"never"}));
    let permission = defaults["accessMode"]
        .as_str()
        .or(defaults["permissionMode"].as_str())
        .unwrap_or("default");
    let access = match permission {
        "fullAccess" | "danger-full-access" => "fullAccess",
        "readOnly" | "read-only" => "readOnly",
        _ => "workspaceWrite",
    };
    let (_, Json(run)) = send_codex_message(
        State(state.clone()),
        AxumPath(chat_id.into()),
        Json(CodexMessageCreate {
            message: content.into(),
            client_message_id: None,
            model: defaults["model"].as_str().map(str::to_owned),
            reasoning_effort: defaults["reasoningEffort"].as_str().map(str::to_owned),
            approval_policy: Some(
                defaults["approvalPolicy"]
                    .as_str()
                    .unwrap_or(if matches!(permission, "default" | "askForApproval") {
                        "on-request"
                    } else {
                        "never"
                    })
                    .into(),
            ),
            service_tier: defaults["serviceTier"].as_str().map(str::to_owned),
            access_mode: Some(access.into()),
            attachment_ids: vec![],
        }),
    )
    .await?;
    let mut result = json!({"chatId":run.thread_id,"runId":run.turn_id,"status":"RUNNING"});
    if watch {
        let followup=add_followup(state,agent_id,json!({"kind":"run","chatId":run.thread_id,"runId":run.turn_id,"instructions":"Check the coding run's actual result and report useful progress, success or blockers to the user.","sourceMessageIds":current.iter().map(|m|m["id"].clone()).collect::<Vec<_>>() })).await?;
        result["followUpId"] = followup["id"].clone();
    }
    save_document(&state.db,"coding-requests",&json!({"id":run.turn_id,"chatId":run.thread_id,"content":content,"agentId":agent_id,"current":current})).await?;
    Ok(result)
}
async fn move_chat(state: &AppState, chat_id: &str, requested: Option<&str>) -> AppResult<String> {
    let chat_lock = state.providers.chat_lock(chat_id).await;
    let _chat_guard = chat_lock.lock().await;
    if state.active_codex_turns.read().await.contains_key(chat_id) {
        return Err(AppError::Conflict(
            "Wait for this chat to finish or explicitly ask to stop it before moving it".into(),
        ));
    }
    let mut chat = chat_metadata(state, chat_id).await?;
    let source_id = chat["accountId"].as_str().unwrap_or_default();
    let target_id = if let Some(id) = requested {
        let account = document(&state.db, "accounts", id).await?;
        if account["status"] != "CONNECTED" {
            return Err(AppError::Conflict("Target account is not connected".into()));
        }
        id.into()
    } else {
        choose_account(state, None, &HashSet::from([source_id.to_owned()])).await?
    };
    if source_id == target_id {
        return Ok(target_id);
    }
    let target = document(&state.db, "accounts", &target_id).await?;
    let target_home = providers::account_home(&state.providers, &target)?;
    let source_home = if source_id.is_empty() {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs_next::home_dir().unwrap_or_default().join(".codex"))
    } else {
        providers::account_home(
            &state.providers,
            &document(&state.db, "accounts", source_id).await?,
        )?
    };
    let source_client = providers::client_for_thread(state, chat_id).await?;
    let thread = source_client
        .request(
            "thread/read",
            json!({"threadId":chat_id,"includeTurns":false}),
        )
        .await?;
    let rollout=thread.pointer("/thread/path").and_then(Value::as_str).ok_or_else(||AppError::Conflict("Codex has not persisted this chat yet; try moving it after its first completed turn".into()))?;
    let path = PathBuf::from(rollout);
    let canonical = path.canonicalize()?;
    let root = source_home.canonicalize()?;
    let relative = canonical
        .strip_prefix(&root)
        .map_err(|_| AppError::BadRequest("Chat history is outside its account home".into()))?;
    let destination = target_home.join(relative);
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
        providers::private_directory(parent).await?;
    }
    tokio::fs::copy(&canonical, &destination).await?;
    let target_client = state.providers.client(&state.db, &target_id).await?;
    let resumed = target_client
        .request(
            "thread/resume",
            json!({"threadId":chat_id,"path":destination}),
        )
        .await?;
    chat["accountId"] = json!(target_id);
    save_document(&state.db, "provider-chats", &chat).await?;
    state
        .started_codex_threads
        .write()
        .await
        .insert(chat_id.into(), resumed);
    state.emit("provider-chats.updated", json!({"chatId":chat_id}));
    Ok(target_id)
}
fn generate_avatar(args: &Value) -> AppResult<String> {
    fn color(s: &str) -> bool {
        s == "none"
            || (s.starts_with('#')
                && matches!(s.len(), 4 | 7 | 9)
                && s[1..].chars().all(|c| c.is_ascii_hexdigit()))
    }
    let background = text(args, "background", 9)?;
    if !color(&background) {
        return Err(AppError::BadRequest("Use hex colors for the avatar".into()));
    }
    let shapes = args["shapes"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(|| AppError::BadRequest("Provide 1–64 avatar shapes".into()))?;
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><rect width=\"512\" height=\"512\" fill=\"{background}\"/>"
    );
    for shape in shapes {
        let kind = shape["type"].as_str().unwrap_or_default();
        if !matches!(
            kind,
            "circle" | "ellipse" | "rect" | "line" | "path" | "polygon"
        ) {
            return Err(AppError::BadRequest("Invalid avatar shape".into()));
        }
        svg.push_str(&format!("<{kind}"));
        for (key, value) in shape
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Invalid avatar shape".into()))?
        {
            if key == "type" {
                continue;
            }
            let attribute = if key == "strokeWidth" {
                "stroke-width"
            } else {
                key.as_str()
            };
            let content = match key.as_str() {
                "fill" | "stroke" => {
                    let s = value
                        .as_str()
                        .filter(|s| color(s))
                        .ok_or_else(|| AppError::BadRequest("Invalid avatar color".into()))?;
                    s.into()
                }
                "d" | "points" => {
                    let s = value
                        .as_str()
                        .filter(|s| {
                            s.len() <= 8000
                                && s.chars()
                                    .all(|c| c.is_ascii_alphanumeric() || " ,.-+\n\t".contains(c))
                        })
                        .ok_or_else(|| AppError::BadRequest("Invalid avatar coordinates".into()))?;
                    s.into()
                }
                "x" | "y" | "cx" | "cy" | "r" | "rx" | "ry" | "width" | "height" | "x1" | "y1"
                | "x2" | "y2" | "strokeWidth" | "opacity" => {
                    let number = value
                        .as_f64()
                        .filter(|v| v.is_finite() && v.abs() <= 2048.0)
                        .ok_or_else(|| AppError::BadRequest("Invalid avatar coordinate".into()))?;
                    number.to_string()
                }
                _ => return Err(AppError::BadRequest("Invalid avatar attribute".into())),
            };
            svg.push_str(&format!(" {attribute}=\"{content}\""));
        }
        svg.push_str("/>");
    }
    svg.push_str("</svg>");
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg)
    ))
}
pub(crate) async fn scheduler(state: AppState) {
    let mut timer = tokio::time::interval(Duration::from_secs(2));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        timer.tick().await;
        if let Err(error) = tick(&state).await {
            tracing::warn!(%error,"Agent follow-up scheduler failed");
        }
    }
}
async fn tick(state: &AppState) -> AppResult<()> {
    recover_coding_runs(state).await?;
    for queued in documents(&state.db, "chat-queue").await? {
        let chat_id = queued["chatId"].as_str().unwrap_or_default();
        if state.active_codex_turns.read().await.contains_key(chat_id) {
            continue;
        }
        let agent_id = queued["agentId"].as_str().unwrap_or_default();
        let result = dispatch_chat(
            state,
            chat_id,
            queued["content"].as_str().unwrap_or_default(),
            queued["watch"] == true,
            agent_id,
            queued["current"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )
        .await;
        sqlx::query("DELETE FROM feature_documents WHERE namespace='chat-queue' AND id=?")
            .bind(queued["id"].as_str().unwrap())
            .execute(&state.db.pool)
            .await?;
        if let Err(error) = result {
            change(state, agent_id, |a| {
                a["error"] = json!(error.to_string());
                Ok(())
            })
            .await?;
        }
    }
    let agents: Vec<_> = state.agents.states.lock().await.values().cloned().collect();
    for agent in agents {
        let id = agent["id"].as_str().unwrap();
        let mut ready = Vec::new();
        for f in agent["followUps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["status"] == "waiting")
        {
            if f["kind"] == "schedule" {
                if f["dueAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|due| due <= Utc::now())
                {
                    ready.push((f["id"].clone(), Value::Null));
                }
            } else if let Some(run_id) = f["runId"].as_str() {
                let mut outcome = document(&state.db, "run-outcomes", run_id).await.ok();
                if outcome.is_none() {
                    let chat_id = f["chatId"].as_str().unwrap_or_default();
                    if !state.active_codex_turns.read().await.contains_key(chat_id) {
                        if let Ok(client) = providers::client_for_thread(state, chat_id).await {
                            if let Ok(result) = client
                                .request(
                                    "thread/read",
                                    json!({"threadId":chat_id,"includeTurns":true}),
                                )
                                .await
                            {
                                if let Some(turn) = result
                                    .pointer("/thread/turns")
                                    .and_then(Value::as_array)
                                    .and_then(|turns| {
                                        turns.iter().find(|turn| turn["id"] == run_id)
                                    })
                                {
                                    if matches!(
                                        turn["status"].as_str(),
                                        Some("completed" | "failed" | "interrupted")
                                    ) {
                                        record_outcome(
                                            state,
                                            chat_id,
                                            run_id,
                                            &json!({"turn":turn}),
                                        )
                                        .await?;
                                        outcome =
                                            document(&state.db, "run-outcomes", run_id).await.ok();
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(outcome) = outcome {
                    if outcome.get("recoveredTo").is_none() {
                        ready.push((f["id"].clone(), outcome));
                    }
                }
            }
        }
        if !ready.is_empty() {
            change(state, id, |a| {
                for f in a["followUps"].as_array_mut().unwrap() {
                    if f["status"] == "waiting" {
                        if let Some((_, result)) = ready.iter().find(|(id, _)| *id == f["id"]) {
                            f["status"] = json!("ready");
                            f["result"] = result.clone();
                        }
                    }
                }
                Ok(())
            })
            .await?;
        }
        start_worker(state.clone(), id.into()).await?;
    }
    Ok(())
}
pub(crate) async fn record_outcome(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    params: &Value,
) -> AppResult<()> {
    let messages = params
        .pointer("/turn/items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item["type"] == "agentMessage")
                .filter_map(|item| item["text"].as_str())
                .map(|text| text.chars().take(6000).collect::<String>())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    save_document(&state.db,"run-outcomes",&json!({"id":turn_id,"chatId":thread_id,"status":params.pointer("/turn/status"),"error":params.pointer("/turn/error"),"messages":messages,"completedAt":Utc::now().to_rfc3339()})).await?;
    Ok(())
}

fn quota_error(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "usage_limit_reached",
        "usage_limit_exceeded",
        "quota",
        "rate limit",
        "rate_limit_exceeded",
        "usage limit",
    ]
    .iter()
    .any(|part| message.contains(part))
}

async fn chat_metadata(state: &AppState, chat_id: &str) -> AppResult<Value> {
    match document(&state.db, "provider-chats", chat_id).await {
        Ok(chat) => Ok(chat),
        Err(AppError::NotFound(_)) => {
            let Json(thread) =
                read_codex_chat(State(state.clone()), AxumPath(chat_id.into())).await?;
            Ok(
                json!({"id":chat_id,"title":thread.chat.title,"workingDirectory":thread.chat.cwd,"accountId":null,"autoRotateAccount":false,
                "runtimeDefaults":document(&state.db,"chat-runtime",chat_id).await.unwrap_or(json!({"accessMode":"fullAccess"}))}),
            )
        }
        Err(error) => Err(error),
    }
}
async fn recover_coding_runs(state: &AppState) -> AppResult<()> {
    for mut outcome in documents(&state.db, "run-outcomes").await? {
        if outcome["recoveryChecked"] == true || outcome["status"] != "failed" {
            continue;
        }
        let chat_id = outcome["chatId"].as_str().unwrap_or_default().to_owned();
        if state.active_codex_turns.read().await.contains_key(&chat_id) {
            continue;
        }
        outcome["recoveryChecked"] = json!(true);
        if !quota_error(&outcome["error"].to_string()) {
            save_document(&state.db, "run-outcomes", &outcome).await?;
            continue;
        }
        let chat = match document(&state.db, "provider-chats", &chat_id).await {
            Ok(chat) if chat["autoRotateAccount"] == true => chat,
            _ => {
                save_document(&state.db, "run-outcomes", &outcome).await?;
                continue;
            }
        };
        let run_id = outcome["id"].as_str().unwrap_or_default().to_owned();
        let mut request = match document(&state.db, "coding-requests", &run_id).await {
            Ok(request) => request,
            _ => {
                save_document(&state.db, "run-outcomes", &outcome).await?;
                continue;
            }
        };
        let mut excluded: HashSet<String> = request["attemptedAccounts"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        if let Some(account_id) = chat["accountId"].as_str() {
            excluded.insert(account_id.into());
        }
        let target = choose_account(state, None, &excluded).await;
        let result=async {
            let target=target?;
            move_chat(state,&chat_id,Some(&target)).await?;
            let prompt=format!("Continue the existing coding task after the previous account reached its usage limit. Inspect existing work and do not repeat completed actions. Original request: {}",request["content"].as_str().unwrap_or_default());
            let next=dispatch_chat(state,&chat_id,&prompt,false,request["agentId"].as_str().unwrap_or_default(),request["current"].as_array().map(Vec::as_slice).unwrap_or(&[])).await?;
            let next_run=next["runId"].as_str().unwrap().to_owned();
            excluded.insert(target);
            request["id"]=json!(next_run);request["attemptedAccounts"]=json!(excluded);
            save_document(&state.db,"coding-requests",&request).await?;
            let agents:Vec<_>=state.agents.states.lock().await.keys().cloned().collect();
            for id in agents {change(state,&id,|agent|{for followup in agent["followUps"].as_array_mut().unwrap(){if followup["kind"]=="run"&&followup["runId"]==run_id&&followup["status"]=="waiting"{followup["runId"]=json!(next_run);}}Ok(())}).await?;}
            outcome["recoveredTo"]=json!(next_run);Ok::<(),AppError>(())
        }.await;
        if let Err(error) = result {
            outcome["recoveryError"] = json!(error.to_string());
        }
        save_document(&state.db, "run-outcomes", &outcome).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> (tempfile::TempDir, AppState) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("test.sqlite3"))
            .await
            .unwrap();
        let agents = AgentManager::load(&db).await.unwrap();
        let (live, _) = broadcast::channel(100);
        let state = AppState {
            db,
            agents,
            providers: providers::ProviderManager::new(root.path().join("accounts")),
            codex: CodexManager::test_unavailable(),
            terminals: TerminalManager::default(),
            live,
            sequence: Arc::new(AtomicU64::new(1)),
            pending_inputs: Default::default(),
            active_codex_turns: Default::default(),
            started_codex_threads: Default::default(),
            uploads_dir: root.path().join("uploads"),
            worktrees_dir: root.path().join("worktrees"),
            updater: updater::ServerUpdater::disabled("Test"),
        };
        (root, state)
    }
    #[tokio::test]
    async fn restart_preserves_identity_and_recovers_queued_messages_and_commitments() {
        let (_root, state) = fixture().await;
        change(&state,"pock",|a|{
            a["profile"]["name"]=json!("Nova");a["status"]=json!("running");a["typing"]=json!(true);
            a["messages"]=json!([{"id":"message","role":"user","content":"Continue","delivery":"processing"}]);
            a["followUps"]=json!([{"id":"followup","kind":"schedule","status":"processing"}]);Ok(())
        }).await.unwrap();
        let restored = AgentManager::load(&state.db)
            .await
            .unwrap()
            .get("pock")
            .await
            .unwrap();
        assert_eq!(restored["profile"]["name"], "Nova");
        assert_eq!(restored["status"], "idle");
        assert_eq!(restored["messages"][0]["delivery"], "queued");
        assert_eq!(restored["followUps"][0]["status"], "ready");
        assert_eq!(restored["typing"], false);
    }
    #[tokio::test]
    async fn duplicate_delivery_is_idempotent_while_agent_is_running() {
        let (_root, state) = fixture().await;
        let (sender, _) = watch::channel(false);
        state
            .agents
            .workers
            .lock()
            .await
            .insert("pock".into(), sender);
        let input = json!({"content":"One instruction","clientMessageId":"client-message"});
        let _ = send_message(
            State(state.clone()),
            AxumPath("pock".into()),
            Json(input.clone()),
        )
        .await
        .unwrap();
        let _ = send_message(State(state.clone()), AxumPath("pock".into()), Json(input))
            .await
            .unwrap();
        assert_eq!(
            state.agents.get("pock").await.unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[tokio::test]
    async fn followups_validate_timezones_and_survive_cancellation() {
        let (_root, state) = fixture().await;
        assert!(
            tool_action(
                &state,
                "pock",
                "schedule_follow_up",
                &json!({"instructions":"Check progress","dueAt":"2027-01-01T10:00:00"}),
                &[]
            )
            .await
            .is_err()
        );
        assert!(tool_action(&state,"pock","schedule_follow_up",&json!({"instructions":"Check progress","dueAt":"2099-01-01T10:00:00Z","intervalMinutes":0}),&[]).await.is_err());
        let followup=tool_action(&state,"pock","schedule_follow_up",&json!({"instructions":"Check progress","dueAt":"2099-01-01T10:00:00+07:00","intervalMinutes":60}),&[]).await.unwrap();
        let _ = cancel_followup(
            State(state.clone()),
            AxumPath(("pock".into(), followup["id"].as_str().unwrap().into())),
        )
        .await
        .unwrap();
        let restored = AgentManager::load(&state.db)
            .await
            .unwrap()
            .get("pock")
            .await
            .unwrap();
        assert_eq!(restored["followUps"][0]["status"], "cancelled");
        assert_eq!(restored["followUps"][0]["intervalMinutes"], 60);
    }
    #[tokio::test]
    async fn messages_require_typing_and_application_tools_reject_unexpected_fields() {
        let (_root, state) = fixture().await;
        assert!(
            tool_action(
                &state,
                "pock",
                "send_agent_message",
                &json!({"content":"Hello"}),
                &[]
            )
            .await
            .is_err()
        );
        assert!(
            execute_tool(
                &state,
                "pock",
                "update_profile",
                &json!({"name":"Nova","shell":"rm"}),
                "call",
                &[]
            )
            .await
            .is_err()
        );
        assert!(
            execute_tool(&state, "pock", "shell", &json!({}), "call", &[])
                .await
                .is_err()
        );
        let avatar=generate_avatar(&json!({"background":"#123456","shapes":[{"type":"circle","cx":256,"cy":256,"r":200,"fill":"#abcdef"}]})).unwrap();
        assert!(avatar.starts_with("data:image/svg+xml;base64,"));
        assert!(generate_avatar(&json!({"background":"#123456","shapes":[{"type":"path","d":"\"/><script>alert(1)</script>"}]})).is_err());
    }
    #[tokio::test]
    async fn account_homes_are_isolated_and_duplicate_locations_are_rejected() {
        let (_root, state) = fixture().await;
        let admin = AuthUser {
            id: "admin".into(),
            username: "admin".into(),
            role: "admin".into(),
        };
        let (_, Json(first)) = providers::create_account(
            State(state.clone()),
            Extension(admin.clone()),
            Json(json!({"providerId":"codex"})),
        )
        .await
        .unwrap();
        let (_, Json(second)) = providers::create_account(
            State(state.clone()),
            Extension(admin.clone()),
            Json(json!({"providerId":"codex"})),
        )
        .await
        .unwrap();
        let home = providers::account_home(&state.providers, &first).unwrap();
        assert_ne!(
            home,
            providers::account_home(&state.providers, &second).unwrap()
        );
        let result = providers::update_account(
            State(state.clone()),
            Extension(admin.clone()),
            AxumPath(second["id"].as_str().unwrap().into()),
            Json(json!({"settings":{"codexHome":home}})),
        )
        .await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
        let mut account = first.clone();
        account["settings"] = json!({"codexHome":"~/.codex"});
        assert!(providers::account_home(&state.providers, &account).is_err());
    }
    #[tokio::test]
    async fn provider_chat_defaults_preserve_approval_policy_and_explicit_chat_overrides() {
        let (_root, state) = fixture().await;
        save_document(&state.db,"provider-chats",&json!({"id":"chat","runtimeDefaults":{"permissionMode":"askForApproval","model":"account-model"}})).await.unwrap();
        let defaults = providers::runtime_defaults(&state, "chat")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(defaults["accessMode"], "workspaceWrite");
        assert_eq!(defaults["approvalPolicy"], "on-request");
        save_document(&state.db,"chat-runtime",&json!({"id":"chat","accessMode":"readOnly","approvalPolicy":"never","model":"chat-model"})).await.unwrap();
        let explicit = providers::runtime_defaults(&state, "chat")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(explicit["accessMode"], "readOnly");
        assert_eq!(explicit["model"], "chat-model");
    }
    #[tokio::test]
    async fn due_commitments_wake_once_and_cancelled_commitments_stay_cancelled() {
        let (_root, state) = fixture().await;
        let (sender, _) = watch::channel(false);
        state
            .agents
            .workers
            .lock()
            .await
            .insert("pock".into(), sender);
        change(&state,"pock",|agent|{
            agent["followUps"]=json!([
                {"id":"due","kind":"schedule","dueAt":"2020-01-01T00:00:00Z","status":"waiting"},
                {"id":"cancelled","kind":"schedule","dueAt":"2020-01-01T00:00:00Z","status":"cancelled"}
            ]);Ok(())
        }).await.unwrap();
        tick(&state).await.unwrap();
        tick(&state).await.unwrap();
        let agent = state.agents.get("pock").await.unwrap();
        assert_eq!(agent["followUps"][0]["status"], "ready");
        assert_eq!(agent["followUps"][1]["status"], "cancelled");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_stdio_transport_runs_only_application_tools_and_deduplicates_replies() {
        use std::os::unix::fs::PermissionsExt;
        let (root, state) = fixture().await;
        let script = root.path().join("fake-codex");
        std::fs::write(&script,r#"#!/usr/bin/env python3
import sys,json
stage=0
calls=[('update_profile',{'name':'Nova'},'profile'),('send_agent_message',{'content':'Should fail without typing'},'invalid'),('set_typing',{'typing':True},'typing'),('send_agent_message',{'content':'Ready to work.'},'reply'),('send_agent_message',{'content':'Ready to work.'},'reply')]
def emit(v):
 print(json.dumps(v),flush=True)
def call(i):
 name,args,call_id=calls[i]
 emit({'id':700+i,'method':'item/tool/call','params':{'threadId':'agent-thread','callId':call_id,'tool':name,'arguments':args}})
for line in sys.stdin:
 m=json.loads(line)
 method=m.get('method')
 if method=='initialize':emit({'id':m['id'],'result':{}})
 elif method=='config/read':emit({'id':m['id'],'result':{'config':{'mcp_servers':{'server.with.dots':{'command':'never-run'}}}}})
 elif method=='thread/start':
  p=m['params']
  assert p['sandbox']=='read-only' and p['ephemeral'] is True
  assert p['config']['features.shell_tool'] is False
  assert p['config']['mcp_servers']['server.with.dots']['enabled'] is False
  assert len(p['dynamicTools'])==20
  emit({'id':m['id'],'result':{'thread':{'id':'agent-thread'}}})
 elif method=='turn/start':
  assert m['params']['sandboxPolicy']['networkAccess'] is False
  emit({'id':m['id'],'result':{'turn':{'id':'turn'}}})
  emit({'method':'item/agentMessage/delta','params':{'threadId':'agent-thread','delta':'Ordinary output must stay invisible.'}})
  call(0)
 elif method is None and 'result' in m:
  if stage==1:assert m['result']['success'] is False
  else:assert m['result']['success'] is True
  stage+=1
  if stage<len(calls):call(stage)
  else:emit({'method':'turn/completed','params':{'threadId':'agent-thread','turn':{'id':'turn','status':'completed'}}})
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexClient::test_process(script, true).await.unwrap();
        let snapshot = state.agents.get("pock").await.unwrap();
        run_turn_with_client(&state, "pock", &snapshot, &[], &[], &client)
            .await
            .unwrap();
        client.shutdown().await;
        let agent = state.agents.get("pock").await.unwrap();
        assert_eq!(agent["profile"]["name"], "Nova");
        let replies: Vec<_> = agent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| !m["content"].as_str().unwrap_or_default().is_empty())
            .collect();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["content"], "Ready to work.");
        assert_eq!(agent["typing"], false);
    }
}
