//! Durable Slack and Telegram gateways for isolated agent conversations.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use providers::{document, documents, save_document, text};
use reqwest::Client;
use serde_json::{Value, json};
use sha2::Digest;
use std::future::Future;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, watch};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const CONNECTIONS: &str = "agent-integrations";
const CHATS: &str = "agent-integration-chats";
const SESSIONS: &str = "agent-integration-sessions";
const EVENTS: &str = "agent-integration-events";
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 10 * 1024 * 1024;
const SLACK_MANIFEST: &str = r#"display_information:
  name: Boosted Agent
features:
  bot_user:
    display_name: Boosted Agent
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - chat:write
      - files:read
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  socket_mode_enabled: true
  token_rotation_enabled: false
"#;

#[derive(Clone)]
pub(crate) struct AgentIntegrationManager {
    secrets_dir: PathBuf,
    connectors: Arc<Mutex<HashMap<String, (Uuid, watch::Sender<bool>)>>>,
    sessions: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}

impl AgentIntegrationManager {
    pub(crate) async fn new(secrets_dir: PathBuf) -> AppResult<Self> {
        tokio::fs::create_dir_all(&secrets_dir).await?;
        providers::private_directory(&secrets_dir).await?;
        Ok(Self {
            secrets_dir,
            connectors: Default::default(),
            sessions: Default::default(),
        })
    }

    fn secret_path(&self, id: &str) -> PathBuf {
        self.secrets_dir.join(format!("{id}.json"))
    }

    async fn secrets(&self, id: &str) -> AppResult<Value> {
        let bytes = tokio::fs::read(self.secret_path(id))
            .await
            .map_err(|_| AppError::Conflict("Integration credentials are missing".into()))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| AppError::Internal("Invalid integration credentials".into()))
    }

    async fn write_secrets(&self, id: &str, value: &Value) -> AppResult<()> {
        let path = self.secret_path(id);
        let temporary = self.secrets_dir.join(format!(".{id}.tmp"));
        tokio::fs::write(&temporary, serde_json::to_vec(value)?).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?;
        }
        #[cfg(windows)]
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::remove_file(&path).await?;
        }
        tokio::fs::rename(temporary, path).await?;
        Ok(())
    }

    async fn stop_connector(&self, id: &str) {
        if let Some((_, stop)) = self.connectors.lock().await.remove(id) {
            let _ = stop.send(true);
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ExternalContext {
    pub integration_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub provider: String,
    pub chat_name: String,
}

tokio::task_local! { static CONTEXT: ExternalContext; }

pub(crate) fn context() -> Option<ExternalContext> {
    CONTEXT.try_with(Clone::clone).ok()
}

pub(crate) async fn context_for_session(
    db: &Database,
    session_id: &str,
) -> AppResult<ExternalContext> {
    let session = document(db, SESSIONS, session_id).await?;
    Ok(ExternalContext {
        integration_id: session["integrationId"].as_str().unwrap_or_default().into(),
        session_id: session_id.into(),
        agent_id: session["agentId"].as_str().unwrap_or_default().into(),
        provider: session["provider"].as_str().unwrap_or_default().into(),
        chat_name: session["chatName"].as_str().unwrap_or_default().into(),
    })
}

pub(crate) async fn scope<F: Future>(context: ExternalContext, future: F) -> F::Output {
    CONTEXT.scope(context, future).await
}

pub(crate) async fn record_error(
    state: &AppState,
    session_id: &str,
    error: &AppError,
) -> AppResult<()> {
    update_session(state, session_id, |session| {
        session["error"] = json!(error.to_string());
        Ok(())
    })
    .await?;
    Ok(())
}

pub(crate) async fn migrate(db: &Database) -> AppResult<()> {
    // Records intentionally use the existing feature-document store so older
    // installations need no destructive schema migration.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS feature_documents_namespace ON feature_documents(namespace)",
    )
    .execute(&db.pool)
    .await?;
    for mut session in documents(db, SESSIONS).await? {
        session["status"] = json!("idle");
        session["activity"] = Value::Null;
        for message in session["messages"].as_array_mut().into_iter().flatten() {
            if message["delivery"] == "processing" {
                message["delivery"] = json!("queued");
            }
            if message["role"] == "assistant" && message["delivery"] == "sending" {
                message["delivery"] = json!("failed");
                message["deliveryError"] = json!(
                    "Server restarted before delivery was confirmed. The message may have been partially delivered."
                );
            }
            for action in message["actions"].as_array_mut().into_iter().flatten() {
                if action["status"] == "running" {
                    action["status"] = json!("failed");
                    action["result"] = json!(json!({"error":"Server restarted before the action result was saved.","resultUnknown":true}).to_string());
                }
            }
        }
        for followup in session["followUps"].as_array_mut().into_iter().flatten() {
            if followup["status"] == "processing" {
                followup["status"] = json!("ready");
            }
        }
        save_document(db, SESSIONS, &session).await?;
    }
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn clean_error(error: impl ToString) -> String {
    let value = error.to_string();
    let lower = value.to_lowercase();
    if lower.contains("xoxb-") || lower.contains("xapp-") || lower.contains("/bot") {
        "The provider rejected the connection credentials".into()
    } else if lower.contains("wss://") || lower.contains("ticket=") {
        "Slack Socket Mode connection failed".into()
    } else {
        value.chars().take(500).collect()
    }
}

async fn update_connection<F>(state: &AppState, id: &str, update: F) -> AppResult<Value>
where
    F: FnOnce(&mut Value),
{
    let mut value = document(&state.db, CONNECTIONS, id).await?;
    update(&mut value);
    value["updatedAt"] = json!(now());
    save_document(&state.db, CONNECTIONS, &value).await?;
    state.emit(
        "agent-integration.updated",
        json!({"agentId":value["agentId"],"integrationId":id}),
    );
    Ok(value)
}

async fn update_session<F>(state: &AppState, id: &str, update: F) -> AppResult<Value>
where
    F: FnOnce(&mut Value) -> AppResult<()>,
{
    let mut value = document(&state.db, SESSIONS, id).await?;
    update(&mut value)?;
    value["updatedAt"] = json!(now());
    save_document(&state.db, SESSIONS, &value).await?;
    state.emit(
        "agent-integration.session",
        json!({"agentId":value["agentId"],"integrationId":value["integrationId"],"sessionId":id}),
    );
    Ok(value)
}

fn public_connection(value: &Value, chats: Vec<Value>) -> Value {
    json!({
        "id":value["id"], "agentId":value["agentId"], "provider":value["provider"],
        "name":value["name"], "enabled":value["enabled"], "bot":value["bot"],
        "workspace":value["workspace"], "status":value["status"],
        "lastConnectedAt":value["lastConnectedAt"], "lastActivityAt":value["lastActivityAt"],
        "lastError":value["lastError"], "createdAt":value["createdAt"], "updatedAt":value["updatedAt"],
        "hasBotToken":true, "hasAppToken":value["provider"] == "slack", "chats":chats.into_iter().map(|chat| public_chat(&chat)).collect::<Vec<_>>(),
        "slackManifest":if value["provider"] == "slack" { Value::String(SLACK_MANIFEST.into()) } else { Value::Null }
    })
}

fn public_chat(value: &Value) -> Value {
    json!({
        "id":value["id"], "integrationId":value["integrationId"],
        "externalId":value["externalId"], "name":value["name"], "kind":value["kind"],
        "status":value["status"], "approvedAt":value["approvedAt"],
        "lastSeenAt":value["lastSeenAt"], "createdAt":value["createdAt"]
    })
}

async fn connection_chats(db: &Database, integration_id: &str) -> AppResult<Vec<Value>> {
    let mut chats: Vec<_> = documents(db, CHATS)
        .await?
        .into_iter()
        .filter(|chat| chat["integrationId"] == integration_id)
        .collect();
    chats.sort_by_key(|chat| {
        std::cmp::Reverse(chat["lastSeenAt"].as_str().unwrap_or_default().to_owned())
    });
    Ok(chats)
}

pub(crate) async fn list(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
) -> AppResult<Json<Vec<Value>>> {
    state.agents.get(&agent_id).await?;
    let mut result = Vec::new();
    for value in documents(&state.db, CONNECTIONS)
        .await?
        .into_iter()
        .filter(|value| value["agentId"] == agent_id)
    {
        result.push(public_connection(
            &value,
            connection_chats(&state.db, value["id"].as_str().unwrap_or_default()).await?,
        ));
    }
    result.sort_by_key(|entry| entry["createdAt"].as_str().unwrap_or_default().to_owned());
    Ok(Json(result))
}

async fn validate_slack(client: &Client, secrets: &Value) -> AppResult<(Value, String)> {
    let bot_token = text(secrets, "botToken", 500)?;
    let app_token = text(secrets, "appToken", 500)?;
    if !bot_token.starts_with("xoxb-") || !app_token.starts_with("xapp-") {
        return Err(AppError::BadRequest(
            "Slack requires xoxb- bot and xapp- app tokens".into(),
        ));
    }
    let auth: Value = client
        .post("https://slack.com/api/auth.test")
        .bearer_auth(&bot_token)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(clean_error(e)))?
        .json()
        .await
        .map_err(|_| AppError::BadRequest("Slack returned an invalid response".into()))?;
    if auth["ok"] != true {
        return Err(AppError::BadRequest(
            auth["error"]
                .as_str()
                .unwrap_or("Slack rejected the bot token")
                .into(),
        ));
    }
    let opened: Value = client
        .post("https://slack.com/api/apps.connections.open")
        .bearer_auth(&app_token)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(clean_error(e)))?
        .json()
        .await
        .map_err(|_| AppError::BadRequest("Slack returned an invalid response".into()))?;
    if opened["ok"] != true || opened["url"].as_str().is_none() {
        return Err(AppError::BadRequest(
            opened["error"]
                .as_str()
                .unwrap_or("Slack rejected the app token")
                .into(),
        ));
    }
    Ok((
        json!({"id":auth["user_id"],"name":auth["user"],"username":auth["user"]}),
        auth["team"].as_str().unwrap_or_default().to_owned(),
    ))
}

async fn telegram_call(
    client: &Client,
    token: &str,
    method: &str,
    body: Option<&Value>,
) -> AppResult<Value> {
    let url = format!("https://api.telegram.org/bot{token}/{method}");
    for attempt in 0..=3 {
        let mut request = client.post(&url);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response: Value = request
            .send()
            .await
            .map_err(|e| AppError::BadRequest(clean_error(e)))?
            .json()
            .await
            .map_err(|_| AppError::BadRequest("Telegram returned an invalid response".into()))?;
        if response["ok"] == true {
            return Ok(response["result"].clone());
        }
        if response["error_code"] == 429 && attempt < 3 {
            let delay = response
                .pointer("/parameters/retry_after")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .min(60);
            tokio::time::sleep(Duration::from_secs(delay)).await;
            continue;
        }
        return Err(AppError::BadRequest(
            response["description"]
                .as_str()
                .unwrap_or("Telegram rejected the request")
                .into(),
        ));
    }
    Err(AppError::Conflict(
        "Telegram rate limit retry failed".into(),
    ))
}

async fn slack_post_message(client: &Client, token: &str, body: &Value) -> AppResult<Value> {
    for attempt in 0..=3 {
        let response = client
            .post("https://slack.com/api/chat.postMessage")
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(|error| AppError::Internal(clean_error(error)))?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < 3 {
            let delay = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(1)
                .min(60);
            tokio::time::sleep(Duration::from_secs(delay)).await;
            continue;
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| AppError::Internal("Slack returned invalid JSON".into()))?;
        if value["ok"] == true {
            return Ok(value);
        }
        return Err(AppError::Conflict(
            value["error"]
                .as_str()
                .unwrap_or("Slack message failed")
                .into(),
        ));
    }
    Err(AppError::Conflict("Slack rate limit retry failed".into()))
}

async fn validate_telegram(client: &Client, secrets: &Value) -> AppResult<(Value, String)> {
    let token = text(secrets, "botToken", 500)?;
    let bot = telegram_call(client, &token, "getMe", None).await?;
    let webhook = telegram_call(client, &token, "getWebhookInfo", None).await?;
    if webhook["url"].as_str().is_some_and(|url| !url.is_empty()) {
        return Err(AppError::Conflict("This Telegram bot has an active webhook. Remove it or use a separate bot before enabling Boosted long polling".into()));
    }
    Ok((
        json!({"id":bot["id"],"name":bot["first_name"],"username":bot["username"]}),
        String::new(),
    ))
}

async fn validate(provider: &str, secrets: &Value) -> AppResult<(Value, String)> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(AppError::internal)?;
    match provider {
        "slack" => validate_slack(&client, secrets).await,
        "telegram" => validate_telegram(&client, secrets).await,
        _ => Err(AppError::BadRequest(
            "Provider must be slack or telegram".into(),
        )),
    }
}

pub(crate) async fn create(
    State(state): State<AppState>,
    AxumPath(agent_id): AxumPath<String>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_admin(&user)?;
    state.agents.get(&agent_id).await?;
    let provider = text(&input, "provider", 40)?;
    let name = text(&input, "name", 120)?;
    let secrets = json!({"botToken":text(&input,"botToken",500)?,"appToken":input["appToken"].as_str().unwrap_or_default()});
    let (bot, workspace) = validate(&provider, &secrets).await?;
    let id = Uuid::new_v4().to_string();
    let enabled = input["enabled"].as_bool().unwrap_or(true);
    let value = json!({"id":id,"agentId":agent_id,"provider":provider,"name":name,"enabled":enabled,"bot":bot,"workspace":workspace,"status":if enabled { "starting" } else { "disabled" },"lastConnectedAt":null,"lastActivityAt":null,"lastError":null,"cursor":null,"createdBy":user.id,"createdAt":now(),"updatedAt":now()});
    state
        .agent_integrations
        .write_secrets(&id, &secrets)
        .await?;
    if let Err(error) = save_document(&state.db, CONNECTIONS, &value).await {
        let _ = tokio::fs::remove_file(state.agent_integrations.secret_path(&id)).await;
        return Err(error);
    }
    state.emit(
        "agent-integration.updated",
        json!({"agentId":agent_id,"integrationId":id}),
    );
    sync_connectors(&state).await?;
    Ok((StatusCode::CREATED, Json(public_connection(&value, vec![]))))
}

pub(crate) async fn update(
    State(state): State<AppState>,
    AxumPath((agent_id, integration_id)): AxumPath<(String, String)>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    ensure_admin(&user)?;
    let current = document(&state.db, CONNECTIONS, &integration_id).await?;
    if current["agentId"] != agent_id {
        return Err(AppError::NotFound("Agent integration not found".into()));
    }
    let mut secrets = state.agent_integrations.secrets(&integration_id).await?;
    let mut credentials_changed = false;
    if let Some(value) = input["botToken"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
    {
        secrets["botToken"] = json!(value);
        credentials_changed = true;
    }
    if let Some(value) = input["appToken"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
    {
        secrets["appToken"] = json!(value);
        credentials_changed = true;
    }
    let enabled = input["enabled"]
        .as_bool()
        .unwrap_or(current["enabled"].as_bool().unwrap_or(true));
    let reconnect = input["reconnect"].as_bool() == Some(true);
    let must_validate =
        credentials_changed || reconnect || (enabled && current["enabled"].as_bool() != Some(true));
    let (bot, workspace) = if must_validate {
        validate(current["provider"].as_str().unwrap_or_default(), &secrets).await?
    } else {
        (
            current["bot"].clone(),
            current["workspace"].as_str().unwrap_or_default().to_owned(),
        )
    };
    let name = input["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(current["name"].as_str().unwrap_or("Integration"))
        .trim()
        .chars()
        .take(120)
        .collect::<String>();
    if credentials_changed {
        state
            .agent_integrations
            .write_secrets(&integration_id, &secrets)
            .await?;
    }
    state
        .agent_integrations
        .stop_connector(&integration_id)
        .await;
    let value = update_connection(&state, &integration_id, |value| {
        value["name"] = json!(name);
        value["enabled"] = json!(enabled);
        value["bot"] = bot;
        value["workspace"] = json!(workspace);
        value["status"] = json!(if enabled { "starting" } else { "disabled" });
        value["lastError"] = Value::Null;
    })
    .await?;
    sync_connectors(&state).await?;
    Ok(Json(public_connection(
        &value,
        connection_chats(&state.db, &integration_id).await?,
    )))
}

pub(crate) async fn test(
    State(state): State<AppState>,
    AxumPath((agent_id, integration_id)): AxumPath<(String, String)>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<Value>> {
    ensure_admin(&user)?;
    let value = document(&state.db, CONNECTIONS, &integration_id).await?;
    if value["agentId"] != agent_id {
        return Err(AppError::NotFound("Agent integration not found".into()));
    }
    let (bot, workspace) = validate(
        value["provider"].as_str().unwrap_or_default(),
        &state.agent_integrations.secrets(&integration_id).await?,
    )
    .await?;
    Ok(Json(json!({"ok":true,"bot":bot,"workspace":workspace})))
}

pub(crate) async fn delete(
    State(state): State<AppState>,
    AxumPath((agent_id, integration_id)): AxumPath<(String, String)>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<StatusCode> {
    ensure_admin(&user)?;
    let value = document(&state.db, CONNECTIONS, &integration_id).await?;
    if value["agentId"] != agent_id {
        return Err(AppError::NotFound("Agent integration not found".into()));
    }
    state
        .agent_integrations
        .stop_connector(&integration_id)
        .await;
    for session in documents(&state.db, SESSIONS)
        .await?
        .into_iter()
        .filter(|value| value["integrationId"] == integration_id)
    {
        if let Some(stop) = state
            .agent_integrations
            .sessions
            .lock()
            .await
            .remove(session["id"].as_str().unwrap_or_default())
        {
            let _ = stop.send(true);
        }
        sqlx::query("DELETE FROM feature_documents WHERE namespace=? AND id=?")
            .bind(SESSIONS)
            .bind(session["id"].as_str())
            .execute(&state.db.pool)
            .await?;
    }
    for namespace in [CHATS, EVENTS] {
        for record in documents(&state.db, namespace)
            .await?
            .into_iter()
            .filter(|value| value["integrationId"] == integration_id)
        {
            sqlx::query("DELETE FROM feature_documents WHERE namespace=? AND id=?")
                .bind(namespace)
                .bind(record["id"].as_str())
                .execute(&state.db.pool)
                .await?;
        }
    }
    sqlx::query("DELETE FROM feature_documents WHERE namespace=? AND id=?")
        .bind(CONNECTIONS)
        .bind(&integration_id)
        .execute(&state.db.pool)
        .await?;
    let _ = tokio::fs::remove_file(state.agent_integrations.secret_path(&integration_id)).await;
    state.emit(
        "agent-integration.deleted",
        json!({"agentId":agent_id,"integrationId":integration_id}),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn chats(
    State(state): State<AppState>,
    AxumPath((agent_id, integration_id)): AxumPath<(String, String)>,
) -> AppResult<Json<Vec<Value>>> {
    let value = document(&state.db, CONNECTIONS, &integration_id).await?;
    if value["agentId"] != agent_id {
        return Err(AppError::NotFound("Agent integration not found".into()));
    }
    Ok(Json(
        connection_chats(&state.db, &integration_id)
            .await?
            .into_iter()
            .map(|chat| public_chat(&chat))
            .collect(),
    ))
}

async fn set_chat_approval(
    state: &AppState,
    agent_id: &str,
    integration_id: &str,
    chat_id: &str,
    approved: bool,
    user: &AuthUser,
) -> AppResult<Value> {
    ensure_admin(user)?;
    let integration = document(&state.db, CONNECTIONS, integration_id).await?;
    if integration["agentId"] != agent_id {
        return Err(AppError::NotFound("Agent integration not found".into()));
    }
    let mut chat = document(&state.db, CHATS, chat_id).await?;
    if chat["integrationId"] != integration_id {
        return Err(AppError::NotFound("External chat not found".into()));
    }
    chat["status"] = json!(if approved { "approved" } else { "revoked" });
    chat["approvedBy"] = if approved {
        json!(user.id)
    } else {
        Value::Null
    };
    chat["approvedAt"] = if approved { json!(now()) } else { Value::Null };
    save_document(&state.db, CHATS, &chat).await?;
    state.emit("agent-integration.chat", json!({"agentId":agent_id,"integrationId":integration_id,"chatId":chat_id,"status":chat["status"]}));
    if approved && integration["enabled"] == true {
        let state = state.clone();
        let integration = integration.clone();
        let chat = chat.clone();
        tokio::spawn(async move {
            let _ = send_platform_text(
                &state,
                &integration,
                &chat,
                None,
                "Connected to Boosted. Send your request again to start a conversation.",
            )
            .await;
        });
    }
    Ok(chat)
}

pub(crate) async fn approve(
    State(state): State<AppState>,
    AxumPath((agent_id, integration_id, chat_id)): AxumPath<(String, String, String)>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<Value>> {
    Ok(Json(public_chat(
        &set_chat_approval(&state, &agent_id, &integration_id, &chat_id, true, &user).await?,
    )))
}

pub(crate) async fn revoke(
    State(state): State<AppState>,
    AxumPath((agent_id, integration_id, chat_id)): AxumPath<(String, String, String)>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<Value>> {
    Ok(Json(public_chat(
        &set_chat_approval(&state, &agent_id, &integration_id, &chat_id, false, &user).await?,
    )))
}

async fn ensure_chat(
    state: &AppState,
    integration: &Value,
    external_id: &str,
    name: &str,
    kind: &str,
) -> AppResult<Value> {
    if let Some(mut chat) = documents(&state.db, CHATS).await?.into_iter().find(|chat| {
        chat["integrationId"] == integration["id"] && chat["externalId"] == external_id
    }) {
        chat["name"] = json!(name);
        chat["kind"] = json!(kind);
        chat["lastSeenAt"] = json!(now());
        save_document(&state.db, CHATS, &chat).await?;
        return Ok(chat);
    }
    let chat = json!({"id":Uuid::new_v4().to_string(),"integrationId":integration["id"],"externalId":external_id,"name":name,"kind":kind,"status":"pending","approvedBy":null,"approvedAt":null,"lastSeenAt":now(),"createdAt":now()});
    save_document(&state.db, CHATS, &chat).await?;
    state.emit("agent-integration.chat", json!({"agentId":integration["agentId"],"integrationId":integration["id"],"chatId":chat["id"],"status":"pending"}));
    Ok(chat)
}

async fn ensure_session(
    state: &AppState,
    integration: &Value,
    chat: &Value,
    thread_key: &str,
) -> AppResult<Value> {
    let id = session_id(integration["id"].as_str().unwrap_or_default(), thread_key);
    if let Ok(value) = document(&state.db, SESSIONS, &id).await {
        return Ok(value);
    }
    let value = json!({"id":id,"integrationId":integration["id"],"agentId":integration["agentId"],"provider":integration["provider"],"chatId":chat["id"],"externalChatId":chat["externalId"],"threadKey":thread_key,"chatName":chat["name"],"messages":[],"followUps":[],"status":"idle","activity":null,"accountId":null,"error":null,"createdAt":now(),"updatedAt":now()});
    save_document(&state.db, SESSIONS, &value).await?;
    Ok(value)
}

fn session_id(integration_id: &str, thread_key: &str) -> String {
    let stable = format!("{integration_id}:{thread_key}");
    format!("{:x}", sha2::Sha256::digest(stable.as_bytes()))
}

async fn seen_event(state: &AppState, integration_id: &str, event_id: &str) -> AppResult<bool> {
    let id = format!("{integration_id}:{event_id}");
    if document(&state.db, EVENTS, &id).await.is_ok() {
        return Ok(true);
    }
    save_document(
        &state.db,
        EVENTS,
        &json!({"id":id,"integrationId":integration_id,"createdAt":now()}),
    )
    .await?;
    Ok(false)
}

async fn append_inbound(
    state: &AppState,
    integration: &Value,
    chat: &Value,
    thread_key: &str,
    event_id: &str,
    content: String,
    sender_id: String,
    sender_name: String,
    attachments: Vec<Value>,
) -> AppResult<()> {
    if chat["status"] != "approved" {
        return Ok(());
    }
    let session = ensure_session(state, integration, chat, thread_key).await?;
    update_session(state, session["id"].as_str().unwrap(), |session| {
        if session["messages"].as_array().unwrap().iter().any(|message| message["externalEventId"] == event_id) { return Ok(()); }
        session["messages"].as_array_mut().unwrap().push(json!({"id":Uuid::new_v4().to_string(),"externalEventId":event_id,"role":"user","content":content,"createdAt":now(),"delivery":"queued","senderId":sender_id,"senderName":sender_name,"attachments":attachments}));
        session["error"] = Value::Null;
        Ok(())
    }).await?;
    let _ = update_connection(state, integration["id"].as_str().unwrap(), |value| {
        value["lastActivityAt"] = json!(now())
    })
    .await;
    Ok(())
}

async fn slack_user_name(client: &Client, token: &str, user: &str) -> String {
    let response = client
        .get("https://slack.com/api/users.info")
        .bearer_auth(token)
        .query(&[("user", user)])
        .send()
        .await
        .ok();
    let value: Option<Value> = match response {
        Some(response) => response.json().await.ok(),
        None => None,
    };
    value
        .as_ref()
        .and_then(|v| {
            v.pointer("/user/profile/display_name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| v.pointer("/user/real_name").and_then(Value::as_str))
        })
        .unwrap_or(user)
        .to_owned()
}

async fn download_slack_files(
    client: &Client,
    token: &str,
    files: Option<&Vec<Value>>,
) -> AppResult<Vec<Value>> {
    let mut result = Vec::new();
    let mut declared_total = 0usize;
    let mut actual_total = 0usize;
    for file in files.into_iter().flatten().take(10) {
        let size = file["size"].as_u64().unwrap_or(MAX_FILE_BYTES as u64 + 1) as usize;
        declared_total = declared_total.saturating_add(size);
        if size > MAX_FILE_BYTES || declared_total > MAX_TOTAL_BYTES {
            return Err(AppError::BadRequest(
                "Attachment size limit exceeded".into(),
            ));
        }
        let url = file["url_private_download"]
            .as_str()
            .or(file["url_private"].as_str())
            .ok_or_else(|| AppError::BadRequest("Slack file is unavailable".into()))?;
        let response = client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| AppError::BadRequest(clean_error(e)))?
            .error_for_status()
            .map_err(|e| AppError::BadRequest(clean_error(e)))?;
        let bytes = limited_bytes(response, MAX_FILE_BYTES).await?;
        actual_total = actual_total.saturating_add(bytes.len());
        if actual_total > MAX_TOTAL_BYTES {
            return Err(AppError::BadRequest(
                "Attachment size limit exceeded".into(),
            ));
        }
        let mime = file["mimetype"]
            .as_str()
            .unwrap_or("application/octet-stream");
        result.push(json!({"id":file["id"],"kind":if mime.starts_with("image/"){"image"}else{"file"},"name":file["name"].as_str().unwrap_or("attachment"),"mimeType":mime,"size":bytes.len(),"dataUrl":format!("data:{mime};base64,{}",STANDARD.encode(bytes))}));
    }
    Ok(result)
}

async fn limited_bytes(mut response: reqwest::Response, limit: usize) -> AppResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(AppError::BadRequest(
            "Attachment size limit exceeded".into(),
        ));
    }
    let capacity = response.content_length().unwrap_or(0).min(limit as u64) as usize;
    let mut bytes = Vec::with_capacity(capacity);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| AppError::BadRequest(clean_error(error)))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(AppError::BadRequest(
                "Attachment size limit exceeded".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn handle_slack_event(
    state: &AppState,
    integration: &Value,
    secrets: &Value,
    payload: &Value,
) -> AppResult<()> {
    let event = &payload["event"];
    if event["bot_id"].is_string()
        || event["subtype"].is_string()
        || event["user"].as_str() == integration.pointer("/bot/id").and_then(Value::as_str)
    {
        return Ok(());
    }
    let kind = event["type"].as_str().unwrap_or_default();
    if !matches!(kind, "app_mention" | "message") {
        return Ok(());
    }
    let channel = match event["channel"].as_str() {
        Some(value) => value,
        None => return Ok(()),
    };
    let is_dm = event["channel_type"] == "im";
    let root = event["thread_ts"]
        .as_str()
        .or(event["ts"].as_str())
        .unwrap_or_default();
    let thread_key = if is_dm {
        format!(
            "slack:{}:{channel}:dm",
            integration["workspace"].as_str().unwrap_or_default()
        )
    } else {
        format!(
            "slack:{}:{channel}:{root}",
            integration["workspace"].as_str().unwrap_or_default()
        )
    };
    let established = document(
        &state.db,
        SESSIONS,
        &session_id(integration["id"].as_str().unwrap_or_default(), &thread_key),
    )
    .await
    .is_ok();
    let reply_to_bot = event["parent_user_id"] == integration["bot"]["id"];
    if !is_dm && kind != "app_mention" && !reply_to_bot && !established {
        return Ok(());
    }
    let chat = ensure_chat(
        state,
        integration,
        channel,
        channel,
        if is_dm { "dm" } else { "channel" },
    )
    .await?;
    if chat["status"] != "approved" {
        return Ok(());
    }
    let token = secrets["botToken"].as_str().unwrap_or_default();
    let user = event["user"].as_str().unwrap_or("unknown");
    let sender = slack_user_name(&Client::new(), token, user).await;
    let attachments = match download_slack_files(&Client::new(), token, event["files"].as_array())
        .await
    {
        Ok(attachments) => attachments,
        Err(error) => {
            let _ = send_platform_text(
                state,
                integration,
                &chat,
                Some(&thread_key),
                "I couldn't accept those attachments. Each file must be 5 MiB or smaller, with at most 10 MiB total.",
            )
            .await;
            tracing::warn!(integration_id=%integration["id"], error=%clean_error(error), "Slack attachments rejected");
            return Ok(());
        }
    };
    let content = event["text"].as_str().unwrap_or_default().trim().to_owned();
    if content.is_empty() && attachments.is_empty() {
        return Ok(());
    }
    append_inbound(
        state,
        integration,
        &chat,
        &thread_key,
        payload["event_id"].as_str().unwrap_or(root),
        if content.is_empty() {
            "Please look at the attached files.".into()
        } else {
            content
        },
        user.into(),
        sender,
        attachments,
    )
    .await
}

async fn slack_loop(
    state: AppState,
    integration_id: String,
    mut stop: watch::Receiver<bool>,
) -> AppResult<()> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(AppError::internal)?;
    if *stop.borrow() {
        return Ok(());
    }
    let integration = document(&state.db, CONNECTIONS, &integration_id).await?;
    if integration["enabled"] != true {
        return Ok(());
    }
    let secrets = state.agent_integrations.secrets(&integration_id).await?;
    let opened: Value = client
        .post("https://slack.com/api/apps.connections.open")
        .bearer_auth(secrets["appToken"].as_str().unwrap_or_default())
        .send()
        .await
        .map_err(|e| AppError::Internal(clean_error(e)))?
        .json()
        .await
        .map_err(|_| AppError::Internal("Slack returned invalid JSON".into()))?;
    let url = opened["url"]
        .as_str()
        .filter(|_| opened["ok"] == true)
        .ok_or_else(|| {
            AppError::Conflict(
                opened["error"]
                    .as_str()
                    .unwrap_or("Unable to open Slack Socket Mode")
                    .into(),
            )
        })?;
    let (socket, _) = connect_async(url)
        .await
        .map_err(|e| AppError::Internal(clean_error(e)))?;
    let (mut write, mut read) = socket.split();
    update_connection(&state, &integration_id, |value| {
        value["status"] = json!("connected");
        value["lastConnectedAt"] = json!(now());
        value["lastError"] = Value::Null;
    })
    .await?;
    loop {
        let next =
            tokio::select! { _ = stop.changed() => return Ok(()), value = read.next() => value };
        let Some(message) = next else {
            break;
        };
        let message = message.map_err(|e| AppError::Internal(clean_error(e)))?;
        let Message::Text(content) = message else {
            continue;
        };
        let envelope: Value = serde_json::from_str(content.as_ref())
            .map_err(|_| AppError::Internal("Slack sent invalid JSON".into()))?;
        let Some(envelope_id) = envelope["envelope_id"].as_str() else {
            continue;
        };
        let event_id = envelope
            .pointer("/payload/event_id")
            .and_then(Value::as_str)
            .unwrap_or(envelope_id);
        let duplicate = seen_event(&state, &integration_id, event_id).await?;
        write
            .send(Message::Text(
                json!({"envelope_id":envelope_id}).to_string().into(),
            ))
            .await
            .map_err(|e| AppError::Internal(clean_error(e)))?;
        if !duplicate && envelope["type"] == "events_api" {
            if let Err(error) =
                handle_slack_event(&state, &integration, &secrets, &envelope["payload"]).await
            {
                tracing::warn!(integration_id=%integration_id,error=%clean_error(error),"Slack event failed");
            }
        }
    }
    update_connection(&state, &integration_id, |value| {
        value["status"] = json!("reconnecting")
    })
    .await?;
    Err(AppError::Internal(
        "Slack Socket Mode connection closed".into(),
    ))
}

async fn telegram_attachment(
    client: &Client,
    token: &str,
    message: &Value,
) -> AppResult<Vec<Value>> {
    let (file_id, name, mime, kind) = if let Some(document) = message.get("document") {
        (
            document["file_id"].as_str(),
            document["file_name"].as_str().unwrap_or("attachment"),
            document["mime_type"]
                .as_str()
                .unwrap_or("application/octet-stream"),
            if document["mime_type"]
                .as_str()
                .is_some_and(|m| m.starts_with("image/"))
            {
                "image"
            } else {
                "file"
            },
        )
    } else if let Some(photo) = message["photo"].as_array().and_then(|items| items.last()) {
        (
            photo["file_id"].as_str(),
            "photo.jpg",
            "image/jpeg",
            "image",
        )
    } else if [
        "audio",
        "video",
        "animation",
        "voice",
        "video_note",
        "sticker",
    ]
    .iter()
    .any(|kind| message.get(*kind).is_some())
    {
        return Err(AppError::BadRequest(
            "Unsupported Telegram attachment".into(),
        ));
    } else {
        return Ok(vec![]);
    };
    let Some(file_id) = file_id else {
        return Ok(vec![]);
    };
    let meta = telegram_call(client, token, "getFile", Some(&json!({"file_id":file_id}))).await?;
    if meta["file_size"]
        .as_u64()
        .is_some_and(|size| size > MAX_FILE_BYTES as u64)
    {
        return Err(AppError::BadRequest(
            "Attachment size limit exceeded".into(),
        ));
    }
    let path = meta["file_path"]
        .as_str()
        .ok_or_else(|| AppError::BadRequest("Telegram file is unavailable".into()))?;
    let response = client
        .get(format!("https://api.telegram.org/file/bot{token}/{path}"))
        .send()
        .await
        .map_err(|e| AppError::BadRequest(clean_error(e)))?
        .error_for_status()
        .map_err(|e| AppError::BadRequest(clean_error(e)))?;
    let bytes = limited_bytes(response, MAX_FILE_BYTES).await?;
    Ok(vec![
        json!({"id":file_id,"kind":kind,"name":name,"mimeType":mime,"size":bytes.len(),"dataUrl":format!("data:{mime};base64,{}",STANDARD.encode(bytes))}),
    ])
}

async fn handle_telegram_update(
    state: &AppState,
    integration: &Value,
    secrets: &Value,
    update: &Value,
) -> AppResult<()> {
    let message = update.get("message").or_else(|| update.get("channel_post"));
    let Some(message) = message else {
        return Ok(());
    };
    if message.pointer("/from/is_bot").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let chat_id = message
        .pointer("/chat/id")
        .map(Value::to_string)
        .unwrap_or_default();
    if chat_id.is_empty() {
        return Ok(());
    }
    let kind = message
        .pointer("/chat/type")
        .and_then(Value::as_str)
        .unwrap_or("group");
    if kind == "channel" {
        return Ok(());
    }
    let title = message
        .pointer("/chat/title")
        .and_then(Value::as_str)
        .or_else(|| message.pointer("/chat/username").and_then(Value::as_str))
        .or_else(|| message.pointer("/from/first_name").and_then(Value::as_str))
        .unwrap_or(&chat_id);
    let chat = ensure_chat(state, integration, &chat_id, title, kind).await?;
    if chat["status"] != "approved" {
        return Ok(());
    }
    let is_dm = kind == "private";
    let username = integration
        .pointer("/bot/username")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text_value = message["text"]
        .as_str()
        .or(message["caption"].as_str())
        .unwrap_or_default();
    let entities = if message["text"].is_string() {
        message["entities"].as_array()
    } else {
        message["caption_entities"].as_array()
    };
    let mentioned = telegram_mentions_bot(
        text_value,
        entities,
        username,
        integration.pointer("/bot/id"),
    );
    let replied = message.pointer("/reply_to_message/from/id") == integration.pointer("/bot/id");
    if !is_dm && !mentioned && !replied {
        return Ok(());
    }
    let topic = message["message_thread_id"]
        .as_i64()
        .map(|id| id.to_string())
        .unwrap_or_else(|| "main".into());
    let thread_key = format!("telegram:{chat_id}:{topic}");
    let client = Client::new();
    let token = secrets["botToken"].as_str().unwrap_or_default();
    let attachments = match telegram_attachment(&client, token, message).await {
        Ok(attachments) => attachments,
        Err(error) => {
            let _ = send_platform_text(
                state,
                integration,
                &chat,
                Some(&thread_key),
                "I couldn't accept that attachment. Send an image or ordinary file up to 5 MiB.",
            )
            .await;
            tracing::warn!(integration_id=%integration["id"], error=%clean_error(error), "Telegram attachment rejected");
            return Ok(());
        }
    };
    let content = text_value.trim().to_owned();
    if content.is_empty() && attachments.is_empty() {
        return Ok(());
    }
    let sender_id = message
        .pointer("/from/id")
        .map(Value::to_string)
        .unwrap_or_else(|| "unknown".into());
    let sender_name = [
        message.pointer("/from/first_name").and_then(Value::as_str),
        message.pointer("/from/last_name").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    append_inbound(
        state,
        integration,
        &chat,
        &thread_key,
        &update["update_id"].to_string(),
        if content.is_empty() {
            "Please look at the attached files.".into()
        } else {
            content
        },
        sender_id,
        if sender_name.is_empty() {
            "Telegram user".into()
        } else {
            sender_name
        },
        attachments,
    )
    .await
}

fn telegram_mentions_bot(
    text: &str,
    entities: Option<&Vec<Value>>,
    username: &str,
    bot_id: Option<&Value>,
) -> bool {
    let utf16: Vec<u16> = text.encode_utf16().collect();
    entities.into_iter().flatten().any(|entity| {
        if entity["type"] == "text_mention" {
            return entity.pointer("/user/id") == bot_id;
        }
        if entity["type"] != "mention" || username.is_empty() {
            return false;
        }
        let Some(offset) = entity["offset"].as_u64().map(|value| value as usize) else {
            return false;
        };
        let Some(length) = entity["length"].as_u64().map(|value| value as usize) else {
            return false;
        };
        utf16
            .get(offset..offset.saturating_add(length))
            .and_then(|slice| String::from_utf16(slice).ok())
            .is_some_and(|mention| mention.eq_ignore_ascii_case(&format!("@{username}")))
    })
}

async fn telegram_loop(
    state: AppState,
    integration_id: String,
    mut stop: watch::Receiver<bool>,
) -> AppResult<()> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(AppError::internal)?;
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let integration = document(&state.db, CONNECTIONS, &integration_id).await?;
        if integration["enabled"] != true {
            return Ok(());
        }
        let secrets = state.agent_integrations.secrets(&integration_id).await?;
        let token = secrets["botToken"].as_str().unwrap_or_default();
        let mut body = json!({"timeout":30,"allowed_updates":["message"]});
        if let Some(offset) = integration["cursor"].as_i64() {
            body["offset"] = json!(offset);
        }
        update_connection(&state, &integration_id, |value| {
            value["status"] = json!("connected");
            if value["lastConnectedAt"].is_null() {
                value["lastConnectedAt"] = json!(now());
            }
            value["lastError"] = Value::Null;
        })
        .await?;
        let updates = tokio::select! { _=stop.changed()=>return Ok(()), result=telegram_call(&client,token,"getUpdates",Some(&body))=>result? };
        for update in updates.as_array().into_iter().flatten() {
            let update_id = update["update_id"].as_i64().unwrap_or_default();
            let duplicate = seen_event(&state, &integration_id, &update_id.to_string()).await?;
            update_connection(&state, &integration_id, |value| {
                value["cursor"] = json!(update_id + 1)
            })
            .await?;
            if !duplicate {
                if let Err(error) =
                    handle_telegram_update(&state, &integration, &secrets, update).await
                {
                    tracing::warn!(integration_id=%integration_id,error=%clean_error(error),"Telegram update failed");
                }
            }
        }
    }
}

async fn connector_task(
    state: AppState,
    id: String,
    provider: String,
    lease: Uuid,
    mut stop: watch::Receiver<bool>,
) {
    let mut delay = 2u64;
    loop {
        if *stop.borrow() {
            break;
        }
        let result = match provider.as_str() {
            "slack" => slack_loop(state.clone(), id.clone(), stop.clone()).await,
            "telegram" => telegram_loop(state.clone(), id.clone(), stop.clone()).await,
            _ => Err(AppError::BadRequest(
                "Unsupported integration provider".into(),
            )),
        };
        if *stop.borrow()
            || document(&state.db, CONNECTIONS, &id)
                .await
                .ok()
                .is_none_or(|value| value["enabled"] != true)
        {
            break;
        }
        if let Err(error) = result {
            let message = clean_error(error);
            let _ = update_connection(&state, &id, |value| {
                value["status"] = json!("reconnecting");
                value["lastError"] = json!(message);
            })
            .await;
        }
        tokio::select! { _=stop.changed()=>break, _=tokio::time::sleep(Duration::from_secs(delay))=>{} }
        delay = (delay * 2).min(60);
    }
    let mut connectors = state.agent_integrations.connectors.lock().await;
    if connectors
        .get(&id)
        .is_some_and(|(current, _)| *current == lease)
    {
        connectors.remove(&id);
    }
}

pub(crate) async fn sync_connectors(state: &AppState) -> AppResult<()> {
    for integration in documents(&state.db, CONNECTIONS).await? {
        let id = integration["id"].as_str().unwrap_or_default().to_owned();
        if integration["enabled"] != true
            || state
                .agent_integrations
                .connectors
                .lock()
                .await
                .contains_key(&id)
        {
            continue;
        }
        let (sender, receiver) = watch::channel(false);
        let lease = Uuid::new_v4();
        state
            .agent_integrations
            .connectors
            .lock()
            .await
            .insert(id.clone(), (lease, sender));
        tokio::spawn(connector_task(
            state.clone(),
            id,
            integration["provider"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            lease,
            receiver,
        ));
    }
    Ok(())
}

fn split_text(content: &str, limit: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut rest = content.trim();
    while rest.chars().count() > limit {
        let boundary = rest
            .char_indices()
            .take_while(|(index, _)| *index <= limit)
            .filter(|(_, ch)| ch.is_whitespace())
            .map(|(index, _)| index)
            .last()
            .unwrap_or_else(|| {
                rest.char_indices()
                    .nth(limit)
                    .map(|(i, _)| i)
                    .unwrap_or(rest.len())
            });
        chunks.push(rest[..boundary].trim().to_owned());
        rest = rest[boundary..].trim();
    }
    if !rest.is_empty() {
        chunks.push(rest.to_owned());
    }
    chunks
}

async fn send_platform_text(
    state: &AppState,
    integration: &Value,
    chat: &Value,
    thread_key: Option<&str>,
    content: &str,
) -> AppResult<Vec<Value>> {
    let secrets = state
        .agent_integrations
        .secrets(integration["id"].as_str().unwrap_or_default())
        .await?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(AppError::internal)?;
    let mut sent = Vec::new();
    match integration["provider"].as_str().unwrap_or_default() {
        "slack" => {
            let thread = thread_key
                .and_then(|key| key.rsplit(':').next())
                .filter(|value| *value != "dm");
            for chunk in split_text(content, 3500) {
                let mut body = json!({"channel":chat["externalId"],"text":chunk});
                if let Some(thread) = thread {
                    body["thread_ts"] = json!(thread);
                }
                let response = slack_post_message(
                    &client,
                    secrets["botToken"].as_str().unwrap_or_default(),
                    &body,
                )
                .await?;
                sent.push(response["ts"].clone());
            }
        }
        "telegram" => {
            let topic = thread_key
                .and_then(|key| key.rsplit(':').next())
                .and_then(|value| {
                    if value == "main" {
                        None
                    } else {
                        value.parse::<i64>().ok()
                    }
                });
            for chunk in split_text(content, 4000) {
                let mut body = json!({"chat_id":chat["externalId"],"text":chunk});
                if let Some(topic) = topic {
                    body["message_thread_id"] = json!(topic);
                }
                let response = telegram_call(
                    &client,
                    secrets["botToken"].as_str().unwrap_or_default(),
                    "sendMessage",
                    Some(&body),
                )
                .await?;
                sent.push(response["message_id"].clone());
            }
        }
        _ => {
            return Err(AppError::BadRequest(
                "Unsupported integration provider".into(),
            ));
        }
    }
    Ok(sent)
}

pub(crate) async fn activity(
    state: &AppState,
    context: &ExternalContext,
    activity: Option<&str>,
) -> AppResult<()> {
    update_session(state, &context.session_id, |session| {
        session["activity"] = json!(activity);
        Ok(())
    })
    .await?;
    Ok(())
}

pub(crate) async fn receipt(
    state: &AppState,
    context: &ExternalContext,
    action: Value,
    completed: bool,
) -> AppResult<()> {
    let action_id = action["id"].clone();
    update_session(state,&context.session_id,|session|{let messages=session["messages"].as_array_mut().unwrap();let existing=messages.iter_mut().filter_map(|m|m["actions"].as_array_mut()).flat_map(|a|a.iter_mut()).find(|a|a["id"]==action_id);if let Some(existing)=existing{if completed||existing["status"]=="running"{*existing=action;}}else{messages.push(json!({"id":Uuid::new_v4().to_string(),"role":"assistant","content":"","createdAt":now(),"actions":[action]}));}Ok(())}).await?;
    Ok(())
}

pub(crate) async fn begin_tool(
    state: &AppState,
    context: &ExternalContext,
    receipt_id: &str,
    call_id: &str,
    name: &str,
    args: &Value,
) -> AppResult<()> {
    update_session(state,&context.session_id,|session|{session["activity"]=json!("working");session["messages"].as_array_mut().unwrap().push(json!({"id":receipt_id,"role":"assistant","content":"","createdAt":now(),"actions":[{"id":call_id,"tool":name,"arguments":args,"status":"running"}]}));Ok(())}).await?;
    Ok(())
}

pub(crate) async fn finish_tool(
    state: &AppState,
    context: &ExternalContext,
    receipt_id: &str,
    result: &AppResult<Value>,
) -> AppResult<()> {
    update_session(state, &context.session_id, |session| {
        let receipt = session["messages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|m| m["id"] == receipt_id)
            .ok_or_else(|| AppError::Internal("Missing external action receipt".into()))?;
        let action = &mut receipt["actions"][0];
        action["status"] = json!(if result.is_ok() {
            "completed"
        } else {
            "failed"
        });
        action["result"] = json!(match result {
            Ok(value) => computer::receipt_result(value).to_string(),
            Err(error) => json!({"error":error.to_string()}).to_string(),
        });
        if let Ok(value) = result {
            for key in ["chatId", "workingDirectory"] {
                if let Some(v) = value.get(key) {
                    action[key] = v.clone();
                }
            }
        }
        session["activity"] = json!("thinking");
        Ok(())
    })
    .await?;
    Ok(())
}

pub(crate) async fn reply(
    state: &AppState,
    context: &ExternalContext,
    content: &str,
    current: &[Value],
) -> AppResult<Value> {
    let integration = document(&state.db, CONNECTIONS, &context.integration_id).await?;
    if integration["enabled"] != true {
        return Err(AppError::Conflict(
            "The external integration is disabled".into(),
        ));
    }
    let chat = document(
        &state.db,
        CHATS,
        document(&state.db, SESSIONS, &context.session_id).await?["chatId"]
            .as_str()
            .unwrap_or_default(),
    )
    .await?;
    if chat["status"] != "approved" {
        return Err(AppError::Conflict(
            "The external chat is no longer approved".into(),
        ));
    }
    let message_id = Uuid::new_v4().to_string();
    update_session(state, &context.session_id, |session| {
        let follow_up_ids: Vec<_> = session["followUps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|followup| followup["status"] == "processing")
            .map(|followup| followup["id"].clone())
            .collect();
        session["messages"].as_array_mut().unwrap().push(json!({
            "id":message_id.clone(),
            "role":"assistant",
            "content":content,
            "createdAt":now(),
            "inReplyTo":current.iter().map(|message|message["id"].clone()).collect::<Vec<_>>(),
            "followUpIds":follow_up_ids,
            "externalMessageIds":[],
            "delivery":"sending",
            "deliveryError":null
        }));
        Ok(())
    })
    .await?;
    let delivery = send_platform_text(
        state,
        &integration,
        &chat,
        Some(
            document(&state.db, SESSIONS, &context.session_id).await?["threadKey"]
                .as_str()
                .unwrap_or_default(),
        ),
        content,
    )
    .await;
    update_session(state, &context.session_id, |session| {
        let message = session["messages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|message| message["id"] == message_id)
            .ok_or_else(|| AppError::Internal("Missing external outbound delivery".into()))?;
        match &delivery {
            Ok(sent) => {
                message["externalMessageIds"] = json!(sent);
                message["delivery"] = json!("delivered");
                message["deliveryError"] = Value::Null;
                session["activity"] = Value::Null;
            }
            Err(error) => {
                message["delivery"] = json!("failed");
                message["deliveryError"] = json!(clean_error(error));
            }
        }
        Ok(())
    })
    .await?;
    delivery?;
    Ok(json!({"messageId":message_id}))
}

pub(crate) async fn add_followup(
    state: &AppState,
    context: &ExternalContext,
    mut followup: Value,
) -> AppResult<Value> {
    followup["id"] = json!(Uuid::new_v4().to_string());
    followup["createdAt"] = json!(now());
    followup["status"] = json!("waiting");
    let mut result = followup.clone();
    update_session(state, &context.session_id, |session| {
        if let Some(existing) = session["followUps"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|f| task_planning::same_watch(f, &followup))
        {
            task_planning::merge_watch(existing, &followup);
            result = existing.clone();
            return Ok(());
        }
        if followup["kind"] == "run" {
            if let Some(existing) = session["followUps"].as_array().unwrap().iter().find(|f| {
                f["kind"] == "run"
                    && f["runId"] == followup["runId"]
                    && f["chatId"] == followup["chatId"]
                    && f["status"] != "cancelled"
            }) {
                result = existing.clone();
                return Ok(());
            }
        }
        session["followUps"].as_array_mut().unwrap().push(followup);
        Ok(())
    })
    .await?;
    Ok(result)
}

pub(crate) async fn followups(state: &AppState, context: &ExternalContext) -> AppResult<Value> {
    Ok(document(&state.db, SESSIONS, &context.session_id).await?["followUps"].clone())
}
pub(crate) async fn cancel_followup(
    state: &AppState,
    context: &ExternalContext,
    id: &str,
) -> AppResult<Value> {
    let value = update_session(state, &context.session_id, |session| {
        let followup = session["followUps"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|f| f["id"] == id)
            .ok_or_else(|| AppError::NotFound("Follow-up not found".into()))?;
        followup["status"] = json!("cancelled");
        Ok(())
    })
    .await?;
    Ok(value["followUps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == id)
        .unwrap()
        .clone())
}

pub(crate) async fn conversation(state: &AppState, context: &ExternalContext) -> AppResult<Value> {
    document(&state.db, SESSIONS, &context.session_id).await
}

async fn session_worker(
    state: AppState,
    context: ExternalContext,
    mut cancel: watch::Receiver<bool>,
) -> AppResult<()> {
    loop {
        if *cancel.borrow() {
            return Ok(());
        }
        let snapshot = update_session(&state, &context.session_id, |session| {
            for message in session["messages"].as_array_mut().unwrap() {
                if message["delivery"] == "queued" {
                    message["delivery"] = json!("processing");
                    message["readAt"] = json!(now());
                }
            }
            for f in session["followUps"].as_array_mut().unwrap() {
                if f["status"] == "ready" {
                    f["status"] = json!("processing");
                }
            }
            session["status"] = json!("running");
            session["activity"] = json!("thinking");
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
        let mut turn_snapshot = snapshot.clone();
        let agent_snapshot = state.agents.get(&context.agent_id).await?;
        turn_snapshot["profile"] = agent_snapshot["profile"].clone();
        turn_snapshot["timeZone"] = agent_snapshot["timeZone"].clone();
        turn_snapshot["id"] = json!(context.agent_id);
        let requested = snapshot["accountId"]
            .as_str()
            .or(agent_snapshot["accountId"].as_str());
        let mut excluded = HashSet::new();
        let mut account = agents::choose_account(&state, requested, &excluded).await?;
        let result = loop {
            update_session(&state, &context.session_id, |s| {
                s["accountId"] = json!(account);
                Ok(())
            })
            .await?;
            let latest = document(&state.db, SESSIONS, &context.session_id).await?;
            turn_snapshot["messages"] = latest["messages"].clone();
            turn_snapshot["followUps"] = latest["followUps"].clone();
            let attempt = CONTEXT
                .scope(
                    context.clone(),
                    agents::run_turn(
                        &state,
                        &context.agent_id,
                        &turn_snapshot,
                        &current,
                        &background,
                        &account,
                        &mut cancel,
                    ),
                )
                .await;
            if !*cancel.borrow()
                && attempt
                    .as_ref()
                    .err()
                    .is_some_and(|error| agents::quota_error(&error.to_string()))
            {
                providers::mark_exhausted(&state, &account).await?;
                excluded.insert(account.clone());
                if let Ok(next) = agents::choose_account(&state, None, &excluded).await {
                    account = next;
                    continue;
                }
            }
            break attempt;
        };
        let success = result.is_ok();
        let stopped = *cancel.borrow();
        update_session(&state, &context.session_id, |session| {
            for message in session["messages"].as_array_mut().unwrap() {
                if current.iter().any(|m| m["id"] == message["id"]) {
                    message["delivery"] = json!(if stopped { "cancelled" } else { "handled" });
                }
            }
            for f in session["followUps"].as_array_mut().unwrap() {
                if background.iter().any(|b| b["id"] == f["id"]) && f["status"] != "cancelled" {
                    if success {
                        f["lastDeliveredAt"] = json!(now());
                        if let Some(minutes) = f["intervalMinutes"].as_i64() {
                            f["status"] = json!("waiting");
                            f["dueAt"] = json!(
                                (Utc::now() + chrono::Duration::minutes(minutes)).to_rfc3339()
                            );
                        } else {
                            f["status"] = json!("completed");
                        }
                    } else {
                        f["status"] = json!("failed");
                        f["error"] = json!(result.as_ref().unwrap_err().to_string());
                    }
                }
            }
            session["error"] = if let Err(error) = &result {
                json!(error.to_string())
            } else {
                Value::Null
            };
            Ok(())
        })
        .await?;
        result?;
    }
}

async fn start_session(state: &AppState, session: Value) -> AppResult<()> {
    let id = session["id"].as_str().unwrap_or_default().to_owned();
    if state
        .agent_integrations
        .sessions
        .lock()
        .await
        .contains_key(&id)
    {
        return Ok(());
    }
    let agent = session["agentId"].as_str().unwrap_or_default().to_owned();
    let Some((sender, receiver)) = state.agents.reserve_group(&agent).await? else {
        return Ok(());
    };
    state
        .agent_integrations
        .sessions
        .lock()
        .await
        .insert(id.clone(), sender);
    let context = ExternalContext {
        integration_id: session["integrationId"].as_str().unwrap_or_default().into(),
        session_id: id.clone(),
        agent_id: agent.clone(),
        provider: session["provider"].as_str().unwrap_or_default().into(),
        chat_name: session["chatName"].as_str().unwrap_or_default().into(),
    };
    agents::external_started(state, &agent, &context).await?;
    let state = state.clone();
    tokio::spawn(async move {
        let result = session_worker(state.clone(), context.clone(), receiver).await;
        let _ = update_session(&state, &id, |session| {
            session["status"] = json!("idle");
            session["activity"] = Value::Null;
            if let Err(error) = &result {
                session["error"] = json!(error.to_string());
            }
            Ok(())
        })
        .await;
        state.agent_integrations.sessions.lock().await.remove(&id);
        state.agents.release_group(&agent).await;
        let _ = agents::external_finished(&state, &agent, &context).await;
        let context_state = state.clone();
        tokio::spawn(async move {
            if let Err(error) = agents::prepare_external_context(&context_state, &context).await {
                tracing::warn!(%error, session_id=%context.session_id, "Unable to prepare external agent context");
            }
        });
    });
    Ok(())
}

pub(crate) async fn tick(state: &AppState) -> AppResult<()> {
    sync_connectors(state).await?;
    let mut sessions = documents(&state.db, SESSIONS).await?;
    sessions.sort_by_key(|session| {
        session["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|message| message["delivery"] == "queued")
            .filter_map(|message| message["createdAt"].as_str())
            .chain(
                session["followUps"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|followup| {
                        matches!(followup["status"].as_str(), Some("ready" | "waiting"))
                    })
                    .filter_map(|followup| {
                        followup["dueAt"]
                            .as_str()
                            .or(followup["createdAt"].as_str())
                    }),
            )
            .min()
            .unwrap_or("9999")
            .to_owned()
    });
    for mut session in sessions {
        let integration = document(
            &state.db,
            CONNECTIONS,
            session["integrationId"].as_str().unwrap_or_default(),
        )
        .await?;
        let chat = document(
            &state.db,
            CHATS,
            session["chatId"].as_str().unwrap_or_default(),
        )
        .await?;
        if integration["enabled"] != true || chat["status"] != "approved" {
            continue;
        }
        let mut changed = false;
        let agent_id = session["agentId"].as_str().unwrap_or_default().to_owned();
        for f in session["followUps"].as_array_mut().unwrap() {
            if f["status"] != "waiting" {
                continue;
            }
            if f["kind"] == "task-plan" {
                let before = f.clone();
                if let Some(outcome) = task_planning::advance(state, &agent_id, f).await? {
                    f["status"] = json!("ready");
                    f["result"] = outcome;
                }
                changed |= *f != before;
            } else if f["kind"] == "schedule"
                && f["dueAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|due| due <= Utc::now())
            {
                f["status"] = json!("ready");
                changed = true;
            } else if f["kind"] == "run" {
                if let Some(run) = f["runId"].as_str() {
                    if let Ok(outcome) = document(&state.db, "run-outcomes", run).await {
                        f["status"] = json!("ready");
                        f["result"] = outcome;
                        changed = true;
                    }
                }
            }
        }
        if changed {
            let updates = session["followUps"].as_array().unwrap().clone();
            session = update_session(state, session["id"].as_str().unwrap(), |latest| {
                for f in latest["followUps"].as_array_mut().unwrap() {
                    if f["status"] == "waiting" {
                        if let Some(update) = updates.iter().find(|u| u["id"] == f["id"]) {
                            for field in ["status", "result", "startRequested", "pendingAnswers"] {
                                if let Some(value) = update.get(field) {
                                    f[field] = value.clone();
                                }
                            }
                        }
                    }
                }
                Ok(())
            })
            .await?;
        }
        let pending = session["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["delivery"] == "queued")
            || session["followUps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["status"] == "ready");
        if pending {
            start_session(state, session).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (tempfile::TempDir, AppState) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("state.sqlite3"))
            .await
            .unwrap();
        let (live, _) = tokio::sync::broadcast::channel(32);
        let state = AppState {
            agents: agents::AgentManager::load(&db).await.unwrap(),
            agent_integrations: AgentIntegrationManager::new(root.path().join("secrets"))
                .await
                .unwrap(),
            db,
            groups: groups::GroupManager::default(),
            providers: providers::ProviderManager::new(root.path().join("accounts")),
            codex: crate::codex::CodexManager::test_unavailable(),
            live,
            sequence: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            pending_inputs: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            active_codex_turns: Default::default(),
            started_codex_threads: Default::default(),
            uploads_dir: root.path().join("uploads"),
            worktrees_dir: root.path().join("worktrees"),
            updater: updater::ServerUpdater::disabled("Test"),
        };
        (root, state)
    }

    fn user(role: &str) -> AuthUser {
        AuthUser {
            id: role.into(),
            username: role.into(),
            role: role.into(),
        }
    }

    #[tokio::test]
    async fn task_plan_watches_remain_in_the_originating_external_session() {
        let (root, state) = fixture().await;
        sqlx::query("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('admin','admin','','admin','now')").execute(&state.db.pool).await.unwrap();
        sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES('project','Test',?,'main','admin','now')").bind(root.path().to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
        sqlx::query("INSERT INTO tasks(id,project_id,title,description,status,branch_name,worktree_path,created_by,created_at,updated_at) VALUES('task','project','Task','Review the plan','ready','boosted/task',?,'admin','now','now')").bind(root.path().to_string_lossy().to_string()).execute(&state.db.pool).await.unwrap();
        save_document(&state.db, SESSIONS, &json!({"id":"session","integrationId":"integration","agentId":"pock","provider":"telegram","chatName":"Planning","messages":[{"id":"request","role":"user","content":"Plan tasks; ask only critical questions."}],"followUps":[]})).await.unwrap();
        let context = context_for_session(&state.db, "session").await.unwrap();
        let args =
            json!({"taskId":"task","instructions":"Plan tasks; ask only critical questions."});
        let first = scope(
            context.clone(),
            agents::tool_action(
                &state,
                "pock",
                "watch_task_plan",
                &args,
                &[json!({"id":"request"})],
            ),
        )
        .await
        .unwrap();
        let again = scope(
            context.clone(),
            agents::tool_action(
                &state,
                "pock",
                "watch_task_plan",
                &args,
                &[json!({"id":"feedback"})],
            ),
        )
        .await
        .unwrap();
        assert_eq!(first["id"], again["id"]);
        assert!(
            state.agents.get("pock").await.unwrap()["followUps"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut watches = followups(&state, &context).await.unwrap();
        assert_eq!(watches.as_array().unwrap().len(), 1);
        assert_eq!(
            watches[0]["sourceMessageIds"],
            json!(["request", "feedback"])
        );
        assert_eq!(
            task_planning::advance(&state, "pock", &mut watches[0])
                .await
                .unwrap()
                .unwrap()["task"]["status"],
            "ready"
        );
    }

    #[test]
    fn text_chunks_respect_character_limit() {
        let value = format!("{} {}", "a".repeat(8), "b".repeat(8));
        let chunks = split_text(&value, 10);
        assert_eq!(chunks, vec!["aaaaaaaa", "bbbbbbbb"]);
    }
    #[test]
    fn public_connection_never_contains_secrets() {
        let value = json!({"id":"i","agentId":"a","provider":"slack","name":"Slack","enabled":true,"bot":{},"workspace":"w","status":"connected","lastConnectedAt":null,"lastActivityAt":null,"lastError":null,"createdAt":"x","updatedAt":"x","botToken":"secret","appToken":"secret"});
        let public = public_connection(&value, vec![]);
        assert!(public.get("botToken").is_none());
        assert!(public.get("appToken").is_none());
        assert_eq!(public["hasAppToken"], true);
        assert!(!clean_error("wss://wss-primary.slack.com/link/?ticket=secret").contains("secret"));
    }

    #[test]
    fn telegram_mentions_require_provider_entities() {
        let entities = vec![json!({"type":"mention","offset":3,"length":10})];
        assert!(telegram_mentions_bot(
            "👋 @boost_bot please help",
            Some(&entities),
            "boost_bot",
            Some(&json!(42)),
        ));
        assert!(!telegram_mentions_bot(
            "plain @boost_bot text",
            None,
            "boost_bot",
            Some(&json!(42)),
        ));
        let text_mention =
            vec![json!({"type":"text_mention","offset":0,"length":5,"user":{"id":42}})];
        assert!(telegram_mentions_bot(
            "Agent",
            Some(&text_mention),
            "boost_bot",
            Some(&json!(42)),
        ));
    }

    #[test]
    fn external_threads_have_isolated_stable_session_ids() {
        let first = session_id("integration", "slack:workspace:channel:100.1");
        assert_eq!(
            first,
            session_id("integration", "slack:workspace:channel:100.1")
        );
        assert_ne!(
            first,
            session_id("integration", "slack:workspace:channel:100.2")
        );
        assert_ne!(first, session_id("other", "slack:workspace:channel:100.1"));
        assert_ne!(
            session_id("integration", "telegram:chat:main"),
            session_id("integration", "telegram:chat:22"),
        );
    }

    #[tokio::test]
    async fn migration_recovers_interrupted_external_work_idempotently() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::connect(&root.path().join("state.sqlite3"))
            .await
            .unwrap();
        let session = json!({
            "id":"session", "status":"running", "activity":"working",
            "messages":[
                {"id":"message","role":"user","delivery":"processing","actions":[{"id":"action","status":"running"}]},
                {"id":"outbound","role":"assistant","delivery":"sending"}
            ],
            "followUps":[{"id":"follow-up","status":"processing"}]
        });
        save_document(&db, SESSIONS, &session).await.unwrap();
        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();
        let recovered = document(&db, SESSIONS, "session").await.unwrap();
        assert_eq!(recovered["status"], "idle");
        assert_eq!(recovered["messages"][0]["delivery"], "queued");
        assert_eq!(recovered["messages"][0]["actions"][0]["status"], "failed");
        assert_eq!(recovered["messages"][1]["delivery"], "failed");
        assert_eq!(recovered["messages"][1]["deliveryError"].is_string(), true);
        assert_eq!(recovered["followUps"][0]["status"], "ready");
    }

    #[tokio::test]
    async fn integration_secrets_are_private_and_round_trip() {
        let root = tempfile::tempdir().unwrap();
        let manager = AgentIntegrationManager::new(root.path().join("secrets"))
            .await
            .unwrap();
        manager
            .write_secrets("connection", &json!({"botToken":"top-secret"}))
            .await
            .unwrap();
        assert_eq!(
            manager.secrets("connection").await.unwrap()["botToken"],
            "top-secret"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(manager.secret_path("connection"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn approval_authorization_redaction_and_delete_cleanup_are_enforced() {
        let (_root, state) = fixture().await;
        let connection = json!({
            "id":"integration", "agentId":"pock", "provider":"telegram", "name":"Telegram",
            "enabled":false, "bot":{"id":42,"name":"Bot"}, "workspace":"", "status":"disabled",
            "lastConnectedAt":null, "lastActivityAt":null, "lastError":null,
            "createdAt":"2026-01-01T00:00:00Z", "updatedAt":"2026-01-01T00:00:00Z",
            "botToken":"must-not-leak"
        });
        let chat = json!({
            "id":"chat", "integrationId":"integration", "externalId":"123", "name":"Team",
            "kind":"group", "status":"pending", "lastSeenAt":"2026-01-01T00:00:00Z",
            "createdAt":"2026-01-01T00:00:00Z"
        });
        save_document(&state.db, CONNECTIONS, &connection)
            .await
            .unwrap();
        save_document(&state.db, CHATS, &chat).await.unwrap();
        assert!(
            approve(
                State(state.clone()),
                AxumPath(("pock".into(), "integration".into(), "chat".into())),
                Extension(user("member")),
            )
            .await
            .is_err()
        );
        let Json(approved) = approve(
            State(state.clone()),
            AxumPath(("pock".into(), "integration".into(), "chat".into())),
            Extension(user("admin")),
        )
        .await
        .unwrap();
        assert_eq!(approved["status"], "approved");

        let Json(public) = list(State(state.clone()), AxumPath("pock".into()))
            .await
            .unwrap();
        assert!(public[0].get("botToken").is_none());
        assert!(public[0]["chats"][0].get("attemptedPrompt").is_none());

        save_document(
            &state.db,
            SESSIONS,
            &json!({"id":"session","integrationId":"integration"}),
        )
        .await
        .unwrap();
        save_document(
            &state.db,
            EVENTS,
            &json!({"id":"event","integrationId":"integration"}),
        )
        .await
        .unwrap();
        state
            .agent_integrations
            .write_secrets("integration", &json!({"botToken":"secret"}))
            .await
            .unwrap();
        delete(
            State(state.clone()),
            AxumPath(("pock".into(), "integration".into())),
            Extension(user("admin")),
        )
        .await
        .unwrap();
        for (namespace, id) in [
            (CONNECTIONS, "integration"),
            (CHATS, "chat"),
            (SESSIONS, "session"),
            (EVENTS, "event"),
        ] {
            assert!(document(&state.db, namespace, id).await.is_err());
        }
        assert!(
            !tokio::fs::try_exists(state.agent_integrations.secret_path("integration"))
                .await
                .unwrap()
        );
    }
}
