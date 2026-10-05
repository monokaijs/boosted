//! Persistent PockCode agents using native, isolated Codex app-server sessions.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use providers::{document, documents, save_document, text};
use std::time::Duration;
use tokio::sync::{Mutex, watch};

const CODING_REVIEW_INSTRUCTIONS: &str = "Review this coding run against the original user request and subsequent corrections. Inspect its actual output and verification with read_run/read_chat. If authorized work is incomplete or verification fails, send a concrete follow-up in the same chat with watching enabled, then yield for its outcome. When the requested result is verified, report it for user curation. Continue later feedback in this chat. Do not retry cancelled/interrupted work or resume a stopped chat without the user requesting it.";

const DEFAULT_PERSONALITY: &str =
    "Friendly, clear, and concise. Be practical about coding work and explain blockers directly.";
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
enum AgentModel {
    #[default]
    Normal,
    Balanced,
    Deep,
}
impl AgentModel {
    fn model(self) -> &'static str {
        match self {
            Self::Normal => "gpt-6.1-sol",
            Self::Balanced => "gpt-6.1-sol",
            Self::Deep => "gpt-6-astra",
        }
    }
    fn effort(self) -> &'static str {
        match self {
            Self::Normal => "low",
            Self::Balanced => "medium",
            Self::Deep => "high",
        }
    }
}
#[derive(Default)]
struct ModelSelection {
    current: AgentModel,
    pending: Option<AgentModel>,
}
#[derive(Clone)]
struct ModelRouting {
    client: CodexClient,
    selection: Arc<Mutex<ModelSelection>>,
}
tokio::task_local! {
    static MODEL_ROUTING: ModelRouting;
}

async fn select_agent_model(args: &Value) -> AppResult<Value> {
    let requested = match text(args, "model", 200)?.as_str() {
        "gpt-6.1-sol" => AgentModel::Balanced,
        "gpt-6-astra" => AgentModel::Deep,
        _ => return Err(AppError::BadRequest("Unsupported agent model".into())),
    };
    let reason = text(args, "reason", 1000)?;
    let routing = MODEL_ROUTING
        .try_with(Clone::clone)
        .map_err(|_| AppError::Conflict("Model selection requires an active agent turn".into()))?;
    let mut selection = routing.selection.lock().await;
    if requested <= selection.current || selection.pending.is_some() {
        return Err(AppError::Conflict(
            "Select a stronger model only once per handoff".into(),
        ));
    }
    let options = load_codex_options(&routing.client).await?;
    let model = options
        .models
        .iter()
        .find(|model| model.model == requested.model())
        .ok_or_else(|| AppError::BadRequest("Requested agent model is unavailable".into()))?;
    if !model.supported_reasoning_efforts.is_empty()
        && !model
            .supported_reasoning_efforts
            .iter()
            .any(|effort| effort.id == requested.effort())
    {
        return Err(AppError::BadRequest(
            "Requested agent reasoning effort is unavailable".into(),
        ));
    }
    selection.pending = Some(requested);
    Ok(
        json!({"model":requested.model(),"reasoningEffort":requested.effort(),"reason":reason,
        "handoff":"queued","instructions":"End this turn immediately without further tools. The server will continue the same task and conversation with the selected model."}),
    )
}
#[derive(Clone, Default)]
pub(crate) struct AgentManager {
    states: Arc<Mutex<HashMap<String, Value>>>,
    workers: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    computer: computer::ComputerControl,
    prefer_direct: Arc<Mutex<HashSet<String>>>,
}
impl AgentManager {
    pub async fn load(db: &Database) -> AppResult<Self> {
        let manager = Self::default();
        for mut agent in documents(db, "agents").await? {
            agent["status"] = json!("idle");
            agent["activeGroupId"] = Value::Null;
            agent["activity"] = Value::Null;
            agent.as_object_mut().unwrap().remove("typing");
            if let Some(messages) = agent["messages"].as_array_mut() {
                for message in messages {
                    if message["delivery"] == "processing" {
                        message["delivery"] = json!("queued");
                    }
                    if let Some(actions) = message["actions"].as_array_mut() {
                        for action in actions {
                            if action["status"] == "running" {
                                action["status"] = json!("failed");
                                action["result"] = json!(json!({"error":"Server restarted before the action result was saved. Inspect live state before retrying.","resultUnknown":true}).to_string());
                            }
                        }
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
    pub(crate) async fn reserve_group(
        &self,
        id: &str,
    ) -> AppResult<Option<(watch::Sender<bool>, watch::Receiver<bool>)>> {
        let agent = self.get(id).await?;
        let direct_pending = agent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["delivery"] == "queued")
            || agent["followUps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["status"] == "ready");
        if direct_pending && self.prefer_direct.lock().await.contains(id) {
            return Ok(None);
        }
        let mut workers = self.workers.lock().await;
        if workers.contains_key(id) {
            return Ok(None);
        }
        let (sender, receiver) = watch::channel(false);
        workers.insert(id.into(), sender.clone());
        Ok(Some((sender, receiver)))
    }
    pub(crate) async fn release_group(&self, id: &str) {
        self.workers.lock().await.remove(id);
        self.prefer_direct.lock().await.insert(id.into());
    }
    pub async fn uses_account(&self, id: &str) -> bool {
        self.states
            .lock()
            .await
            .values()
            .any(|a| a["status"] == "running" && a["accountId"] == id)
    }
    pub(crate) async fn get(&self, id: &str) -> AppResult<Value> {
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
    json!({"id":id,"createdAt":now,"updatedAt":now,"profile":{"name":name,"personality":personality},"messages":[],"followUps":[],"status":"idle","activity":null,"accountId":null,"error":null})
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
fn activity_after_actions(agent: &Value) -> Value {
    let working = agent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["actions"].as_array())
        .flatten()
        .any(|action| action["status"] == "running");
    json!(if working { "working" } else { "thinking" })
}
async fn set_activity(state: &AppState, id: &str, activity: Option<&str>) -> AppResult<()> {
    if let Some(context) = groups::context() {
        return groups::activity(state, &context, activity).await;
    }
    let states = state.agents.states.lock().await;
    let agent = states
        .get(id)
        .ok_or_else(|| AppError::NotFound("Agent not found".into()))?;
    let next = if activity == Some("thinking") {
        activity_after_actions(agent)
    } else {
        json!(activity)
    };
    // Reasoning/text deltas can be frequent; publish only activity transitions.
    if agent["activity"] == next {
        return Ok(());
    }
    drop(states);
    change(state, id, |agent| {
        agent["activity"] = next;
        Ok(())
    })
    .await?;
    Ok(())
}
pub(crate) async fn list_agents(State(state): State<AppState>) -> Json<Vec<Value>> {
    let mut agents:Vec<_> = state.agents.states.lock().await.values().map(|a| {
        let last_message_at = a["messages"].as_array().and_then(|messages| messages.iter().rev().find(|message|
            message["role"] == "assistant" && message["content"].as_str().is_some_and(|content| !content.trim().is_empty())
        )).map(|message| message["createdAt"].clone()).unwrap_or(Value::Null);
        json!({"id":a["id"],"profile":a["profile"],"status":a["status"],"accountId":a["accountId"],"createdAt":a["createdAt"],"updatedAt":a["updatedAt"],"lastMessageAt":last_message_at})
    }).collect();
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
    if !groups::agent_active(&state, &id).await {
        if let Some(sender) = state.agents.workers.lock().await.get(&id) {
            let _ = sender.send(true);
        }
    }
    Ok(Json(
        change(&state, &id, |agent| {
            for message in agent["messages"].as_array_mut().unwrap() {
                if message["delivery"] == "queued" {
                    message["delivery"] = json!("cancelled");
                }
            }
            agent["activity"] = Value::Null;
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
pub(crate) fn validate_attachments(value: Option<&Value>) -> AppResult<()> {
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
    state.agents.prefer_direct.lock().await.remove(&id);
    change(&state, &id, |a| {
        a["status"] = json!("running");
        a["activity"] = json!("thinking");
        a["error"] = Value::Null;
        Ok(())
    })
    .await?;
    drop(workers);
    tokio::spawn(async move {
        let result = run_queue(&state, &id, receiver).await;
        let _ = change(&state, &id, |a| {
            a["status"] = json!("idle");
            a["activity"] = Value::Null;
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
            if a["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["delivery"] == "processing")
                || a["followUps"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|followup| followup["status"] == "processing")
            {
                a["activity"] = json!("thinking");
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
            let result = run_turn(
                state,
                id,
                &latest,
                &current,
                &background,
                &account_id,
                &mut cancel,
            )
            .await;
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
                        a["activity"] = json!("thinking");
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
                            followup["dueAt"] = json!((Utc::now()
                                + chrono::Duration::minutes(minutes))
                            .to_rfc3339());
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
        if groups::pending(state, id).await? {
            return Ok(());
        }
    }
}
pub(crate) async fn choose_account(
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
pub(crate) async fn run_turn(
    state: &AppState,
    id: &str,
    snapshot: &Value,
    current: &[Value],
    background: &[Value],
    account_id: &str,
    cancel: &mut watch::Receiver<bool>,
) -> AppResult<()> {
    let account = document(&state.db, "accounts", account_id).await?;
    let home = providers::account_home(&state.providers, &account)?;
    let client = state.providers.agent_client(&home).await?;
    let result =
        run_turn_with_client(state, id, snapshot, current, background, &client, cancel).await;
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
    cancel: &mut watch::Receiver<bool>,
) -> AppResult<()> {
    if *cancel.borrow() {
        return Err(AppError::Conflict("Agent stopped".into()));
    }
    set_activity(state, id, Some("thinking")).await?;
    let mut notifications = client.subscribe();
    let mut tools: Value = serde_json::from_str(include_str!("agent-tools.json"))?;
    let group_context = groups::context();
    if let Some(context) = &group_context {
        tools = groups::tools(tools, &context.purpose);
    }
    let mut cwd = state
        .providers
        .home
        .parent()
        .unwrap_or(&state.providers.home)
        .join("assistant-runtime")
        .join(id);
    if group_context.is_some() {
        if let Some(directory) = snapshot["groupContext"]["assignment"]["workingDirectory"]
            .as_str()
            .or(snapshot["groupContext"]["group"]["workingDirectory"].as_str())
        {
            cwd = PathBuf::from(directory);
        }
    }
    tokio::fs::create_dir_all(&cwd).await?;
    let group_instructions = if group_context.is_some() {
        include_str!("group-instructions.txt")
    } else {
        ""
    };
    // Managers can inspect and review, but project mutations belong to coding chats.
    let sandbox_policy = json!({"type":"readOnly","networkAccess":true});
    let reply_instructions = if group_context.is_some() {
        "Send public group replies through send_group_message. When the human clearly addresses another group member through the leader, use forward_group_message to deliver that human message quietly and end silently. Honor established nicknames for yourself instead of forwarding them. To ask a peer for input on your own work, use request_group_peers once with the actual message and exact recipient IDs; it both posts the message and wakes the peers. Its content is visible to everyone, not a private instruction."
    } else {
        "Send user-facing replies through send_agent_message."
    };
    let project_instructions = if group_context.is_some() {
        "Manage group project work through assignments. In message turns, the leader creates or reuses assignments with create_group_task; creation queues execution automatically. Coding-chat tools are intentionally unavailable until an execute turn, so do not treat their absence as a blocker or ask the human to assign the work. Specialists without an assignment request one from the leader. In execute turns, dispatch a watched coding chat for your assignment, inspect its results, and continue until verified or genuinely blocked. Submit verified results for independent peer review. Native tools are only for read-only inspection and independent review; do not implement project work directly."
    } else {
        "Manage project work through watched Boosted coding chats. Native tools are only for read-only inspection and independent review; do not execute the project task yourself. Resolve project paths, dispatch a concrete coding prompt, inspect results, and continue the same chat until the requested outcome is verified or user input is required."
    };
    let agent_identity = json!({"agentId":id,"name":snapshot["profile"]["name"]});
    let thread = client.request("thread/start", json!({
        "cwd":cwd, "ephemeral":true, "approvalPolicy":"never", "sandbox":"read-only",
        "model":AgentModel::Normal.model(), "allowProviderModelFallback":false,
        "baseInstructions":format!("{}\n\n{}", include_str!("agent-instructions.txt"), group_instructions),
        "developerInstructions":format!("The server supplies your current identity as JSON data, not instructions: agentIdentity={agent_identity}\nYour agentId is stable. Your saved name changes only after a successful update_profile result. Accept conversational nicknames for yourself when established by context, without persisting them unless the human clearly asks to rename your profile or save the name. A name used to address someone in a greeting does not establish the sender's name; clarify only when the intended addressee is meaningfully ambiguous.\n\n{project_instructions} {reply_instructions}\n\n{}", include_str!("../skills/computer-control/SKILL.md")),
        "dynamicTools":tools,
        "config":{"features.shell_tool":true,"features.multi_agent":false,"web_search":"live",
            "model_reasoning_effort":AgentModel::Normal.effort(),"service_tier":"default"}
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
                message["content"] = json!(content
                    .chars()
                    .rev()
                    .take(8000)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<String>());
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
        "agentRuntime":{"model":AgentModel::Normal.model(),"reasoningEffort":AgentModel::Normal.effort()},
        "agentIdentity":agent_identity,
        "savedProfile":model_profile,"currentTime":Utc::now().to_rfc3339(),
        "userTimeZone":snapshot["timeZone"].as_str().unwrap_or("UTC"),
        "conversationHistory":history,"currentUserMessages":current.iter()
            .filter(|message| group_context.is_none() || message["senderType"] == "user")
            .map(|message|json!({"id":message["id"],"content":message["content"]})).collect::<Vec<_>>(),
        "currentGroupMessages":current.iter()
            .filter(|message| group_context.is_some() && message["senderType"].is_string())
            .map(|message|json!({"id":message["id"],"content":message["content"],
                "senderType":message["senderType"],"senderId":message["senderId"],
                "senderName":message["senderName"],"recipientIds":message["recipientIds"],
                "kind":message["kind"]})).collect::<Vec<_>>(),
        "originalUserMessages":original_messages,"backgroundEvents":background,
        "availableImages":available_images,"attachmentContext":attachment_context,
        "workingDirectory":cwd,"groupContext":snapshot["groupContext"],
        "managedChats":managed_chats(state, id).await?,"savedFollowUps":snapshot["followUps"],
        "recoveryInstructions":"Inspect saved successful actions and already sent replies. Never repeat them after a retry or server restart."
    });
    let mut input = vec![json!({"type":"text","text":prompt.to_string()})];
    input.extend(visual);
    let turn = client
        .request(
            "turn/start",
            json!({"threadId":thread_id,"input":input,
        "model":AgentModel::Normal.model(),"effort":AgentModel::Normal.effort(),"serviceTier":"default",
        "approvalPolicy":"never","sandboxPolicy":sandbox_policy}),
        )
        .await?;
    let mut turn_id = turn
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let routing = ModelRouting {
        client: client.clone(),
        selection: Arc::new(Mutex::new(ModelSelection::default())),
    };
    let mut handoff_requested = false;
    let mut message_forwarded = false;
    let mut calls = 0;
    let mut call_results: HashMap<String, Value> = HashMap::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    let cancellation = cancel.clone();
    let work = async {
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
            match event["method"].as_str().unwrap_or_default() {
                "thread/tokenUsage/updated" => {
                    if params["turnId"].as_str() != turn_id.as_deref() {
                        continue;
                    }
                    let group = groups::context();
                    if let Err(error) = agent_usage::record_scoped(&state.db, id, &thread_id, params, group.as_ref().map(|c| c.group_id.as_str()), true).await
                    {
                        tracing::warn!(%error, "Unable to save agent token usage");
                    }
                }
                "turn/started"
                | "item/reasoning/summaryTextDelta"
                | "item/reasoning/summaryPartAdded"
                | "item/reasoning/textDelta" => {
                    set_activity(state, id, Some("thinking")).await?;
                }
                "item/agentMessage/delta" => {
                    set_activity(state, id, Some("responding")).await?;
                }
                "item/started" | "item/completed" => {
                    let completed = event["method"] == "item/completed";
                    match params["item"]["type"].as_str() {
                        Some("reasoning") => {
                            set_activity(state, id, Some("thinking")).await?;
                        }
                        Some("agentMessage") if !completed => {
                            set_activity(state, id, Some("responding")).await?;
                        }
                        Some("dynamicToolCall") if !completed => {
                            let activity = if params["item"]["tool"] == "send_agent_message" {
                                "responding"
                            } else {
                                "working"
                            };
                            set_activity(state, id, Some(activity)).await?;
                        }
                        Some("dynamicToolCall")
                            if params["item"]["tool"] != "send_agent_message" =>
                        {
                            set_activity(state, id, Some("thinking")).await?;
                        }
                        _ => {}
                    }
                    record_native_action(state, id, &thread_id, &params["item"], &cwd, completed)
                        .await?;
                }
                "item/tool/requestUserInput" => {
                    // Questions belong in the messenger; don't leave a native prompt waiting forever.
                    client
                        .respond(event["id"].clone(), json!({"answers":{}}))
                        .await?;
                }
                "item/tool/call" => {
                    let call_id = params["callId"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| event["id"].to_string());
                    let response = if let Some(previous) = call_results.get(&call_id) {
                        previous.clone()
                    } else {
                        calls += 1;
                        let result = if calls > 128 {
                            Err(AppError::Conflict(
                                "Action limit reached. Ask the user to continue".into(),
                            ))
                        } else if params["turnId"]
                            .as_str()
                            .is_some_and(|event_turn| Some(event_turn) != turn_id.as_deref())
                        {
                            Err(AppError::Conflict(
                                "Tool belongs to an earlier agent turn".into(),
                            ))
                        } else if handoff_requested {
                            Err(AppError::Conflict("Model handoff is in progress".into()))
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
                                if group_context.is_some()
                                    && params["tool"] == "forward_group_message"
                                {
                                    message_forwarded = true;
                                }
                                computer::tool_response(value)
                            }
                            Err(error) => {
                                json!({"success":false,"contentItems":[{"type":"inputText","text":json!({"error":error.to_string()}).to_string()}]})
                            }
                        };
                        call_results.insert(call_id, response.clone());
                        response
                    };
                    client.respond(event["id"].clone(), response).await?;
                    if message_forwarded {
                        // Routing ends the leader's turn, even if the model tries to
                        // send a redundant bubble after the successful handoff.
                        return Ok(());
                    }
                    if !handoff_requested && routing.selection.lock().await.pending.is_some() {
                        // Interrupt after recording and delivering the tool result, so the old
                        // model cannot execute more actions or spend another inference yielding.
                        handoff_requested = true;
                        client
                            .request(
                                "turn/interrupt",
                                json!({"threadId":thread_id,"turnId":turn_id}),
                            )
                            .await?;
                    }
                }
                "turn/completed" => {
                    if params.pointer("/turn/id").and_then(Value::as_str) != turn_id.as_deref() {
                        continue;
                    }
                    let status = params
                        .pointer("/turn/status")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if status == "failed" || (status == "interrupted" && !handoff_requested) {
                        return Err(AppError::Internal(
                            params
                                .pointer("/turn/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("Agent stopped")
                                .into(),
                        ));
                    }
                    if handoff_requested {
                        if *cancellation.borrow() {
                            return Err(AppError::Conflict("Agent stopped".into()));
                        }
                        let mut selection = routing.selection.lock().await;
                        let selected = selection.pending.take().ok_or_else(|| {
                            AppError::Internal("Missing agent model handoff".into())
                        })?;
                        selection.current = selected;
                        drop(selection);
                        set_activity(state, id, Some("thinking")).await?;
                        let continuation = json!({
                            "agentRuntime":{"model":selected.model(),"reasoningEffort":selected.effort()},
                            "instructions":"Continue the existing authorized task from the conversation and tool results. Preserve successful actions and messages; never repeat them. This is a model handoff, not a new user request. Use the same task scope, permissions and reply tools."
                        });
                        let next = client.request("turn/start", json!({
                            "threadId":thread_id,"input":[{"type":"text","text":continuation.to_string()}],
                            "model":selected.model(),"effort":selected.effort(),"serviceTier":"default",
                            "approvalPolicy":"never","sandboxPolicy":sandbox_policy
                        })).await?;
                        turn_id = next
                            .pointer("/turn/id")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        handoff_requested = false;
                        continue;
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
    };
    let result = tokio::select! {
        biased;
        _ = cancel.wait_for(|stopped| *stopped) => Err(AppError::Conflict("Agent stopped".into())),
        result = MODEL_ROUTING.scope(routing.clone(), work) => result,
    };
    let activity_result = set_activity(state, id, None).await;
    // Each agent turn owns its app-server. Interrupt first so foreground commands stop too.
    let cleanup = async {
        if result.is_err() || message_forwarded {
            if let Some(turn_id) = turn_id {
                let _ = client
                    .request(
                        "turn/interrupt",
                        json!({"threadId":thread_id,"turnId":turn_id}),
                    )
                    .await;
            }
        }
        client
            .request(
                "thread/backgroundTerminals/clean",
                json!({"threadId":thread_id}),
            )
            .await
    };
    if !matches!(
        tokio::time::timeout(Duration::from_secs(5), cleanup).await,
        Ok(Ok(_))
    ) {
        tracing::warn!(
            agent_id = id,
            "Unable to clean agent terminals before shutting down Codex"
        );
    }
    state.agents.computer.forget(id).await;
    if let Err(error) = &result {
        if group_context.is_none() {
            change(state, id, |agent| {
                for message in agent["messages"].as_array_mut().unwrap() {
                    if let Some(actions) = message["actions"].as_array_mut() {
                        for action in actions {
                            if action["status"] == "running" {
                                action["status"] = json!("failed");
                                action["result"] =
                                    json!(json!({"error":error.to_string(),"resultUnknown":true})
                                        .to_string());
                            }
                        }
                    }
                }
                agent["activity"] = Value::Null;
                Ok(())
            })
            .await?;
        }
    }
    activity_result?;
    result
}

async fn record_native_action(
    state: &AppState,
    id: &str,
    thread_id: &str,
    item: &Value,
    cwd: &Path,
    completed: bool,
) -> AppResult<()> {
    let Some(tool) = item["type"].as_str().filter(|kind| {
        matches!(
            *kind,
            "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "imageView"
        )
    }) else {
        return Ok(());
    };
    let Some(item_id) = item["id"].as_str() else {
        return Ok(());
    };
    let action_id = format!("{thread_id}:{item_id}");
    let failed = matches!(
        item["status"].as_str(),
        Some("failed" | "declined" | "interrupted")
    ) || item["exitCode"].as_i64().is_some_and(|code| code != 0)
        || item.get("error").is_some_and(|error| !error.is_null());
    let status = if !completed {
        "running"
    } else if failed {
        "failed"
    } else {
        "completed"
    };
    let mut arguments = item.clone();
    for key in [
        "id",
        "type",
        "status",
        "aggregatedOutput",
        "result",
        "error",
        "exitCode",
        "durationMs",
    ] {
        arguments.as_object_mut().unwrap().remove(key);
    }
    let directory = item["cwd"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| cwd.to_string_lossy().to_string());
    let mut action = json!({"id":action_id,"tool":tool,"arguments":arguments,"status":status,"workingDirectory":directory});
    if completed {
        action["result"] = json!(item.to_string().chars().take(24_000).collect::<String>());
    }
    if let Some(context) = groups::context() {
        return groups::receipt(state, &context, action).await;
    }
    change(state, id, |agent| {
        let assistant_name = agent["profile"]["name"].clone();
        let messages = agent["messages"].as_array_mut().unwrap();
        let existing = messages.iter_mut().filter_map(|message| message["actions"].as_array_mut())
            .flat_map(|actions| actions.iter_mut()).find(|action| action["id"] == action_id);
        if let Some(existing) = existing {
            // Replayed started notifications must not downgrade an already completed action.
            if completed || existing["status"] == "running" { *existing = action; }
        } else {
            messages.push(json!({"id":Uuid::new_v4().to_string(),"role":"assistant","content":"",
                "assistantName":assistant_name,"createdAt":Utc::now().to_rfc3339(),"actions":[action]}));
        }
        agent["activity"] = activity_after_actions(agent);
        Ok(())
    }).await?;
    Ok(())
}
async fn send_agent_reply(
    state: &AppState,
    id: &str,
    content: &str,
    current: &[Value],
) -> AppResult<Value> {
    if let Some(context) = groups::context() {
        return groups::reply(state, &context, content).await;
    }
    let message_id = Uuid::new_v4().to_string();
    let agent=change(state,id,|agent| {
        let follow_up_ids:Vec<_>=agent["followUps"].as_array().unwrap().iter().filter(|f|f["status"]=="processing").map(|f|f["id"].clone()).collect();
        let reply=json!({"id":message_id,"role":"assistant","content":content,
            "assistantName":agent["profile"]["name"],"createdAt":Utc::now().to_rfc3339(),
            "inReplyTo":current.iter().map(|message|message["id"].clone()).collect::<Vec<_>>(),"followUpIds":follow_up_ids});
        agent["messages"].as_array_mut().unwrap().push(reply);
        agent["activity"]=Value::Null;Ok(())
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
    if let Some(context) = groups::context() {
        return groups::execute_tool(state, &context, name, args, call_id, current).await;
    }
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
    let conversational = name == "send_agent_message";
    let receipt_id = Uuid::new_v4().to_string();
    if !conversational {
        change(state,id,|a|{a["activity"]=json!("working");let assistant_name=a["profile"]["name"].clone();a["messages"].as_array_mut().unwrap().push(json!({"id":receipt_id,"role":"assistant","content":"","assistantName":assistant_name,"createdAt":Utc::now().to_rfc3339(),"actions":[{"id":call_id,"tool":name,"arguments":args,"status":"running"}]}));Ok(())}).await?;
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
                Ok(value) => computer::receipt_result(value).to_string(),
                Err(error) => json!({"error":error.to_string()}).to_string(),
            });
            if let Ok(value) = &result {
                for key in ["chatId", "workingDirectory"] {
                    if let Some(v) = value.get(key) {
                        action[key] = v.clone();
                    }
                }
            }
            a["activity"] = activity_after_actions(a);
            Ok(())
        })
        .await?;
    }
    result
}
pub(crate) async fn tool_action(
    state: &AppState,
    id: &str,
    name: &str,
    args: &Value,
    current: &[Value],
) -> AppResult<Value> {
    let required = |field: &str, limit| text(args, field, limit);
    match name {
        "select_agent_model" => select_agent_model(args).await,
        "computer_status" | "computer_screenshot" | "computer_action" => {
            state.agents.computer.execute(id, name, args).await
        }
        "send_agent_message" => {
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
        "list_workspaces" => Ok(json!(state
            .db
            .projects()
            .await?
            .iter()
            .map(|p| json!({"id":p.id,"name":p.name,"path":p.repo_path}))
            .collect::<Vec<_>>())),
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
                let runtime = providers::runtime_defaults(state, &chat.id).await?;
                list.push(json!({"id":chat.id,"title":chat.title,"workingDirectory":chat.cwd,"status":if state.active_codex_turns.read().await.contains_key(&chat.id){"RUNNING"}else if meta["dispatchPaused"] == true {"STOPPED"}else{"IDLE"},"runId":state.active_codex_turns.read().await.get(&chat.id),"runtimeDefaults":runtime,"accountId":meta["accountId"],"autoRotateAccount":meta["autoRotateAccount"],"managedByAgentId":meta["managedByAgentId"],"sourceMessageIds":meta["sourceMessageIds"]}));
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
                json!({"chatId":chat_id,"workingDirectory":thread.chat.cwd,"chat":thread.chat,"settings":meta,"runtimeDefaults":thread.runtime_defaults,"runId":state.active_codex_turns.read().await.get(&chat_id),"messages":thread.messages.into_iter().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>()}),
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
                list.push(json!({"id":account["id"],"displayName":account["displayName"],"providerId":account["providerId"],"status":account["status"],"runtimeDefaults":account["runtimeDefaults"],"limits":limits.and_then(|l|l.get("rateLimits").cloned())}));
            }
            Ok(json!(list))
        }
        "list_models" => {
            let account_id = required("accountId", 200)?;
            let client = state.providers.client(&state.db, &account_id).await?;
            Ok(json!(load_codex_options(&client).await?))
        }
        "read_run" => {
            let chat_id = required("chatId", 200)?;
            let run_id = required("runId", 200)?;
            if let Ok(outcome) = document(&state.db, "run-outcomes", &run_id).await {
                if outcome["chatId"] == chat_id {
                    return Ok(outcome);
                }
            }
            if let Ok(queued) = document(&state.db, "chat-queue", &run_id).await {
                if queued["chatId"] == chat_id {
                    return Ok(json!({"chatId":chat_id,"runId":run_id,"status":"QUEUED"}));
                }
            }
            let result = providers::client_for_thread(state, &chat_id)
                .await?
                .request(
                    "thread/read",
                    json!({"threadId":chat_id,"includeTurns":true}),
                )
                .await?;
            let turn = result
                .pointer("/thread/turns")
                .and_then(Value::as_array)
                .and_then(|turns| turns.iter().find(|turn| turn["id"] == run_id))
                .ok_or_else(|| {
                    AppError::NotFound("This run does not belong to this chat".into())
                })?;
            Ok(
                json!({"chatId":chat_id,"runId":run_id,"status":turn["status"],"error":turn["error"],"turn":turn}),
            )
        }
        "set_chat_model" => {
            let chat_id = required("chatId", 200)?;
            let model = required("model", 200)?;
            let chat_lock = state.providers.chat_lock(&chat_id).await;
            let _guard = chat_lock.lock().await;
            if state.active_codex_turns.read().await.contains_key(&chat_id) {
                return Err(AppError::Conflict(
                    "Wait for this run to finish, or stop_run before switching its model".into(),
                ));
            }
            let mut chat = chat_metadata(state, &chat_id).await?;
            let client = providers::client_for_thread(state, &chat_id).await?;
            let mut defaults = providers::runtime_defaults(state, &chat_id)
                .await?
                .unwrap_or(json!({"accessMode":"fullAccess","approvalPolicy":"never"}));
            // Use the new model's effort default unless the caller explicitly chooses an effort.
            defaults["model"] = json!(model);
            defaults.as_object_mut().unwrap().remove("reasoningEffort");
            apply_model_settings(&client, &mut defaults, args).await?;
            defaults["id"] = json!(chat_id);
            chat["runtimeDefaults"] = defaults.clone();
            save_document(&state.db, "chat-runtime", &defaults).await?;
            save_document(&state.db, "provider-chats", &chat).await?;
            state.emit("provider-chats.updated", json!({"chatId":chat_id}));
            Ok(json!({"chatId":chat_id,"runtimeDefaults":defaults,"appliesTo":"nextRun"}))
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
            let title = required("title", 200)?;
            let start_run = args["startRun"].as_bool().unwrap_or(true);
            let prompt = if start_run {
                Some(required("prompt", 32_000)?)
            } else {
                if args["prompt"]
                    .as_str()
                    .is_some_and(|p| !p.trim().is_empty())
                {
                    return Err(AppError::BadRequest(
                        "Use startRun true to dispatch a prompt".into(),
                    ));
                }
                None
            };
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
            if !Path::new(&directory).is_dir() {
                return Err(AppError::BadRequest(
                    "Chat working directory does not exist".into(),
                ));
            }
            let account_id = required("accountId", 200)?;
            let account = document(&state.db, "accounts", &account_id).await?;
            if account["status"] != "CONNECTED" {
                return Err(AppError::Conflict("Connect this account first".into()));
            }
            let client = state.providers.client(&state.db, &account_id).await?;
            let mut defaults = providers::account_runtime_defaults(&state.db, &account).await?;
            if args.get("model").is_some() {
                defaults.as_object_mut().unwrap().remove("reasoningEffort");
            }
            apply_model_settings(&client, &mut defaults, args).await?;
            defaults["accessMode"] = json!("fullAccess");
            defaults["permissionMode"] = json!("fullAccess");
            defaults["approvalPolicy"] = json!("never");
            let response=client.request("thread/start",json!({"cwd":directory,"model":defaults["model"],"allowProviderModelFallback":false,"approvalPolicy":"never","sandbox":"danger-full-access","serviceTier":defaults["serviceTier"],"serviceName":"boosted","config":{"personality":account["settings"]["personality"].as_str().unwrap_or("pragmatic")}})).await?;
            let chat_id = response
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("Codex returned no thread".into()))?
                .to_owned();
            let mut chat = json!({"id":chat_id,"title":title,"accountId":account_id,"workingDirectory":directory,"autoRotateAccount":args["autoRotateAccount"].as_bool().unwrap_or(false),"runtimeDefaults":defaults,"createdAt":Utc::now().to_rfc3339()});
            groups::attach_chat(state, &mut chat).await?;
            save_document(&state.db, "provider-chats", &chat).await?;
            state
                .started_codex_threads
                .write()
                .await
                .insert(chat_id.clone(), response);
            client
                .request(
                    "thread/name/set",
                    json!({"threadId":chat_id,"name":chat["title"]}),
                )
                .await.map_err(|error| AppError::Internal(format!("Created chat {chat_id}, but could not set its title: {error}. Use send_message with this chatId to start it.")))?;
            let mut result =
                json!({"chatId":chat_id,"workingDirectory":directory,"chat":chat,"status":"IDLE"});
            state.emit("provider-chats.updated", json!({"chatId":chat_id}));
            let Some(prompt) = prompt else {
                return Ok(result);
            };
            let run = dispatch_chat(
                    state,
                    &chat_id,
                    &prompt,
                    args["watch"].as_bool().unwrap_or(true),
                    id,
                    current,
                )
                .await.map_err(|error| AppError::Internal(format!("Created chat {chat_id}, but its coding run did not start: {error}. Retry send_message with this chatId; do not create a duplicate chat.")))?;
            result["runId"] = run["runId"].clone();
            result["status"] = run["status"].clone();
            if let Some(f) = run.get("followUpId") {
                result["followUpId"] = f.clone();
            }
            Ok(result)
        }
        "send_message" => {
            let chat_id = required("chatId", 200)?;
            let content = required("content", 32_000)?;
            let chat_lock = state.providers.chat_lock(&chat_id).await;
            let _guard = chat_lock.lock().await;
            let mut chat = chat_metadata(state, &chat_id).await?;
            let was_paused = chat["dispatchPaused"] == true;
            chat["dispatchPaused"] = json!(false);
            save_document(&state.db, "provider-chats", &chat).await?;
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
            let result = dispatch_chat_locked(
                state,
                &chat_id,
                &content,
                args["watch"].as_bool().unwrap_or(true),
                id,
                current,
            )
            .await;
            if result.is_err() && was_paused {
                chat["dispatchPaused"] = json!(true);
                save_document(&state.db, "provider-chats", &chat).await?;
            }
            result
        }
        "stop_chat" => {
            let chat_id = required("chatId", 200)?;
            stop_chat(state, &chat_id).await
        }
        "stop_run" => {
            let chat_id = required("chatId", 200)?;
            let run_id = required("runId", 200)?;
            stop_run(state, &chat_id, &run_id).await
        }
        "set_chat_access" => {
            let chat_id = required("chatId", 200)?;
            let access = required("accessMode", 100)?;
            let approval = args["approvalPolicy"].as_str().unwrap_or("never");
            if !matches!(
                access.as_str(),
                "fullAccess" | "workspaceWrite" | "readOnly"
            ) || !matches!(approval, "never" | "on-request" | "untrusted")
            {
                return Err(AppError::BadRequest(
                    "Invalid access mode or approval policy".into(),
                ));
            }
            let chat_lock = state.providers.chat_lock(&chat_id).await;
            let _guard = chat_lock.lock().await;
            require_idle_chat(state, &chat_id).await?;
            let mut chat = chat_metadata(state, &chat_id).await?;
            let mut defaults = providers::runtime_defaults(state, &chat_id)
                .await?
                .unwrap_or(json!({}));
            defaults["id"] = json!(chat_id);
            defaults["accessMode"] = json!(access);
            defaults["approvalPolicy"] = json!(approval);
            defaults["permissionMode"] = json!(access);
            chat["runtimeDefaults"] = defaults.clone();
            save_document(&state.db, "chat-runtime", &defaults).await?;
            save_document(&state.db, "provider-chats", &chat).await?;
            state.emit("provider-chats.updated", json!({"chatId":chat_id}));
            Ok(json!({"chatId":chat_id,"runtimeDefaults":defaults,"appliesTo":"nextRun"}))
        }
        "delete_chat" => {
            let chat_id = required("chatId", 200)?;
            let chat_lock = state.providers.chat_lock(&chat_id).await;
            let _guard = chat_lock.lock().await;
            require_idle_chat(state, &chat_id).await?;
            delete_chat_locked(state, &chat_id).await?;
            Ok(json!({"chatId":chat_id,"status":"DELETED"}))
        }
        "clear_chat" => {
            let chat_id = required("chatId", 200)?;
            let chat_lock = state.providers.chat_lock(&chat_id).await;
            let _guard = chat_lock.lock().await;
            require_idle_chat(state, &chat_id).await?;
            let mut chat = chat_metadata(state, &chat_id).await?;
            let mut defaults = providers::runtime_defaults(state, &chat_id)
                .await?
                .unwrap_or(json!({"accessMode":"fullAccess","approvalPolicy":"never"}));
            let mut old = chat.clone();
            old["runtimeDefaults"] = defaults.clone();
            let client = providers::client_for_thread(state, &chat_id).await?;
            // Current CLI versions have no history-reset RPC. Replace the conversation
            // through supported lifecycle APIs and return its new ID explicitly.
            let response = start_empty_chat(&client, &chat, &defaults).await?;
            let new_id = response
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("Codex returned no replacement thread".into()))?
                .to_owned();
            chat["id"] = json!(new_id);
            defaults["id"] = json!(new_id);
            chat["runtimeDefaults"] = defaults.clone();
            chat["dispatchPaused"] = json!(true);
            chat.as_object_mut().unwrap().remove("sourceMessageIds");
            chat.as_object_mut().unwrap().remove("latestManagedRunId");
            chat["createdAt"] = json!(Utc::now().to_rfc3339());
            save_document(&state.db, "provider-chats", &chat).await?;
            let mut runtime = defaults;
            runtime["id"] = json!(new_id);
            save_document(&state.db, "chat-runtime", &runtime).await?;
            state
                .started_codex_threads
                .write()
                .await
                .insert(new_id.clone(), response);
            client
                .request(
                    "thread/name/set",
                    json!({"threadId":new_id,"name":chat["title"]}),
                )
                .await?;
            client.request("thread/archive", json!({"threadId":chat_id})).await.map_err(|error| AppError::Internal(format!("Replacement chat {new_id} was created, but old chat {chat_id} could not be archived: {error}")))?;
            old["archived"] = json!(true);
            old["dispatchPaused"] = json!(true);
            save_document(&state.db, "provider-chats", &old).await?;
            clean_chat_state(state, &HashSet::from([chat_id.clone()]), false).await?;
            state.emit(
                "provider-chats.updated",
                json!({"chatId":new_id,"replacedChatId":chat_id}),
            );
            Ok(
                json!({"chatId":new_id,"replacedChatId":chat_id,"originalHistory":"archived","workingDirectory":chat["workingDirectory"],"status":"CLEARED","chat":chat}),
            )
        }
        "move_chat" => {
            let chat_id = required("chatId", 200)?;
            let account_id = move_chat(state, &chat_id, args["accountId"].as_str()).await?;
            Ok(json!({"chatId":chat_id,"accountId":account_id}))
        }
        "set_failover" => {
            let chat_id = required("chatId", 200)?;
            let chat_lock = state.providers.chat_lock(&chat_id).await;
            let _guard = chat_lock.lock().await;
            let mut chat = chat_metadata(state, &chat_id).await?;
            chat["autoRotateAccount"] = json!(args["enabled"]
                .as_bool()
                .ok_or_else(|| AppError::BadRequest("enabled is required".into()))?);
            save_document(&state.db, "provider-chats", &chat).await?;
            Ok(json!({"chatId":chat_id,"chat":chat}))
        }
        "fork_chat" => {
            let original = required("chatId", 200)?;
            let title = args
                .get("title")
                .map(|_| required("title", 200))
                .transpose()?;
            let prompt = args
                .get("prompt")
                .map(|_| required("prompt", 32_000))
                .transpose()?;
            let chat_lock = state.providers.chat_lock(&original).await;
            let _guard = chat_lock.lock().await;
            require_idle_chat(state, &original).await?;
            let mut metadata = chat_metadata(state, &original).await?;
            let client = providers::client_for_thread(state, &original).await?;
            let mut defaults = providers::runtime_defaults(state, &original)
                .await?
                .unwrap_or(json!({"accessMode":"fullAccess","approvalPolicy":"never"}));
            if args.get("model").is_some() {
                defaults.as_object_mut().unwrap().remove("reasoningEffort");
            }
            apply_model_settings(&client, &mut defaults, args).await?;
            let response = client
                .request("thread/fork", json!({"threadId":original,"model":defaults["model"],"lastTurnId":args["lastTurnId"],"deferGoalContinuation":true}))
                .await?;
            let chat_id = response
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("No forked thread".into()))?
                .to_owned();
            metadata["id"] = json!(chat_id);
            defaults["id"] = json!(chat_id);
            metadata["runtimeDefaults"] = defaults.clone();
            // A fork through an earlier turn may not contain the source's latest run.
            metadata.as_object_mut().unwrap().remove("latestManagedRunId");
            metadata["dispatchPaused"] = json!(false);
            metadata["archived"] = json!(false);
            metadata["createdAt"] = json!(Utc::now().to_rfc3339());
            if let Some(title) = title {
                metadata["title"] = json!(title);
            }
            save_document(&state.db, "provider-chats", &metadata).await?;
            defaults["id"] = json!(chat_id);
            save_document(&state.db, "chat-runtime", &defaults).await?;
            let chat = codex_chat(&response["thread"]);
            state
                .started_codex_threads
                .write()
                .await
                .insert(chat_id.clone(), response);
            client
                .request(
                    "thread/name/set",
                    json!({"threadId":chat_id,"name":metadata["title"]}),
                )
                .await?;
            state.emit("provider-chats.updated", json!({"chatId":chat_id}));
            let mut result = json!({"chatId":chat_id,"forkedFromChatId":original,"workingDirectory":chat.cwd,"chat":metadata,"status":"IDLE"});
            if let Some(prompt) = prompt {
                let run = dispatch_chat(
                    state,
                    &chat_id,
                    &prompt,
                    args["watch"].as_bool().unwrap_or(true),
                    id,
                    current,
                )
                .await?;
                result["runId"] = run["runId"].clone();
                result["status"] = run["status"].clone();
                if let Some(followup) = run.get("followUpId") {
                    result["followUpId"] = followup.clone();
                }
            }
            Ok(result)
        }
        "rename_chat" => {
            let chat_id = required("chatId", 200)?;
            let chat_lock = state.providers.chat_lock(&chat_id).await;
            let _guard = chat_lock.lock().await;
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
    if groups::context().is_some() {
        if followup["kind"] != "run" {
            return Err(AppError::Conflict(
                "Group scheduling is not available".into(),
            ));
        }
        return groups::watch_child(state, &followup).await;
    }
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
async fn apply_model_settings(
    client: &CodexClient,
    defaults: &mut Value,
    args: &Value,
) -> AppResult<()> {
    let options = load_codex_options(client).await?;
    let requested = args["model"]
        .as_str()
        .or(defaults["model"].as_str())
        .unwrap_or(&options.default_model);
    let model = options
        .models
        .iter()
        .find(|m| m.model == requested || m.id == requested)
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "Selected Codex model {requested} is unavailable for this account"
            ))
        })?;
    let effort = args["reasoningEffort"]
        .as_str()
        .or(defaults["reasoningEffort"].as_str())
        .unwrap_or(&model.default_reasoning_effort)
        .to_owned();
    if !model.supported_reasoning_efforts.is_empty()
        && !model
            .supported_reasoning_efforts
            .iter()
            .any(|e| e.id == effort)
    {
        return Err(AppError::BadRequest(
            "Selected reasoning effort is not supported by this model".into(),
        ));
    }
    defaults["model"] = json!(model.model);
    defaults["reasoningEffort"] = json!(effort);
    Ok(())
}

async fn require_idle_chat(state: &AppState, chat_id: &str) -> AppResult<()> {
    if state.active_codex_turns.read().await.contains_key(chat_id) {
        return Err(AppError::Conflict(
            "Stop this chat's run and wait for it to finish before changing its conversation"
                .into(),
        ));
    }
    Ok(())
}

async fn start_empty_chat(
    client: &CodexClient,
    chat: &Value,
    defaults: &Value,
) -> AppResult<Value> {
    let sandbox = match defaults["accessMode"].as_str().unwrap_or("fullAccess") {
        "readOnly" => "read-only",
        "workspaceWrite" => "workspace-write",
        _ => "danger-full-access",
    };
    client.request("thread/start", json!({
        "cwd":chat["workingDirectory"],"model":defaults["model"],"allowProviderModelFallback":false,
        "approvalPolicy":defaults["approvalPolicy"].as_str().unwrap_or("never"),"sandbox":sandbox,
        "serviceTier":defaults["serviceTier"],"serviceName":"boosted"
    })).await
}

async fn delete_chat_locked(state: &AppState, chat_id: &str) -> AppResult<()> {
    let client = providers::client_for_thread(state, chat_id).await?;
    let mut events = client.subscribe();
    client
        .request("thread/delete", json!({"threadId":chat_id}))
        .await?;
    let mut deleted = HashSet::from([chat_id.to_owned()]);
    while let Ok(event) = events.try_recv() {
        if event["method"] == "thread/deleted" {
            if let Some(id) = event.pointer("/params/threadId").and_then(Value::as_str) {
                deleted.insert(id.to_owned());
            }
        }
    }
    for id in &deleted {
        // Tombstones also prevent copied history in another account home resurfacing.
        save_document(
            &state.db,
            "deleted-chats",
            &json!({"id":id,"deletedAt":Utc::now().to_rfc3339()}),
        )
        .await?;
    }
    clean_chat_state(state, &deleted, true).await?;
    state.emit(
        "provider-chats.updated",
        json!({"chatId":chat_id,"deletedChatIds":deleted}),
    );
    Ok(())
}

async fn clean_chat_state(
    state: &AppState,
    chat_ids: &HashSet<String>,
    delete_metadata: bool,
) -> AppResult<()> {
    for id in chat_ids {
        let mut transaction = state.db.pool.begin().await?;
        sqlx::query("DELETE FROM feature_documents WHERE (namespace='chat-runtime' AND id=?) OR (namespace='provider-chats' AND id=? AND ?) OR (namespace IN ('chat-queue','coding-requests','run-outcomes','approvals') AND (json_extract(content_json,'$.chatId')=? OR json_extract(content_json,'$.threadId')=?))")
            .bind(id).bind(id).bind(delete_metadata).bind(id).bind(id).execute(&mut *transaction).await?;
        transaction.commit().await?;
        state.started_codex_threads.write().await.remove(id);
        state.pending_inputs.write().await.remove(id);
    }
    let agents: Vec<_> = state.agents.states.lock().await.keys().cloned().collect();
    for agent_id in agents {
        change(state, &agent_id, |agent| {
            for followup in agent["followUps"].as_array_mut().unwrap() {
                if followup["chatId"]
                    .as_str()
                    .is_some_and(|id| chat_ids.contains(id))
                {
                    followup["status"] = json!("cancelled");
                }
            }
            Ok(())
        })
        .await?;
    }
    Ok(())
}

async fn stop_run(state: &AppState, chat_id: &str, run_id: &str) -> AppResult<Value> {
    let chat_lock = state.providers.chat_lock(chat_id).await;
    let _guard = chat_lock.lock().await;
    let active = state.active_codex_turns.read().await.get(chat_id).cloned();
    if active.as_deref() == Some(run_id) {
        providers::client_for_thread(state, chat_id)
            .await?
            .request(
                "turn/interrupt",
                json!({"threadId":chat_id,"turnId":run_id}),
            )
            .await?;
        return Ok(json!({"chatId":chat_id,"runId":run_id,"status":"INTERRUPTING"}));
    }
    if let Ok(queued) = document(&state.db, "chat-queue", run_id).await {
        if queued["chatId"] == chat_id {
            cancel_queued_run(state, &queued).await?;
            return Ok(json!({"chatId":chat_id,"runId":run_id,"status":"CANCELLED"}));
        }
    }
    Err(AppError::Conflict(
        "This run is no longer active or queued in this chat; inspect the chat before retrying"
            .into(),
    ))
}

async fn cancel_queued_run(state: &AppState, queued: &Value) -> AppResult<()> {
    sqlx::query("DELETE FROM feature_documents WHERE namespace='chat-queue' AND id=?")
        .bind(queued["id"].as_str().unwrap_or_default())
        .execute(&state.db.pool)
        .await?;
    record_outcome(
        state,
        queued["chatId"].as_str().unwrap_or_default(),
        queued["id"].as_str().unwrap_or_default(),
        &json!({"turn":{"status":"interrupted","items":[]}}),
    )
    .await
}

pub(crate) async fn stop_chat(state: &AppState, chat_id: &str) -> AppResult<Value> {
    let chat_lock = state.providers.chat_lock(chat_id).await;
    let _guard = chat_lock.lock().await;
    let mut chat = chat_metadata(state, chat_id).await?;
    chat["dispatchPaused"] = json!(true);
    save_document(&state.db, "provider-chats", &chat).await?;
    let mut cancelled = 0;
    for queued in documents(&state.db, "chat-queue")
        .await?
        .into_iter()
        .filter(|q| q["chatId"] == chat_id)
    {
        cancel_queued_run(state, &queued).await?;
        cancelled += 1;
    }
    let active = state.active_codex_turns.read().await.get(chat_id).cloned();
    let client = providers::client_for_thread(state, chat_id).await?;
    let loaded = client
        .request("thread/loaded/list", json!({"limit":1000}))
        .await?;
    let is_loaded = loaded["data"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == chat_id));
    if is_loaded {
        let goal = client
            .request("thread/goal/get", json!({"threadId":chat_id}))
            .await?;
        if goal.pointer("/goal/status").and_then(Value::as_str) == Some("active") {
            client
                .request(
                    "thread/goal/set",
                    json!({"threadId":chat_id,"status":"paused"}),
                )
                .await?;
        }
    }
    if let Some(run_id) = &active {
        client
            .request(
                "turn/interrupt",
                json!({"threadId":chat_id,"turnId":run_id}),
            )
            .await?;
    }
    if is_loaded {
        client
            .request(
                "thread/backgroundTerminals/clean",
                json!({"threadId":chat_id}),
            )
            .await?;
    }
    state.emit("provider-chats.updated", json!({"chatId":chat_id}));
    Ok(
        json!({"chatId":chat_id,"runId":active,"status":if active.is_some(){"INTERRUPTING"}else{"STOPPED"},"cancelledQueuedRuns":cancelled,"dispatchPaused":true}),
    )
}

async fn dispatch_chat(
    state: &AppState,
    chat_id: &str,
    content: &str,
    watch: bool,
    agent_id: &str,
    current: &[Value],
) -> AppResult<Value> {
    let chat_lock = state.providers.chat_lock(chat_id).await;
    let _guard = chat_lock.lock().await;
    dispatch_chat_locked(state, chat_id, content, watch, agent_id, current).await
}

async fn managed_chats(state: &AppState, agent_id: &str) -> AppResult<Vec<Value>> {
    if groups::context().is_some() {
        return Ok(vec![]);
    }
    let agent = state.agents.get(agent_id).await?;
    let mut chats = Vec::new();
    for chat in documents(&state.db, "provider-chats").await? {
        if chat["managedByAgentId"] == agent_id && chat["groupId"].is_null() && chat["archived"] != true {
            let sources: Vec<_> = agent["messages"].as_array().unwrap().iter()
                .filter(|message| chat["sourceMessageIds"].as_array().is_some_and(|ids| ids.contains(&message["id"])))
                .map(|message| json!({"id":message["id"],"content":message["content"]})).collect();
            chats.push(json!({"chatId":chat["id"],"title":chat["title"],"userRequests":sources,
                "workingDirectory":chat["workingDirectory"],"sourceMessageIds":chat["sourceMessageIds"],
                "latestRunId":chat["latestManagedRunId"],"stopped":chat["dispatchPaused"] == true}));
        }
    }
    Ok(chats)
}

async fn coding_source_messages(
    state: &AppState,
    agent_id: &str,
    chat_id: &str,
    current: &[Value],
) -> AppResult<Vec<Value>> {
    if groups::context().is_some() {
        return Ok(current.to_vec());
    }
    let agent = state.agents.get(agent_id).await?;
    let chat = chat_metadata(state, chat_id).await?;
    let mut ids: HashSet<String> = current
        .iter()
        .filter_map(|message| message["id"].as_str().map(str::to_owned))
        .collect();
    if chat["managedByAgentId"] == agent_id {
        if let Some(sources) = chat["sourceMessageIds"].as_array() {
            ids.extend(
                sources
                    .iter()
                    .filter_map(|id| id.as_str().map(str::to_owned)),
            );
        }
    }
    for followup in agent["followUps"].as_array().unwrap() {
        if followup["status"] == "processing" && followup["chatId"] == chat_id {
            if let Some(sources) = followup["sourceMessageIds"].as_array() {
                ids.extend(
                    sources
                        .iter()
                        .filter_map(|id| id.as_str().map(str::to_owned)),
                );
            }
        }
    }
    let mut sources: Vec<_> = agent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| {
            message["role"] == "user" && message["id"].as_str().is_some_and(|id| ids.contains(id))
        })
        .cloned()
        .collect();
    // Queued dispatch/recovery may carry messages absent from the latest snapshot.
    for message in current {
        if !sources.iter().any(|source| source["id"] == message["id"]) {
            sources.push(message.clone());
        }
    }
    Ok(sources)
}

async fn dispatch_chat_locked(
    state: &AppState,
    chat_id: &str,
    content: &str,
    watch: bool,
    agent_id: &str,
    current: &[Value],
) -> AppResult<Value> {
    let _group_guard = groups::dispatch_guard(state, chat_id).await?;
    if document(&state.db, "provider-chats", chat_id)
        .await
        .ok()
        .is_some_and(|chat| chat["dispatchPaused"] == true)
    {
        return Err(AppError::Conflict(
            "This chat is stopped. Use send_message only when the user asks to resume it".into(),
        ));
    }
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
    let sources = coding_source_messages(state, agent_id, chat_id, current).await?;
    let (_, Json(run)) = send_codex_message_locked(
        state,
        chat_id.into(),
        CodexMessageCreate {
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
            collaboration_mode: defaults["collaborationMode"].as_str().map(str::to_owned),
            attachment_ids: vec![],
        },
    )
    .await?;
    if groups::context().is_none() {
        let mut chat = chat_metadata(state, chat_id).await?;
        chat["managedByAgentId"] = json!(agent_id);
        chat["sourceMessageIds"] =
            json!(sources.iter().map(|m| m["id"].clone()).collect::<Vec<_>>());
        chat["latestManagedRunId"] = json!(run.turn_id);
        save_document(&state.db, "provider-chats", &chat).await?;
    }
    let mut result = json!({"chatId":run.thread_id,"runId":run.turn_id,"status":"RUNNING"});
    if watch {
        let followup=add_followup(state,agent_id,json!({"kind":"run","chatId":run.thread_id,"runId":run.turn_id,"instructions":CODING_REVIEW_INSTRUCTIONS,"sourceMessageIds":sources.iter().map(|m|m["id"].clone()).collect::<Vec<_>>() })).await?;
        result["followUpId"] = followup["id"].clone();
    }
    save_document(&state.db,"coding-requests",&json!({"id":run.turn_id,"chatId":run.thread_id,"content":content,"agentId":agent_id,"current":sources})).await?;
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
    groups::tick(state).await?;
    recover_coding_runs(state).await?;
    for queued in documents(&state.db, "chat-queue").await? {
        let chat_id = queued["chatId"].as_str().unwrap_or_default();
        let chat_lock = state.providers.chat_lock(chat_id).await;
        let _guard = chat_lock.lock().await;
        // A stop may have cancelled this entry after the scheduler took its snapshot.
        if document(
            &state.db,
            "chat-queue",
            queued["id"].as_str().unwrap_or_default(),
        )
        .await
        .is_err()
        {
            continue;
        }
        if document(&state.db, "provider-chats", chat_id)
            .await
            .ok()
            .is_some_and(|chat| chat["dispatchPaused"] == true)
        {
            continue;
        }
        if state.active_codex_turns.read().await.contains_key(chat_id) {
            continue;
        }
        let agent_id = queued["agentId"].as_str().unwrap_or_default();
        let result = dispatch_chat_locked(
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

pub(crate) fn quota_error(message: &str) -> bool {
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
            Ok(chat) if chat["autoRotateAccount"] == true && chat["dispatchPaused"] != true => chat,
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
    #[cfg(unix)]
    async fn coding_fixture() -> (tempfile::TempDir, AppState, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let (root, mut state) = fixture().await;
        let script = root.path().join("fake-codex");
        std::fs::write(
            &script,
            include_str!("../tests/fixtures/codex-app-server.py"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        state.providers =
            providers::ProviderManager::test_with_program(root.path().join("accounts"), script);
        let home = root.path().join("selected-provider-home");
        save_document(&state.db, "accounts", &json!({"id":"account","providerId":"codex","status":"CONNECTED","settings":{"codexHome":home},"runtimeDefaults":{"model":"exact-alpha","reasoningEffort":"high","permissionMode":"readOnly"}})).await.unwrap();
        sqlx::query("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('admin','admin','','admin','now')").execute(&state.db.pool).await.unwrap();
        sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES('project','Test',?,'main','admin','now')").bind(root.path().to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
        // Keep scheduler tests from starting the independent conversational model worker.
        let (sender, _) = watch::channel(false);
        state
            .agents
            .workers
            .lock()
            .await
            .insert("pock".into(), sender);
        (root, state, home)
    }
    #[cfg(unix)]
    async fn coding_tool(state: &AppState, name: &str, args: Value) -> AppResult<Value> {
        execute_tool(state, "pock", name, &args, &Uuid::new_v4().to_string(), &[]).await
    }
    #[cfg(unix)]
    async fn coding_chat(root: &tempfile::TempDir, state: &AppState, prompt: &str) -> Value {
        coding_tool(state, "create_chat", json!({"workingDirectory":root.path(),"accountId":"account","title":"Test chat","prompt":prompt,"model":"exact-beta","watch":false})).await.unwrap()
    }
    #[cfg(unix)]
    fn rpc_log(home: &Path) -> Vec<Value> {
        std::fs::read_to_string(home.join("rpc-log.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    #[cfg(unix)]
    async fn wait_outcome(state: &AppState, run: &Value) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(outcome) =
                    document(&state.db, "run-outcomes", run["runId"].as_str().unwrap()).await
                {
                    return outcome;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("coding outcome")
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn coding_manager_dispatches_reviews_continues_and_applies_curation() {
        use std::os::unix::fs::PermissionsExt;
        let (root, state, home) = coding_fixture().await;
        let script = root.path().join("manager-codex");
        std::fs::write(&script, include_str!("../tests/fixtures/agent-manager-app-server.py")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexClient::test_process(script, true).await.unwrap();
        let original = json!({"id":"request","role":"user","content":"Implement"});
        let directory = json!({"id":"directory","role":"user","content":root.path().to_str().unwrap()});
        change(&state, "pock", |agent| {
            agent["messages"] = json!([original, directory]);
            Ok(())
        }).await.unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let snapshot = state.agents.get("pock").await.unwrap();
        run_turn_with_client(&state, "pock", &snapshot, &[original.clone(), directory.clone()], &[], &client, &mut cancel).await.unwrap();
        let first = state.agents.get("pock").await.unwrap()["followUps"][0].clone();
        wait_outcome(&state, &first).await;
        tick(&state).await.unwrap();
        change(&state, "pock", |agent| {
            agent["followUps"][0]["status"] = json!("processing");
            Ok(())
        }).await.unwrap();
        // Reload persisted state before reviewing: browser state and in-memory chat history
        // are not required to continue the original task.
        let reloaded = AgentManager::load(&state.db).await.unwrap();
        let snapshot = reloaded.get("pock").await.unwrap();
        let background = snapshot["followUps"][0].clone();
        run_turn_with_client(&state, "pock", &snapshot, &[], &[background], &client, &mut cancel).await.unwrap();
        let next = state.agents.get("pock").await.unwrap()["followUps"][1].clone();
        assert_eq!(first["chatId"], next["chatId"]);
        assert_eq!(next["sourceMessageIds"], json!(["request", "directory"]));
        wait_outcome(&state, &next).await;
        let feedback = json!({"id":"feedback","role":"user","content":"Refine it"});
        change(&state, "pock", |agent| {
            agent["messages"].as_array_mut().unwrap().push(feedback.clone());
            for followup in agent["followUps"].as_array_mut().unwrap() {
                followup["status"] = json!("completed");
            }
            Ok(())
        }).await.unwrap();
        let snapshot = state.agents.get("pock").await.unwrap();
        run_turn_with_client(&state, "pock", &snapshot, &[feedback], &[], &client, &mut cancel).await.unwrap();
        client.shutdown().await;
        let curated = state.agents.get("pock").await.unwrap()["followUps"][2].clone();
        assert_eq!(first["chatId"], curated["chatId"]);
        assert_eq!(curated["sourceMessageIds"], json!(["request", "directory", "feedback"]));
        let request = document(&state.db, "coding-requests", curated["runId"].as_str().unwrap()).await.unwrap();
        assert_eq!(request["current"][0]["id"], "request");
        assert_eq!(request["current"][2]["id"], "feedback");
        let log = rpc_log(&home);
        assert_eq!(log.iter().filter(|rpc| rpc["method"] == "thread/start").count(), 1);
        assert_eq!(log.iter().filter(|rpc| rpc["method"] == "turn/start").count(), 3);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn coding_creation_dispatches_exact_model_full_access_and_isolated_home() {
        let (root, state, home) = coding_fixture().await;
        let models = coding_tool(&state, "list_models", json!({"accountId":"account"}))
            .await
            .unwrap();
        assert_eq!(models["models"][1]["model"], "exact-beta");
        let run = coding_chat(&root, &state, "Do the coding task").await;
        assert_eq!(run["status"], "RUNNING");
        assert!(run["chatId"]
            .as_str()
            .unwrap()
            .starts_with("selected-provider-home-"));
        let log = rpc_log(&home);
        assert!(log.iter().all(|m| m["home"] == json!(home)));
        let started = log.iter().find(|m| m["method"] == "thread/start").unwrap();
        assert_eq!(started["params"]["model"], "exact-beta");
        assert_eq!(started["params"]["allowProviderModelFallback"], false);
        assert_eq!(started["params"]["sandbox"], "danger-full-access");
        let turn = log.iter().find(|m| m["method"] == "turn/start").unwrap();
        assert_eq!(turn["params"]["model"], "exact-beta");
        assert_eq!(turn["params"]["effort"], "low");
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "dangerFullAccess");
        assert_eq!(turn["params"]["approvalPolicy"], "never");
        assert_eq!(turn["params"]["input"][0]["text"], "Do the coding task");
        assert!(!log.iter().any(|m| m["method"] == "thread/resume"));
        let chat = coding_tool(&state, "read_chat", json!({"chatId":run["chatId"]}))
            .await
            .unwrap();
        assert_eq!(chat["messages"].as_array().unwrap().len(), 2);
        save_document(&state.db,"accounts",&json!({"id":"other","providerId":"codex","status":"CONNECTED","settings":{},"runtimeDefaults":{}})).await.unwrap();
        coding_tool(&state, "list_models", json!({"accountId":"other"}))
            .await
            .unwrap();
        let other = root.path().join("accounts/other");
        assert_eq!(rpc_log(&other)[0]["home"], json!(other));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn chat_planning_mode_survives_followups_and_switches_back_to_execution() {
        let (root, state, home) = coding_fixture().await;
        let first = coding_chat(&root, &state, "COMPLETE").await;
        wait_outcome(&state, &first).await;
        let chat_id = first["chatId"].as_str().unwrap();
        for (requested, expected) in [
            (Some("plan"), "plan"),
            (None, "plan"),
            (Some("default"), "default"),
        ] {
            let input = serde_json::from_value(json!({
                "message": "COMPLETE", "model": "exact-beta", "reasoningEffort": "low",
                "accessMode": "workspaceWrite", "collaborationMode": requested
            }))
            .unwrap();
            let (_, Json(run)) =
                send_codex_message(State(state.clone()), AxumPath(chat_id.into()), Json(input))
                    .await
                    .unwrap();
            wait_outcome(&state, &json!({"runId": run.turn_id})).await;
            let log = rpc_log(&home);
            let turn = log
                .iter()
                .rev()
                .find(|m| m["method"] == "turn/start")
                .unwrap();
            assert_eq!(turn["params"]["collaborationMode"]["mode"], expected);
            assert_eq!(
                turn["params"]["collaborationMode"]["settings"]["model"],
                "exact-beta"
            );
            assert_eq!(
                turn["params"]["collaborationMode"]["settings"]["reasoning_effort"],
                "low"
            );
            assert_eq!(turn["params"]["sandboxPolicy"]["type"], "workspaceWrite");
            let defaults = providers::runtime_defaults(&state, chat_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(defaults["collaborationMode"], expected);
        }
        let before = rpc_log(&home).len();
        let invalid =
            serde_json::from_value(json!({"message":"COMPLETE","collaborationMode":"invalid"}))
                .unwrap();
        assert!(matches!(
            send_codex_message(
                State(state.clone()),
                AxumPath(chat_id.into()),
                Json(invalid)
            )
            .await,
            Err(AppError::BadRequest(_))
        ));
        assert_eq!(rpc_log(&home).len(), before);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn coding_creation_validates_before_mutation_and_reports_partial_dispatch_failure() {
        let (root, state, home) = coding_fixture().await;
        let base = json!({"workingDirectory":root.path(),"accountId":"account","title":"Test"});
        assert!(coding_tool(&state, "create_chat", base.clone())
            .await
            .is_err());
        let mut args = base;
        args["prompt"] = json!(" ");
        assert!(coding_tool(&state, "create_chat", args.clone())
            .await
            .is_err());
        args["prompt"] = json!("Do work");
        args["model"] = json!("unavailable-exact-model");
        assert!(coding_tool(&state, "create_chat", args.clone())
            .await
            .is_err());
        args["model"] = json!("exact-beta");
        args["reasoningEffort"] = json!("high");
        assert!(coding_tool(&state, "create_chat", args.clone())
            .await
            .is_err());
        assert!(!rpc_log(&home).iter().any(|m| m["method"] == "thread/start"));
        args["reasoningEffort"] = json!("low");
        args["prompt"] = json!("REJECT_RUN");
        let error = coding_tool(&state, "create_chat", args)
            .await
            .unwrap_err()
            .to_string();
        let chats = documents(&state.db, "provider-chats").await.unwrap();
        assert_eq!(chats.len(), 1);
        assert!(error.contains(chats[0]["id"].as_str().unwrap()));
        assert!(error.contains("did not start"));
        assert!(state.active_codex_turns.read().await.is_empty());
        let run = coding_tool(
            &state,
            "send_message",
            json!({"chatId":chats[0]["id"],"content":"Retry","watch":false}),
        )
        .await
        .unwrap();
        assert_eq!(run["status"], "RUNNING");
        assert_eq!(
            documents(&state.db, "provider-chats").await.unwrap().len(),
            1
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn coding_empty_chats_require_an_explicit_choice_and_stopping_does_not_kill_other_chats()
    {
        let (root, state, home) = coding_fixture().await;
        let empty=coding_tool(&state,"create_chat",json!({"workingDirectory":root.path(),"accountId":"account","title":"Explicitly empty","startRun":false})).await.unwrap();
        assert_eq!(empty["status"], "IDLE");
        assert!(empty.get("runId").is_none());
        assert!(!rpc_log(&home).iter().any(|m| m["method"] == "turn/start"));
        let first = coding_chat(&root, &state, "WITH_GOAL").await;
        let other = coding_chat(&root, &state, "Independent task").await;
        coding_tool(&state, "stop_chat", json!({"chatId":first["chatId"]}))
            .await
            .unwrap();
        wait_outcome(&state, &first).await;
        assert_eq!(
            state
                .active_codex_turns
                .read()
                .await
                .get(other["chatId"].as_str().unwrap()),
            other["runId"].as_str().map(str::to_owned).as_ref()
        );
        let inspected = coding_tool(
            &state,
            "read_run",
            json!({"chatId":other["chatId"],"runId":other["runId"]}),
        )
        .await
        .unwrap();
        assert_eq!(inspected["status"], "inProgress");
        let log = rpc_log(&home);
        assert!(log
            .iter()
            .any(|m| m["method"] == "thread/goal/set" && m["params"]["status"] == "paused"));
        assert!(log
            .iter()
            .any(|m| m["method"] == "thread/backgroundTerminals/clean"
                && m["params"]["threadId"] == first["chatId"]));
        assert_eq!(
            log.iter().filter(|m| m["method"] == "initialize").count(),
            1
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn coding_model_switch_preserves_permissions_and_rejects_active_changes() {
        let (root, state, home) = coding_fixture().await;
        let run = coding_chat(&root, &state, "First task").await;
        let args = json!({"chatId":run["chatId"],"model":"exact-alpha","reasoningEffort":"high"});
        assert!(coding_tool(&state, "set_chat_model", args.clone())
            .await
            .is_err());
        coding_tool(
            &state,
            "stop_run",
            json!({"chatId":run["chatId"],"runId":run["runId"]}),
        )
        .await
        .unwrap();
        assert_eq!(wait_outcome(&state, &run).await["status"], "interrupted");
        let inspected = coding_tool(
            &state,
            "read_run",
            json!({"chatId":run["chatId"],"runId":run["runId"]}),
        )
        .await
        .unwrap();
        assert_eq!(inspected["status"], "interrupted");
        assert!(coding_tool(
            &state,
            "read_run",
            json!({"chatId":run["chatId"],"runId":"another-chat-run"})
        )
        .await
        .is_err());
        coding_tool(
            &state,
            "set_chat_access",
            json!({"chatId":run["chatId"],"accessMode":"readOnly"}),
        )
        .await
        .unwrap();
        let switched = coding_tool(&state, "set_chat_model", args).await.unwrap();
        assert_eq!(switched["runtimeDefaults"]["accessMode"], "readOnly");
        assert_eq!(switched["appliesTo"], "nextRun");
        let next = coding_tool(
            &state,
            "send_message",
            json!({"chatId":run["chatId"],"content":"COMPLETE","watch":false}),
        )
        .await
        .unwrap();
        assert_eq!(wait_outcome(&state, &next).await["status"], "completed");
        let log = rpc_log(&home);
        let turn = log
            .iter()
            .rev()
            .find(|m| m["method"] == "turn/start")
            .unwrap();
        assert_eq!(turn["params"]["model"], "exact-alpha");
        assert_eq!(turn["params"]["effort"], "high");
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(turn["params"]["approvalPolicy"], "never");
        assert!(state.active_codex_turns.read().await.is_empty());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn coding_stop_run_targets_exact_id_and_stop_chat_cancels_queue_and_recovery() {
        let (root, state, home) = coding_fixture().await;
        let run = coding_chat(&root, &state, "First task").await;
        let chat_id = run["chatId"].as_str().unwrap();
        let q1 = coding_tool(
            &state,
            "send_message",
            json!({"chatId":chat_id,"content":"Queued one","watch":false}),
        )
        .await
        .unwrap();
        let _q2 = coding_tool(
            &state,
            "send_message",
            json!({"chatId":chat_id,"content":"Queued two","watch":false}),
        )
        .await
        .unwrap();
        assert!(coding_tool(
            &state,
            "stop_run",
            json!({"chatId":chat_id,"runId":"stale-run"})
        )
        .await
        .is_err());
        coding_tool(
            &state,
            "stop_run",
            json!({"chatId":chat_id,"runId":q1["runId"]}),
        )
        .await
        .unwrap();
        assert_eq!(documents(&state.db, "chat-queue").await.unwrap().len(), 1);
        assert_eq!(
            state.active_codex_turns.read().await.get(chat_id),
            run["runId"].as_str().map(str::to_owned).as_ref()
        );
        let stopped = coding_tool(&state, "stop_chat", json!({"chatId":chat_id}))
            .await
            .unwrap();
        assert_eq!(stopped["cancelledQueuedRuns"], 1);
        assert_eq!(stopped["dispatchPaused"], true);
        wait_outcome(&state, &run).await;
        let mut chat = document(&state.db, "provider-chats", chat_id)
            .await
            .unwrap();
        chat["autoRotateAccount"] = json!(true);
        save_document(&state.db, "provider-chats", &chat)
            .await
            .unwrap();
        save_document(
            &state.db,
            "run-outcomes",
            &json!({"id":"failed-quota","chatId":chat_id,"status":"failed","error":"quota"}),
        )
        .await
        .unwrap();
        tick(&state).await.unwrap();
        assert!(documents(&state.db, "chat-queue").await.unwrap().is_empty());
        assert_eq!(
            rpc_log(&home)
                .iter()
                .filter(|m| m["method"] == "turn/start")
                .count(),
            1
        );
        assert!(
            dispatch_chat(&state, chat_id, "Must remain stopped", false, "pock", &[])
                .await
                .is_err()
        );
        assert_eq!(
            coding_tool(&state, "stop_chat", json!({"chatId":chat_id}))
                .await
                .unwrap()["status"],
            "STOPPED"
        );
        let resumed = coding_tool(
            &state,
            "send_message",
            json!({"chatId":chat_id,"content":"COMPLETE","watch":false}),
        )
        .await
        .unwrap();
        wait_outcome(&state, &resumed).await;
        assert_eq!(
            document(&state.db, "provider-chats", chat_id)
                .await
                .unwrap()["dispatchPaused"],
            false
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn coding_fork_clear_and_delete_preserve_settings_and_clean_local_state() {
        let (root, state, home) = coding_fixture().await;
        let run = coding_chat(&root, &state, "COMPLETE").await;
        wait_outcome(&state, &run).await;
        let original = run["chatId"].as_str().unwrap();
        let fork = coding_tool(
            &state,
            "fork_chat",
            json!({"chatId":original,"title":"Fork title","lastTurnId":run["runId"]}),
        )
        .await
        .unwrap();
        assert_ne!(fork["chatId"], run["chatId"]);
        assert_eq!(fork["chat"]["runtimeDefaults"]["model"], "exact-beta");
        assert_eq!(fork["chat"]["runtimeDefaults"]["accessMode"], "fullAccess");
        assert!(fork["chat"]["latestManagedRunId"].is_null());
        let forked = coding_tool(&state, "read_chat", json!({"chatId":fork["chatId"]}))
            .await
            .unwrap();
        assert_eq!(forked["messages"].as_array().unwrap().len(), 2);
        let rejected = coding_tool(&state, "delete_chat", json!({"chatId":original}))
            .await
            .unwrap_err();
        assert!(rejected.to_string().contains("forked history"));
        assert!(document(&state.db, "provider-chats", original)
            .await
            .is_ok());
        assert!(document(&state.db, "deleted-chats", original)
            .await
            .is_err());
        coding_tool(
            &state,
            "watch_chat",
            json!({"chatId":original,"runId":run["runId"],"instructions":"Report"}),
        )
        .await
        .unwrap();
        save_document(
            &state.db,
            "chat-queue",
            &json!({"id":"queued","chatId":original,"content":"Stale instruction"}),
        )
        .await
        .unwrap();
        let cleared = coding_tool(&state, "clear_chat", json!({"chatId":original}))
            .await
            .unwrap();
        assert_eq!(cleared["replacedChatId"], original);
        let new_id = cleared["chatId"].as_str().unwrap();
        assert_ne!(new_id, original);
        assert_eq!(cleared["chat"]["runtimeDefaults"]["model"], "exact-beta");
        assert!(cleared["chat"]["sourceMessageIds"].is_null());
        assert!(cleared["chat"]["latestManagedRunId"].is_null());
        assert!(!managed_chats(&state, "pock").await.unwrap().iter().any(|chat| chat["chatId"] == original));
        assert_eq!(
            document(&state.db, "provider-chats", original)
                .await
                .unwrap()["archived"],
            true
        );
        assert!(document(&state.db, "chat-runtime", original).await.is_err());
        assert!(documents(&state.db, "chat-queue").await.unwrap().is_empty());
        assert_eq!(
            state.agents.get("pock").await.unwrap()["followUps"][0]["status"],
            "cancelled"
        );
        let empty = coding_tool(&state, "read_chat", json!({"chatId":new_id}))
            .await
            .unwrap();
        assert!(empty["messages"].as_array().unwrap().is_empty());
        coding_tool(&state, "delete_chat", json!({"chatId":new_id}))
            .await
            .unwrap();
        assert!(document(&state.db, "provider-chats", new_id).await.is_err());
        assert!(!state
            .started_codex_threads
            .read()
            .await
            .contains_key(new_id));
        assert!(coding_tool(&state, "read_chat", json!({"chatId":new_id}))
            .await
            .is_err());
        assert!(
            coding_tool(&state, "read_chat", json!({"chatId":fork["chatId"]}))
                .await
                .is_ok()
        );
        coding_tool(&state, "delete_chat", json!({"chatId":fork["chatId"]}))
            .await
            .unwrap();
        coding_tool(&state, "delete_chat", json!({"chatId":original}))
            .await
            .unwrap();
        assert!(document(&state.db, "provider-chats", original)
            .await
            .is_err());
        assert!(!rpc_log(&home)
            .iter()
            .any(|m| m["method"] == "thread/rollback"));
    }
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires an installed Codex CLI; uses an isolated home and loopback inference only"]
    async fn installed_codex_executes_and_interrupts_through_agent_tools() {
        use std::convert::Infallible;
        let (root, mut state, home) = coding_fixture().await;
        state.providers = providers::ProviderManager::new(root.path().join("accounts"));
        tokio::fs::create_dir_all(&home).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
        let count = Arc::new(AtomicU64::new(0));
        let app = Router::new().route("/v1/responses", post(move |Json(request):Json<Value>| {
            let count=count.clone();let requests=requests.clone();
            async move {
                requests.send(request).unwrap();
                let index=count.fetch_add(1,Ordering::Relaxed);
                let item=json!({"type":"message","id":"msg_probe","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Synthetic loopback result","annotations":[]}]});
                let completed=json!({"type":"response.completed","response":{"id":"resp_probe","object":"response","created_at":1700000000,"status":"completed","output":[item.clone()],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}});
                let payload=format!("event: response.output_item.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",json!({"type":"response.output_item.done","output_index":0,"item":item}),completed);
                let body=if index==0 { Body::from(payload) } else {
                    Body::from_stream(futures_util::stream::pending::<Result<String,Infallible>>())
                };
                Response::builder().header("content-type","text/event-stream").body(body).unwrap()
            }
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        tokio::fs::write(
            home.join("config.toml"),
            format!(
                r#"
model_provider = "boosted_loopback"
[model_providers.boosted_loopback]
name = "Boosted disposable lifecycle test"
base_url = "http://{address}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
"#
            ),
        )
        .await
        .unwrap();
        let options = coding_tool(&state, "list_models", json!({"accountId":"account"}))
            .await
            .unwrap();
        let models = options["models"].as_array().unwrap();
        let first = models
            .iter()
            .find(|m| m["model"] == options["defaultModel"])
            .unwrap();
        let second = models
            .iter()
            .find(|m| m["model"] != first["model"])
            .unwrap();
        let run=coding_tool(&state,"create_chat",json!({"workingDirectory":root.path(),"accountId":"account","title":"Disposable real CLI probe","prompt":"Verify the local lifecycle","model":first["model"],"watch":false})).await.unwrap();
        let request = tokio::time::timeout(Duration::from_secs(10), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(request["model"], first["model"]);
        let outcome = wait_outcome(&state, &run).await;
        assert_eq!(outcome["status"], "completed", "{outcome}");
        let original = run["chatId"].as_str().unwrap();
        let chat = coding_tool(&state, "read_chat", json!({"chatId":original}))
            .await
            .unwrap();
        assert!(chat["messages"].as_array().unwrap().iter().any(|m| {
            m["content"]
                .as_str()
                .is_some_and(|s| s.contains("Synthetic loopback result"))
        }));
        coding_tool(
            &state,
            "set_chat_model",
            json!({"chatId":original,"model":second["model"]}),
        )
        .await
        .unwrap();
        let next = coding_tool(
            &state,
            "send_message",
            json!({"chatId":original,"content":"Hold this synthetic request","watch":false}),
        )
        .await
        .unwrap();
        let request = tokio::time::timeout(Duration::from_secs(10), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(request["model"], second["model"]);
        coding_tool(&state, "stop_chat", json!({"chatId":original}))
            .await
            .unwrap();
        assert_eq!(wait_outcome(&state, &next).await["status"], "interrupted");
        let fork = coding_tool(
            &state,
            "fork_chat",
            json!({"chatId":original,"title":"Disposable fork"}),
        )
        .await
        .unwrap();
        let cleared = coding_tool(&state, "clear_chat", json!({"chatId":original}))
            .await
            .unwrap();
        let empty = coding_tool(&state, "read_chat", json!({"chatId":cleared["chatId"]}))
            .await
            .unwrap();
        assert!(empty["messages"].as_array().unwrap().is_empty());
        coding_tool(&state, "delete_chat", json!({"chatId":fork["chatId"]}))
            .await
            .unwrap();
        coding_tool(&state, "delete_chat", json!({"chatId":original}))
            .await
            .unwrap();
        coding_tool(&state, "delete_chat", json!({"chatId":cleared["chatId"]}))
            .await
            .unwrap();
        state
            .providers
            .client(&state.db, "account")
            .await
            .unwrap()
            .shutdown()
            .await;
        server.abort();
    }
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
        (root, state)
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires an installed Codex CLI; uses a fake desktop, isolated home and loopback inference only"]
    async fn installed_codex_agent_delivers_computer_screenshot_as_visual_input() {
        fn has_exec(value: &Value) -> bool {
            match value {
                Value::Array(values) => values.iter().any(has_exec),
                Value::Object(fields) => {
                    (value["name"] == "exec"
                        && matches!(value["type"].as_str(), Some("function" | "custom")))
                        || fields.values().any(has_exec)
                }
                _ => false,
            }
        }
        fn contains_image(value: &Value) -> bool {
            match value {
                Value::Array(values) => values.iter().any(contains_image),
                Value::Object(fields) => {
                    value["type"] == "input_image" || fields.values().any(contains_image)
                }
                _ => false,
            }
        }
        let (root, mut state) = fixture().await;
        state.agents.computer = computer::tests::fixture().0;
        let home = root.path().join("codex-home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
        let count = Arc::new(AtomicU64::new(0));
        let app = Router::new().route("/v1/responses", post(move |Json(request): Json<Value>| {
            let requests = requests.clone();
            let index = count.fetch_add(1, Ordering::Relaxed);
            async move {
                let code_mode = has_exec(&request["tools"]);
                requests.send(request).unwrap();
                let item = if index == 0 && code_mode {
                    json!({"type":"custom_tool_call","id":"fc_screen","call_id":"call_screen",
                        "namespace":"functions","name":"exec","status":"completed",
                        "input":"const result = await tools.computer_screenshot({}); text(result);"})
                } else if index == 0 {
                    json!({"type":"function_call","id":"fc_screen","call_id":"call_screen",
                        "name":"computer_screenshot","arguments":"{}","status":"completed"})
                } else {
                    json!({"type":"message","id":"msg_screen","role":"assistant","status":"completed",
                        "content":[{"type":"output_text","text":"Screen observed","annotations":[]}]})
                };
                let payload = format!("event: response.output_item.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
                    json!({"type":"response.output_item.done","output_index":0,"item":item}),
                    json!({"type":"response.completed","response":{"id":format!("resp_{index}"),
                        "object":"response","created_at":1700000000,"status":"completed","output":[item],
                        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}));
                Response::builder().header("content-type","text/event-stream").body(Body::from(payload)).unwrap()
            }
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        tokio::fs::write(
            home.join("config.toml"),
            format!(
                r#"
model_provider = "boosted_loopback"
[model_providers.boosted_loopback]
name = "Boosted screenshot transport test"
base_url = "http://{address}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[features]
code_mode = true
"#
            ),
        )
        .await
        .unwrap();
        let client = CodexClient::for_account(&home, true).await.unwrap();
        let snapshot = state.agents.get("pock").await.unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            run_turn_with_client(&state, "pock", &snapshot, &[], &[], &client, &mut cancel),
        )
        .await;
        client.shutdown().await;
        server.abort();
        result.unwrap().unwrap();
        let _first = received.try_recv().unwrap();
        let next = received.try_recv().unwrap();
        assert!(
            contains_image(&next["input"]),
            "Screenshot must reach the model as image content: {}",
            next["input"]
                .to_string()
                .chars()
                .take(2000)
                .collect::<String>()
        );
        let agent = state.agents.get("pock").await.unwrap();
        let actions: Vec<_> = agent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["actions"].as_array())
            .flatten()
            .collect();
        let action = actions
            .iter()
            .find(|action| action["tool"] == "computer_screenshot")
            .unwrap();
        assert_eq!(action["status"], "completed");
        assert!(!action["result"].as_str().unwrap().contains("base64"));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires an installed Codex CLI and Python; uses an isolated home and loopback inference only"]
    async fn installed_codex_manager_inspects_without_modifying_project() {
        fn tool_names(tools: &Value) -> Vec<String> {
            match tools {
                Value::Array(values) => values.iter().flat_map(tool_names).collect(),
                Value::Object(fields) => {
                    let mut names: Vec<_> = fields.values().flat_map(tool_names).collect();
                    if matches!(tools["type"].as_str(), Some("function" | "custom")) {
                        if let Some(name) = tools["name"].as_str() {
                            names.push(name.to_owned());
                        }
                    }
                    names
                }
                _ => Vec::new(),
            }
        }
        let (root, state) = fixture().await;
        let home = root.path().join("codex-home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        tokio::fs::write(root.path().join("reference.txt"), "inspection-ok").await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
        let count = Arc::new(AtomicU64::new(0));
        let directory = root.path().to_string_lossy().to_string();
        let app = Router::new()
            .route("/v1/responses", post(move |Json(request):Json<Value>| {
                let requests = requests.clone();
                let index = count.fetch_add(1, Ordering::Relaxed);
                let directory = directory.clone();
                async move {
                    let names = tool_names(&request);
                    let code_mode = names.iter().any(|name| name == "exec");
                    requests.send(request).unwrap();
                    let (name, args) = match index {
                        0 => {
                            let name = if code_mode { "exec_command".into() } else { names.iter().find(|name| matches!(name.as_str(), "exec_command" | "shell_command" | "shell")).expect("Native shell tool").clone() };
                            let command = "cat reference.txt; printf forbidden > manager-write.txt";
                            let args = match name.as_str() {
                                "exec_command" => json!({"cmd":command,"workdir":directory,"yield_time_ms":1000,"max_output_tokens":1000}),
                                "shell_command" => json!({"command":command,"workdir":directory,"timeout_ms":10000}),
                                _ => json!({"command":["sh","-c",command],"workdir":directory,"timeout_ms":10000}),
                            };
                            (name, args)
                        }
                        1 => ("send_agent_message".into(), json!({"content":"Inspection finished."})),
                        _ => (String::new(), Value::Null),
                    };
                    let item = if name.is_empty() {
                        json!({"type":"message","id":"msg_probe","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Invisible final output","annotations":[]}]})
                    } else if code_mode {
                        json!({"type":"custom_tool_call","id":format!("fc_{index}"),"call_id":format!("call_{index}"),"namespace":"functions","name":"exec","input":format!("text(await tools.{name}({args}));"),"status":"completed"})
                    } else {
                        json!({"type":"function_call","id":format!("fc_{index}"),"call_id":format!("call_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"})
                    };
                    let completed = json!({"type":"response.completed","response":{"id":format!("resp_{index}"),"object":"response","created_at":1700000000,"status":"completed","output":[item.clone()],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}});
                    let payload = format!("event: response.output_item.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n", json!({"type":"response.output_item.done","output_index":0,"item":item}), completed);
                    Response::builder().header("content-type","text/event-stream").body(Body::from(payload)).unwrap()
                }
            }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        tokio::fs::write(
            home.join("config.toml"),
            format!(
                r#"
model_provider = "boosted_loopback"
web_search = "disabled"
[features]
shell_tool = false
[model_providers.boosted_loopback]
name = "Boosted disposable native tool test"
base_url = "http://{address}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
"#,
            ),
        )
        .await
        .unwrap();
        let client = CodexClient::for_account(&home, true).await.unwrap();
        let snapshot = state.agents.get("pock").await.unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            run_turn_with_client(&state, "pock", &snapshot, &[], &[], &client, &mut cancel),
        )
        .await;
        result.unwrap().unwrap();
        let _first = received.try_recv().unwrap();
        assert!(!root.path().join("manager-write.txt").exists());
        let agent = state.agents.get("pock").await.unwrap();
        let next_request = received.try_recv().unwrap();
        // Code-mode command calls can return their result without commandExecution
        // notifications. Check the actual tool result sent back to the model.
        let outputs: Vec<_> = next_request["input"].as_array().unwrap().iter()
            .filter(|item| matches!(item["type"].as_str(), Some("custom_tool_call_output" | "function_call_output")))
            .collect();
        let outputs = serde_json::to_string(&outputs).unwrap();
        assert!(outputs.contains("inspection-ok"));
        assert!(outputs.contains("operation not permitted") || outputs.contains("Permission denied"));
        let replies: Vec<_> = agent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| {
                message["content"]
                    .as_str()
                    .is_some_and(|content| !content.is_empty())
            })
            .collect();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["content"], "Inspection finished.");
        client.shutdown().await;
        server.abort();
    }
    #[tokio::test]
    async fn restart_preserves_identity_and_recovers_queued_messages_and_commitments() {
        let (_root, state) = fixture().await;
        change(&state,"pock",|a|{
            a["profile"]["name"]=json!("Nova");a["status"]=json!("running");a["typing"]=json!(true);a["activity"]=json!("working");
            a["messages"]=json!([
                {"id":"message","role":"user","content":"Continue","delivery":"processing"},
                {"id":"receipt","role":"assistant","content":"","actions":[
                    {"id":"unfinished","tool":"commandExecution","status":"running"},
                    {"id":"finished","tool":"commandExecution","status":"completed","result":"saved output"}
                ]}
            ]);
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
        assert_eq!(restored["messages"][1]["actions"][0]["status"], "failed");
        assert_eq!(
            serde_json::from_str::<Value>(
                restored["messages"][1]["actions"][0]["result"]
                    .as_str()
                    .unwrap()
            )
            .unwrap()["resultUnknown"],
            true
        );
        assert_eq!(restored["messages"][1]["actions"][1]["status"], "completed");
        assert_eq!(
            restored["messages"][1]["actions"][1]["result"],
            "saved output"
        );
        assert_eq!(restored["followUps"][0]["status"], "ready");
        assert_eq!(restored["activity"], Value::Null);
        assert!(restored.get("typing").is_none());
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
        assert!(tool_action(
            &state,
            "pock",
            "schedule_follow_up",
            &json!({"instructions":"Check progress","dueAt":"2027-01-01T10:00:00"}),
            &[]
        )
        .await
        .is_err());
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
    async fn messages_send_immediately_and_application_tools_reject_unexpected_fields() {
        let (_root, state) = fixture().await;
        let reply = execute_tool(
            &state,
            "pock",
            "send_agent_message",
            &json!({"content":"Hello"}),
            "reply",
            &[],
        )
        .await
        .unwrap();
        let agent = state.agents.get("pock").await.unwrap();
        assert_eq!(agent["messages"][0]["id"], reply["messageId"]);
        assert_eq!(agent["messages"][0]["content"], "Hello");
        assert_eq!(agent["activity"], Value::Null);
        assert!(execute_tool(
            &state,
            "pock",
            "update_profile",
            &json!({"name":"Nova","shell":"rm"}),
            "call",
            &[]
        )
        .await
        .is_err());
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
    async fn provider_model_presets_persist_validate_and_require_admin() {
        let (_root, state) = fixture().await;
        let admin = AuthUser { id: "admin".into(), username: "Admin".into(), role: "admin".into() };
        let member = AuthUser { role: "member".into(), ..admin.clone() };
        let input = json!({"default":{"model":"exact-alpha","reasoningEffort":"high"},"providers":{"codex":{"model":"exact-beta","reasoningEffort":"low"}}});
        assert!(providers::update_model_presets(State(state.clone()), Extension(member), Json(input.clone())).await.is_err());
        assert_eq!(providers::model_presets(&state.db).await.unwrap()["providers"], json!({}));
        let Json(saved) = providers::update_model_presets(State(state.clone()), Extension(admin.clone()), Json(input.clone())).await.unwrap();
        assert_eq!(providers::read_model_presets(State(state.clone())).await.unwrap().0, saved);
        for invalid in [
            json!({"default":{"model":false,"reasoningEffort":"low"},"providers":{}}),
            json!({"default":{"model":"exact-alpha","reasoningEffort":"bogus"},"providers":{}}),
            json!({"default":input["default"],"providers":{"unknown":input["providers"]["codex"]}}),
        ] {
            assert!(providers::update_model_presets(State(state.clone()), Extension(admin.clone()), Json(invalid)).await.is_err());
            assert_eq!(providers::model_presets(&state.db).await.unwrap(), saved);
        }
        assert_eq!(providers::provider_model_defaults(&state.db, "codex").await.unwrap(), input["providers"]["codex"]);
        let _ = providers::update_model_presets(State(state.clone()), Extension(admin), Json(json!({"default":input["default"],"providers":{}}))).await.unwrap();
        assert_eq!(providers::provider_model_defaults(&state.db, "codex").await.unwrap(), input["default"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_model_presets_initialize_new_chats_and_preserve_overrides() {
        let (root, state, _home) = coding_fixture().await;
        let presets = json!({"id":"model-presets","default":{"model":"exact-alpha","reasoningEffort":"high"},"providers":{"codex":{"model":"exact-beta","reasoningEffort":"low"}}});
        save_document(&state.db, "provider-settings", &presets).await.unwrap();
        let mut account = document(&state.db, "accounts", "account").await.unwrap();
        assert_eq!(providers::account_runtime_defaults(&state.db, &account).await.unwrap()["model"], "exact-alpha");
        account["runtimeDefaults"] = json!({"permissionMode":"readOnly"});
        save_document(&state.db, "accounts", &account).await.unwrap();
        let client = state.providers.client(&state.db, "account").await.unwrap();
        let options = providers::model_options(&state, &client).await.unwrap();
        assert!(options.has_model_preset);
        assert_eq!(options.default_model, "exact-beta");
        assert_eq!(options.models.iter().find(|m| m.model == "exact-beta").unwrap().default_reasoning_effort, "low");
        let chat = coding_tool(&state, "create_chat", json!({"workingDirectory":root.path(),"accountId":"account","title":"Inherited preset","startRun":false})).await.unwrap();
        let defaults = providers::runtime_defaults(&state, chat["chatId"].as_str().unwrap()).await.unwrap().unwrap();
        assert_eq!(defaults["model"], "exact-beta");
        assert_eq!(defaults["reasoningEffort"], "low");
        let override_chat = coding_tool(&state, "create_chat", json!({"workingDirectory":root.path(),"accountId":"account","title":"Chat override","startRun":false,"model":"exact-alpha","reasoningEffort":"high"})).await.unwrap();
        let overrides = providers::runtime_defaults(&state, override_chat["chatId"].as_str().unwrap()).await.unwrap().unwrap();
        assert_eq!(overrides["model"], "exact-alpha");
        assert_eq!(overrides["reasoningEffort"], "high");
        save_document(&state.db, "provider-settings", &json!({"id":"model-presets","default":presets["default"],"providers":{}})).await.unwrap();
        assert_eq!(providers::runtime_defaults(&state, chat["chatId"].as_str().unwrap()).await.unwrap().unwrap(), defaults);
        account["runtimeDefaults"] = json!({"model":"exact-beta"});
        let defaults = providers::account_runtime_defaults(&state.db, &account).await.unwrap();
        assert_eq!(defaults["model"], "exact-beta");
        assert!(defaults.get("reasoningEffort").is_none());
        save_document(&state.db, "provider-settings", &json!({"id":"model-presets","default":{"model":"missing","reasoningEffort":"low"},"providers":{}})).await.unwrap();
        assert!(providers::model_options(&state, &client).await.is_err());
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
    async fn real_stdio_transport_enables_native_tools_and_deduplicates_replies() {
        use std::os::unix::fs::PermissionsExt;
        let (root, mut state) = fixture().await;
        state.agents.computer = computer::tests::fixture().0;
        let mut updates = state.live.subscribe();
        let script = root.path().join("fake-codex");
        std::fs::write(&script,r#"#!/usr/bin/env python3
import sys,json
stage=0
calls=[('update_profile',{'name':'Nova'},'profile'),('send_agent_message',{'content':'Ready to work.'},'reply'),('send_agent_message',{'content':'Ready to work.'},'reply'),('computer_screenshot',{},'screen'),('computer_action',{'action':'click','x':20,'y':10},'click')]
def emit(v):
 print(json.dumps(v),flush=True)
def call(i):
 name,args,call_id=calls[i]
 if name=='computer_action':args['screenshotId']=screenshot_id
 emit({'id':700+i,'method':'item/tool/call','params':{'threadId':'agent-thread','callId':call_id,'tool':name,'arguments':args}})
for line in sys.stdin:
 m=json.loads(line)
 method=m.get('method')
 if method=='initialize':emit({'id':m['id'],'result':{}})
 elif method=='thread/start':
  p=m['params']
  assert p['sandbox']=='read-only' and p['ephemeral'] is True
  assert p['approvalPolicy']=='never'
  assert p['config']['features.shell_tool'] is True
  assert p['config']['web_search']=='live'
  assert 'mcp_servers' not in p['config']
  assert 'features.apply_patch_tool' not in p['config']
  assert len(p['dynamicTools'])==30
  assert all(t['name']!='set_typing' for t in p['dynamicTools'])
  assert 'computer-control' in p['developerInstructions']
  emit({'id':m['id'],'result':{'thread':{'id':'agent-thread'}}})
 elif method=='turn/start':
  assert m['params']['sandboxPolicy']=={'type':'readOnly','networkAccess':True}
  emit({'id':m['id'],'result':{'turn':{'id':'turn'}}})
  emit({'method':'item/agentMessage/delta','params':{'threadId':'other-thread','delta':'Ignore this activity.'}})
  emit({'method':'item/started','params':{'threadId':'agent-thread','item':{'id':'reason','type':'reasoning'}}})
  for _ in range(10):
   emit({'method':'item/reasoning/summaryTextDelta','params':{'threadId':'agent-thread','itemId':'reason','delta':'Thinking'}})
  for kind,fields in [('commandExecution',{'command':'glab issue list','cwd':'/project','exitCode':0,'aggregatedOutput':'Issue 42'}),('commandExecution',{'command':'missing-cli','exitCode':127,'aggregatedOutput':'command not found'}),('mcpToolCall',{'server':'example','tool':'lookup','arguments':{},'error':{'message':'Access denied'}}),('fileChange',{'changes':[]})]:
   item={'id':str(len(fields))+kind,'type':kind,'status':'inProgress',**fields}
   emit({'method':'item/started','params':{'threadId':'agent-thread','item':item}})
   emit({'method':'item/completed','params':{'threadId':'agent-thread','item':{**item,'status':'completed'}}})
   emit({'method':'item/started','params':{'threadId':'agent-thread','item':item}})
  emit({'method':'item/agentMessage/delta','params':{'threadId':'agent-thread','delta':'Ordinary output must stay invisible.'}})
  call(0)
 elif method=='thread/backgroundTerminals/clean':emit({'id':m['id'],'result':{}})
 elif method is None and 'result' in m:
  assert m['result']['success'] is True
  if stage==3:
   content=m['result']['contentItems']
   screenshot_id=json.loads(content[0]['text'])['screenshotId']
   assert content[1]['type']=='inputImage' and content[1]['imageUrl'].startswith('data:image/png;base64,')
  stage+=1
  if stage<len(calls):call(stage)
  else:emit({'method':'turn/completed','params':{'threadId':'agent-thread','turn':{'id':'turn','status':'completed'}}})
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexClient::test_process(script, true).await.unwrap();
        let snapshot = state.agents.get("pock").await.unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        run_turn_with_client(&state, "pock", &snapshot, &[], &[], &client, &mut cancel)
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
        assert_eq!(agent["activity"], Value::Null);
        let mut activities = Vec::new();
        while let Ok(update) = updates.try_recv() {
            if update.topic == "assistant.updated" {
                activities.push(update.data["activity"].clone());
            }
        }
        // Startup is visible without a model tool call; repeated reasoning deltas and
        // other threads do not publish redundant or unrelated activity updates.
        assert_eq!(activities[0], "thinking");
        assert_eq!(activities[1], "working");
        assert!(activities.contains(&json!("responding")));
        assert_eq!(activities.last(), Some(&Value::Null));
        let actions: Vec<_> = agent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["actions"].as_array())
            .flatten()
            .filter(|action| action["id"].as_str().unwrap().starts_with("agent-thread:"))
            .collect();
        assert_eq!(actions.len(), 4);
        assert_eq!(actions[0]["status"], "completed");
        assert_eq!(actions[0]["workingDirectory"], "/project");
        assert!(actions[0]["result"].as_str().unwrap().contains("Issue 42"));
        assert_eq!(actions[1]["status"], "failed");
        assert_eq!(actions[2]["status"], "failed");
        assert_eq!(actions[3]["status"], "completed");
        let screen_action = agent["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message["actions"].as_array())
            .flatten()
            .find(|action| action["tool"] == "computer_screenshot")
            .unwrap();
        assert_eq!(screen_action["status"], "completed");
        assert!(!screen_action["result"].as_str().unwrap().contains("base64"));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires an installed Codex CLI; uses isolated home and loopback inference only"]
    async fn installed_codex_agent_model_handoff_preserves_tool_results() {
        use std::sync::atomic::AtomicBool;
        fn has_exec(value: &Value) -> bool {
            match value {
                Value::Array(values) => values.iter().any(has_exec),
                Value::Object(fields) => value["name"] == "exec" || fields.values().any(has_exec),
                _ => false,
            }
        }
        let (root, state) = fixture().await;
        let home = root.path().join("codex-home");
        tokio::fs::create_dir_all(&home).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
        let low_called = Arc::new(AtomicBool::new(false));
        let medium_called = Arc::new(AtomicBool::new(false));
        let app = Router::new().route("/v1/responses", post(move |Json(request): Json<Value>| {
            let requests = requests.clone();
            let first_low = request["model"] == "gpt-6.1-sol" && request["reasoning"]["effort"] == "low" && !low_called.swap(true, Ordering::Relaxed);
            let first_medium = request["model"] == "gpt-6.1-sol" && request["reasoning"]["effort"] == "medium" && !medium_called.swap(true, Ordering::Relaxed);
            async move {
                let code_mode = has_exec(&request["tools"]);
                let model = request["model"].clone();
                let effort = request["reasoning"]["effort"].clone();
                requests.send(request).unwrap();
                if effort == "low" && !first_low {
                    // The old model may race ahead after receiving its tool result.
                    // Its pending inference must be cancelled by the handoff.
                    return Response::builder().header("content-type", "text/event-stream")
                        .body(Body::from_stream(futures_util::stream::pending::<Result<String, std::convert::Infallible>>())).unwrap();
                }
                let (name, args, call_id) = if first_low {
                    ("select_agent_model", json!({"model":"gpt-6.1-sol","reason":"Complex debugging"}), "select")
                } else {
                    ("send_agent_message", json!({"content":"Work complete."}), "reply")
                };
                let item = if first_low || first_medium {
                    if code_mode {
                        json!({"type":"custom_tool_call","id":format!("fc_{call_id}"),"call_id":call_id,
                            "namespace":"functions","name":"exec","status":"completed",
                            "input":format!("const result = await tools.{name}({args}); text(result);")})
                    } else {
                        json!({"type":"function_call","id":format!("fc_{call_id}"),"call_id":call_id,
                            "name":name,"arguments":args.to_string(),"status":"completed"})
                    }
                } else {
                    json!({"type":"message","id":"final","role":"assistant","status":"completed",
                        "content":[{"type":"output_text","text":"Finished","annotations":[]}]})
                };
                let payload = format!("event: response.output_item.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
                    json!({"type":"response.output_item.done","output_index":0,"item":item}),
                    json!({"type":"response.completed","response":{"id":format!("resp_{call_id}_{model}"),
                        "object":"response","created_at":1700000000,"status":"completed","output":[item],
                        "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}));
                Response::builder().header("content-type", "text/event-stream").body(Body::from(payload)).unwrap()
            }
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        tokio::fs::write(
            home.join("config.toml"),
            format!(
                r#"
model_provider = "boosted_loopback"
[model_providers.boosted_loopback]
name = "Boosted model handoff test"
base_url = "http://{address}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
"#
            ),
        )
        .await
        .unwrap();
        let client = CodexClient::for_account(&home, true).await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            model_routing_turn(&state, &client, "handoff"),
        )
        .await;
        client.shutdown().await;
        server.abort();
        result.unwrap().unwrap();
        let mut captured = Vec::new();
        while let Ok(request) = received.try_recv() {
            captured.push(request);
        }
        assert_eq!(captured[0]["model"], "gpt-6.1-sol");
        assert_eq!(captured[0]["reasoning"]["effort"], "low");
        let sol = captured
            .iter()
            .find(|request| {
                request["model"] == "gpt-6.1-sol" && request["reasoning"]["effort"] == "medium"
            })
            .unwrap();
        assert!(
            sol["input"].to_string().contains("queued"),
            "Tool result missing after handoff"
        );
        let agent = state.agents.get("pock").await.unwrap();
        assert_eq!(
            agent["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["content"] == "Work complete.")
                .count(),
            1
        );
    }

    #[cfg(unix)]
    async fn model_routing_fixture() -> (tempfile::TempDir, AppState, CodexClient) {
        use std::os::unix::fs::PermissionsExt;
        let (root, state) = fixture().await;
        let script = root.path().join("fake-codex");
        std::fs::write(
            &script,
            include_str!("../tests/fixtures/agent-model-app-server.py"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexClient::test_process_with_home(script, Some(root.path()), true)
            .await
            .unwrap();
        (root, state, client)
    }

    #[cfg(unix)]
    async fn model_routing_turn(
        state: &AppState,
        client: &CodexClient,
        scenario: &str,
    ) -> AppResult<()> {
        let snapshot = state.agents.get("pock").await?;
        let (_sender, mut cancel) = watch::channel(false);
        run_turn_with_client(
            state,
            "pock",
            &snapshot,
            &[json!({"id":scenario,"content":scenario})],
            &[],
            client,
            &mut cancel,
        )
        .await
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_usage_stream_records_handoffs_without_counting_duplicate_notifications() {
        use std::os::unix::fs::PermissionsExt;
        let (root, state) = fixture().await;
        let script = root.path().join("usage-codex");
        let source = include_str!("../tests/fixtures/agent-model-app-server.py").replace(
            "def complete(status=\"completed\", error=None):",
            "def complete(status=\"completed\", error=None):\n    for _ in range(2):\n        emit({\"method\":\"thread/tokenUsage/updated\",\"params\":{\"threadId\":thread_id,\"turnId\":turn_id,\"tokenUsage\":{\"total\":{\"totalTokens\":turn_count * 100}}}})",
        );
        std::fs::write(&script, source).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexClient::test_process_with_home(script, Some(root.path()), true).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), model_routing_turn(&state, &client, "handoff")).await.unwrap().unwrap();
        client.shutdown().await;
        let total: i64 = sqlx::query_scalar("SELECT SUM(tokens) FROM agent_usage_buckets WHERE agent_id='pock'")
            .fetch_one(&state.db.pool).await.unwrap();
        assert_eq!(total, 200);
        let Json(usage) = agent_usage::read_usage(State(state.clone()), Query(agent_usage::UsageQuery { days: Some(7) })).await.unwrap();
        assert_eq!(usage["series"][0]["agentId"], "pock");
        let tokens: i64 = usage["series"][0]["buckets"].as_array().unwrap().iter()
            .map(|bucket| bucket["tokens"].as_i64().unwrap()).sum();
        assert_eq!(tokens, 200);
        assert!(usage["trackedSince"].is_string());
        assert!(agent_usage::read_usage(State(state), Query(agent_usage::UsageQuery { days: Some(0) })).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_model_routing_handoffs_preserve_context_and_reset_to_normal() {
        let (root, state, client) = model_routing_fixture().await;
        tokio::time::timeout(Duration::from_secs(10), async {
            model_routing_turn(&state, &client, "handoff")
                .await
                .unwrap();
            model_routing_turn(&state, &client, "simple").await.unwrap();
        })
        .await
        .unwrap();
        client.shutdown().await;
        let log = rpc_log(root.path());
        let starts: Vec<_> = log.iter().filter(|m| m["method"] == "turn/start").collect();
        assert_eq!(starts.len(), 3);
        // A persisted rename updates the next turn's identity, including after a handoff.
        for (start, expected_name) in [(starts[0], "Pock"), (starts[2], "Nova")] {
            let prompt: Value =
                serde_json::from_str(start["params"]["input"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(
                prompt["agentIdentity"],
                json!({"agentId":"pock","name":expected_name})
            );
        }
        assert_eq!(starts[0]["params"]["model"], "gpt-6.1-sol");
        assert_eq!(starts[0]["params"]["effort"], "low");
        assert_eq!(starts[1]["params"]["model"], "gpt-6.1-sol");
        assert_eq!(starts[1]["params"]["effort"], "medium");
        assert_eq!(
            starts[0]["params"]["threadId"],
            starts[1]["params"]["threadId"]
        );
        assert_eq!(
            starts[0]["params"]["sandboxPolicy"],
            starts[1]["params"]["sandboxPolicy"]
        );
        assert_eq!(starts[2]["params"]["model"], "gpt-6.1-sol");
        assert_eq!(starts[2]["params"]["effort"], "low");
        assert_ne!(
            starts[1]["params"]["threadId"],
            starts[2]["params"]["threadId"]
        );
        assert_eq!(
            log.iter()
                .filter(|m| m["method"] == "turn/interrupt")
                .count(),
            1
        );
        assert_eq!(
            log.iter().filter(|m| m["method"] == "model/list").count(),
            1
        );
        let agent = state.agents.get("pock").await.unwrap();
        assert_eq!(agent["profile"]["name"], "Nova");
        let messages = agent["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["content"] == "Work complete.")
                .count(),
            1
        );
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["content"] == "I am checking this now.")
                .count(),
            2
        );
        let selections: Vec<_> = messages
            .iter()
            .filter_map(|m| m["actions"].as_array())
            .flatten()
            .filter(|a| a["tool"] == "select_agent_model")
            .collect();
        assert_eq!(selections.len(), 1);
        assert_eq!(selections[0]["status"], "completed");
        assert_eq!(agent["activity"], Value::Null);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_model_routing_rejects_unavailable_models_and_preserves_failures() {
        for scenario in ["invalid", "unavailable", "bad-effort", "failure"] {
            let (root, state, client) = model_routing_fixture().await;
            let result = tokio::time::timeout(
                Duration::from_secs(10),
                model_routing_turn(&state, &client, scenario),
            )
            .await
            .unwrap();
            if scenario == "failure" {
                assert!(result.unwrap_err().to_string().contains("usage limit"));
            } else {
                result.unwrap();
            }
            client.shutdown().await;
            let log = rpc_log(root.path());
            assert_eq!(
                log.iter().filter(|m| m["method"] == "turn/start").count(),
                1
            );
            let agent = state.agents.get("pock").await.unwrap();
            assert_eq!(agent["activity"], Value::Null);
            let selection = agent["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|m| m["actions"].as_array())
                .flatten()
                .find(|a| a["tool"] == "select_agent_model")
                .unwrap();
            assert_eq!(
                selection["status"],
                if scenario == "failure" {
                    "completed"
                } else {
                    "failed"
                }
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_model_routing_bounds_escalation_and_stops_the_active_model() {
        let (root, state, client) = model_routing_fixture().await;
        tokio::time::timeout(
            Duration::from_secs(10),
            model_routing_turn(&state, &client, "deep"),
        )
        .await
        .unwrap()
        .unwrap();
        client.shutdown().await;
        let log = rpc_log(root.path());
        let models: Vec<_> = log
            .iter()
            .filter(|m| m["method"] == "turn/start")
            .map(|m| m["params"]["model"].as_str().unwrap())
            .collect();
        assert_eq!(models, ["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6-astra"]);
        let agent = state.agents.get("pock").await.unwrap();
        assert!(
            agent["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|m| m["actions"].as_array())
                .flatten()
                .any(|a| a["id"] == "downgrade" && a["status"] == "failed")
        );

        let (root, state, client) = model_routing_fixture().await;
        let mut notifications = client.subscribe();
        let snapshot = state.agents.get("pock").await.unwrap();
        let (sender, mut cancel) = watch::channel(false);
        let stop = async {
            loop {
                let event = notifications.recv().await.unwrap();
                if event["method"] == "item/started" {
                    loop {
                        let agent = state.agents.get("pock").await.unwrap();
                        if agent["messages"].as_array().unwrap().iter()
                            .filter_map(|message| message["actions"].as_array())
                            .flatten().any(|action| action["tool"] == "commandExecution") {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                    sender.send(true).unwrap();
                    break;
                }
            }
        };
        let current = [json!({"id":"cancel","content":"cancel"})];
        let (result, _) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                run_turn_with_client(
                    &state,
                    "pock",
                    &snapshot,
                    &current,
                    &[],
                    &client,
                    &mut cancel
                ),
                stop
            )
        })
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("Agent stopped"));
        client.shutdown().await;
        let log = rpc_log(root.path());
        let interrupts: Vec<_> = log
            .iter()
            .filter(|m| m["method"] == "turn/interrupt")
            .collect();
        assert_eq!(interrupts.len(), 2);
        assert_eq!(interrupts[1]["params"]["turnId"], "turn-2");
        assert_eq!(
            log.last().unwrap()["method"],
            "thread/backgroundTerminals/clean"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_agent_interrupts_turn_and_cleans_native_terminals() {
        use std::os::unix::fs::PermissionsExt;
        let (root, state) = fixture().await;
        let script = root.path().join("fake-codex");
        std::fs::write(&script, r#"#!/usr/bin/env python3
import sys,json,os
def emit(v):print(json.dumps(v),flush=True)
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 if method=='initialize':emit({'id':m['id'],'result':{}})
 elif method=='thread/start':emit({'id':m['id'],'result':{'thread':{'id':'agent-thread'}}})
 elif method=='turn/start':
  emit({'id':m['id'],'result':{'turn':{'id':'native-turn'}}})
  emit({'method':'item/started','params':{'threadId':'agent-thread','item':{'id':'command','type':'commandExecution','command':'long-running-command','status':'inProgress'}}})
 elif method in ['turn/interrupt','thread/backgroundTerminals/clean']:
  with open(os.path.join(os.environ['CODEX_HOME'],'cleanup.jsonl'),'a') as f:f.write(json.dumps(m)+'\n')
  emit({'id':m['id'],'result':{}})
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let client = CodexClient::test_process_with_home(script, Some(root.path()), true)
            .await
            .unwrap();
        let mut notifications = client.subscribe();
        let snapshot = state.agents.get("pock").await.unwrap();
        let (sender, mut cancel) = watch::channel(false);
        let stop = async {
            loop {
                let event = notifications.recv().await.unwrap();
                if event["method"] == "item/started" {
                    // Wait until the running receipt is persisted before stopping.
                    loop {
                        let agent = state.agents.get("pock").await.unwrap();
                        if agent["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|m| m["actions"].is_array())
                        {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                    sender.send(true).unwrap();
                    break;
                }
            }
        };
        let (result, _) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                run_turn_with_client(&state, "pock", &snapshot, &[], &[], &client, &mut cancel),
                stop
            )
        })
        .await
        .unwrap();
        assert!(result.unwrap_err().to_string().contains("Agent stopped"));
        client.shutdown().await;
        let cleanup: Vec<Value> = std::fs::read_to_string(root.path().join("cleanup.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(cleanup[0]["method"], "turn/interrupt");
        assert_eq!(cleanup[0]["params"]["turnId"], "native-turn");
        assert_eq!(cleanup[1]["method"], "thread/backgroundTerminals/clean");
        let agent = state.agents.get("pock").await.unwrap();
        assert_eq!(agent["activity"], Value::Null);
        let action = &agent["messages"][0]["actions"][0];
        assert_eq!(action["status"], "failed");
        assert!(
            serde_json::from_str::<Value>(action["result"].as_str().unwrap()).unwrap()
                ["resultUnknown"]
                .as_bool()
                .unwrap()
        );
    }
}

pub(crate) async fn set_group_status(
    state: &AppState,
    id: &str,
    context: Option<&groups::GroupContext>,
) -> AppResult<()> {
    change(state, id, |a| {
        a["status"] = json!(if context.is_some() { "running" } else { "idle" });
        a["activity"] = if context.is_some() {
            json!("thinking")
        } else {
            Value::Null
        };
        a["activeGroupId"] = json!(context.map(|c| &c.group_id));
        Ok(())
    })
    .await?;
    Ok(())
}

pub(crate) async fn set_group_account(state: &AppState, id: &str, account: &str) -> AppResult<()> {
    change(state, id, |a| {
        a["accountId"] = json!(account);
        Ok(())
    })
    .await?;
    Ok(())
}
