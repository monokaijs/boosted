//! PockCode provider accounts, adapted to Boosted's native Codex transport.
use super::*;
use tokio::sync::Mutex;

#[derive(Clone)]
pub(crate) struct ProviderManager {
    pub home: PathBuf,
    clients: Arc<Mutex<HashMap<String, CodexClient>>>,
    chat_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    account_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    #[cfg(test)]
    test_program: Option<PathBuf>,
}
impl ProviderManager {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            clients: Default::default(),
            chat_locks: Default::default(),
            account_locks: Default::default(),
            #[cfg(test)]
            test_program: None,
        }
    }
    #[cfg(test)]
    pub(crate) fn test_with_program(home: PathBuf, program: PathBuf) -> Self {
        Self {
            test_program: Some(program),
            ..Self::new(home)
        }
    }
    pub async fn chat_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.chat_locks
            .lock()
            .await
            .entry(id.into())
            .or_default()
            .clone()
    }
    async fn account_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.account_locks
            .lock()
            .await
            .entry(id.into())
            .or_default()
            .clone()
    }
    pub(crate) async fn agent_client(&self, home: &Path) -> AppResult<CodexClient> {
        #[cfg(test)]
        if let Some(program) = &self.test_program {
            return CodexClient::test_process_with_home(program.clone(), Some(home), true).await;
        }
        CodexClient::for_account(home, true).await
    }
    pub async fn client(&self, db: &Database, id: &str) -> AppResult<CodexClient> {
        let account = document(db, "accounts", id).await?;
        if account["providerId"] != "codex" {
            return Err(AppError::BadRequest(
                "This account is not a Codex provider".into(),
            ));
        }
        let home = account_home(self, &account)?;
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.get(id) {
            return Ok(client.clone());
        }
        tokio::fs::create_dir_all(&home).await?;
        private_directory(&home).await?;
        #[cfg(test)]
        let client = match &self.test_program {
            Some(program) => {
                CodexClient::test_process_with_home(program.clone(), Some(&home), false).await?
            }
            None => CodexClient::for_account(&home, false).await?,
        };
        #[cfg(not(test))]
        let client = CodexClient::for_account(&home, false).await?;
        clients.insert(id.into(), client.clone());
        Ok(client)
    }
    async fn invalidate(&self, id: &str) {
        if let Some(client) = self.clients.lock().await.remove(id) {
            client.shutdown().await;
        }
    }
}

pub(crate) async fn private_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}
pub(crate) fn account_home(manager: &ProviderManager, account: &Value) -> AppResult<PathBuf> {
    let default = manager
        .home
        .join(account["id"].as_str().unwrap_or_default());
    let home = match account
        .pointer("/settings/codexHome")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        Some(path) => {
            if path == "~" {
                dirs_next::home_dir().unwrap_or_default()
            } else if let Some(suffix) = path.strip_prefix("~/") {
                dirs_next::home_dir().unwrap_or_default().join(suffix)
            } else {
                PathBuf::from(path)
            }
        }
        None => default,
    };
    if !home.is_absolute() {
        return Err(AppError::BadRequest(
            "Codex home must be an absolute path".into(),
        ));
    }
    let shared = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs_next::home_dir().unwrap_or_default().join(".codex"));
    let resolved = home.canonicalize().unwrap_or_else(|_| home.clone());
    if resolved == shared.canonicalize().unwrap_or(shared) {
        return Err(AppError::BadRequest(
            "Choose a separate Codex home for this account".into(),
        ));
    }
    Ok(home)
}
pub(crate) async fn document(db: &Database, namespace: &str, id: &str) -> AppResult<Value> {
    let data = sqlx::query_scalar::<_, String>(
        "SELECT content_json FROM feature_documents WHERE namespace=? AND id=?",
    )
    .bind(namespace)
    .bind(id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("{namespace} entry not found")))?;
    Ok(serde_json::from_str(&data)?)
}
pub(crate) async fn documents(db: &Database, namespace: &str) -> AppResult<Vec<Value>> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT content_json FROM feature_documents WHERE namespace=? ORDER BY rowid",
    )
    .bind(namespace)
    .fetch_all(&db.pool)
    .await?;
    rows.into_iter()
        .map(|data| serde_json::from_str(&data).map_err(AppError::from))
        .collect()
}
pub(crate) async fn save_document(db: &Database, namespace: &str, value: &Value) -> AppResult<()> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| AppError::Internal("Missing document id".into()))?;
    sqlx::query("INSERT INTO feature_documents(namespace,id,content_json) VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET content_json=excluded.content_json").bind(namespace).bind(id).bind(serde_json::to_string(value)?).execute(&db.pool).await?;
    Ok(())
}
pub(crate) fn text(value: &Value, field: &str, limit: usize) -> AppResult<String> {
    let content = value[field].as_str().unwrap_or_default().trim();
    if content.is_empty() || content.chars().count() > limit {
        return Err(AppError::BadRequest(format!(
            "{field} must contain between 1 and {limit} characters"
        )));
    }
    Ok(content.into())
}

pub(crate) async fn list_providers(State(state): State<AppState>) -> Json<Value> {
    Json(
        json!([{"id":"codex","label":"OpenAI Codex","icon":"codex", "capabilities":["auth","chat","history","limits","models","accountSwitchHooks","localRuntime","threadLifecycle","fork","config"],"composerFeatures":["accessMode","imageAttachment"],"defaultSettings":{"accountsHome":state.providers.home,"sharedChatHome":"~/.codex"},"settingsFields":[],"accountFields":[{"key":"codexHome","label":"Codex home","type":"path"},{"key":"personality","label":"Personality","type":"string"}],"runtimeFields":[{"key":"model","label":"Model","type":"string"},{"key":"reasoningEffort","label":"Reasoning","type":"string"},{"key":"permissionMode","label":"Access","type":"string"},{"key":"serviceTier","label":"Speed","type":"string"}],"authModes":[{"mode":"device","label":"Device login"}]}]),
    )
}
pub(crate) async fn list_accounts(State(state): State<AppState>) -> AppResult<Json<Vec<Value>>> {
    let accounts = documents(&state.db, "accounts").await?;
    let mut refreshed = Vec::new();
    for account in accounts {
        refreshed.push(refresh_account(&state, account).await?);
    }
    Ok(Json(refreshed))
}
pub(crate) async fn create_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_admin(&user)?;
    if input["providerId"].as_str() != Some("codex") {
        return Err(AppError::BadRequest(
            "Only OpenAI Codex is supported".into(),
        ));
    }
    let now = Utc::now().to_rfc3339();
    let account = json!({"id":Uuid::new_v4().to_string(),"providerId":"codex","displayName":input["displayName"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("OpenAI Codex account"),"settings":input.get("settings").cloned().unwrap_or(json!({})),"runtimeDefaults":input.get("runtimeDefaults").cloned().unwrap_or(json!({"permissionMode":"default","reasoningEffort":"medium"})),"status":"DISCONNECTED","createdAt":now,"updatedAt":now});
    validate_account(&state, &account).await?;
    save_document(&state.db, "accounts", &account).await?;
    Ok((StatusCode::CREATED, Json(account)))
}
async fn validate_account(state: &AppState, account: &Value) -> AppResult<()> {
    text(account, "displayName", 200)?;
    if !account["settings"].is_object() || !account["runtimeDefaults"].is_object() {
        return Err(AppError::BadRequest(
            "Settings and runtime defaults must be objects".into(),
        ));
    }
    let home = account_home(&state.providers, account)?;
    for other in documents(&state.db, "accounts").await? {
        if other["id"] != account["id"]
            && account_home(&state.providers, &other)?
                .canonicalize()
                .unwrap_or(account_home(&state.providers, &other)?)
                == home.canonicalize().unwrap_or(home.clone())
        {
            return Err(AppError::Conflict(
                "Each account needs its own Codex home".into(),
            ));
        }
    }
    Ok(())
}
async fn refresh_account(state: &AppState, account: Value) -> AppResult<Value> {
    let id = account["id"].as_str().unwrap();
    let lock = state.providers.account_lock(id).await;
    let _guard = lock.lock().await;
    let mut account = document(&state.db, "accounts", id).await?;
    if matches!(
        account["status"].as_str(),
        Some("AUTHENTICATING" | "CONNECTED" | "INVALIDATED")
    ) {
        match state
            .providers
            .client(&state.db, account["id"].as_str().unwrap())
            .await
        {
            Ok(client) => match client
                .request("account/read", json!({"refreshToken":false}))
                .await
            {
                Ok(result) if result.get("account").is_some_and(|v| !v.is_null()) => {
                    account["status"] = json!("CONNECTED");
                    account["lastError"] = Value::Null;
                    if account["displayName"] == "OpenAI Codex account" {
                        if let Some(email) =
                            result.pointer("/account/email").and_then(Value::as_str)
                        {
                            account["displayName"] = json!(email);
                        }
                    }
                    account["authState"] = json!({"type":result.pointer("/account/type"),"email":result.pointer("/account/email"),"planType":result.pointer("/account/planType")});
                    save_document(&state.db, "accounts", &account).await?;
                }
                Ok(_) => {
                    if account["status"] == "CONNECTED" {
                        account["status"] = json!("INVALIDATED");
                        save_document(&state.db, "accounts", &account).await?;
                    }
                }
                Err(error) => {
                    account["lastError"] = json!(error.to_string());
                }
            },
            Err(error) => account["lastError"] = json!(error.to_string()),
        }
    }
    Ok(account)
}
pub(crate) async fn read_account(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        refresh_account(&state, document(&state.db, "accounts", &id).await?).await?,
    ))
}
pub(crate) async fn update_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    ensure_admin(&user)?;
    let lock = state.providers.account_lock(&id).await;
    let _guard = lock.lock().await;
    let mut account = document(&state.db, "accounts", &id).await?;
    for key in ["displayName", "settings", "runtimeDefaults"] {
        if let Some(value) = input.get(key) {
            account[key] = value.clone();
        }
    }
    validate_account(&state, &account).await?;
    if account_home(&state.providers, &account)?
        != account_home(
            &state.providers,
            &document(&state.db, "accounts", &id).await?,
        )?
    {
        let chats = documents(&state.db, "provider-chats").await?;
        let active = state.active_codex_turns.read().await;
        let has_active_chat = chats.iter().any(|chat| {
            chat["accountId"] == id && active.contains_key(chat["id"].as_str().unwrap_or_default())
        });
        drop(active);
        if state.agents.uses_account(&id).await || has_active_chat {
            return Err(AppError::Conflict(
                "Stop this account's active agents and coding runs before changing its Codex home"
                    .into(),
            ));
        }
        state.providers.invalidate(&id).await;
        account["status"] = json!("DISCONNECTED");
    }
    account["updatedAt"] = json!(Utc::now().to_rfc3339());
    save_document(&state.db, "accounts", &account).await?;
    Ok(Json(account))
}
pub(crate) async fn delete_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<StatusCode> {
    ensure_admin(&user)?;
    let lock = state.providers.account_lock(&id).await;
    let _guard = lock.lock().await;
    document(&state.db, "accounts", &id).await?;
    if documents(&state.db, "provider-chats")
        .await?
        .iter()
        .any(|chat| chat["accountId"] == id)
    {
        return Err(AppError::Conflict(
            "Move this account's coding chats to another account before deleting it".into(),
        ));
    }
    if state.agents.uses_account(&id).await {
        return Err(AppError::Conflict(
            "Stop this account's agents before deleting it".into(),
        ));
    }
    state.providers.invalidate(&id).await;
    sqlx::query("DELETE FROM feature_documents WHERE namespace='accounts' AND id=?")
        .bind(id)
        .execute(&state.db.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
pub(crate) async fn authenticate_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    ensure_admin(&user)?;
    let lock = state.providers.account_lock(&id).await;
    let _guard = lock.lock().await;
    let client = state.providers.client(&state.db, &id).await?;
    let result = client
        .request("account/login/start", json!({"type":"chatgptDeviceCode"}))
        .await?;
    let mut account = document(&state.db, "accounts", &id).await?;
    account["status"] = json!("AUTHENTICATING");
    account["lastAuthMode"] = json!("device");
    account["lastAuthUrl"] = result["verificationUrl"].clone();
    account["lastAuthUserCode"] = result["userCode"].clone();
    account["lastAuthLoginId"] = result["loginId"].clone();
    account["lastError"] = Value::Null;
    save_document(&state.db, "accounts", &account).await?;
    Ok(Json(
        json!({"accountId":id,"status":"AUTHENTICATING","authMode":"device","authUrl":result["verificationUrl"],"verificationUrl":result["verificationUrl"],"userCode":result["userCode"],"loginId":result["loginId"],"message":"Open the verification URL and enter the device code."}),
    ))
}
pub(crate) async fn account_models(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        state
            .providers
            .client(&state.db, &id)
            .await?
            .request("model/list", json!({"limit":100,"includeHidden":false}))
            .await?,
    ))
}
pub(crate) async fn account_limits(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let accounts = documents(&state.db, "accounts").await?;
    let mut data = serde_json::Map::new();
    let mut errors = serde_json::Map::new();
    for account in accounts.into_iter().filter(|a| a["status"] == "CONNECTED") {
        let id = account["id"].as_str().unwrap();
        match limits(&state, id).await {
            Ok(result) => {
                data.insert(id.into(), result);
            }
            Err(error) => {
                errors.insert(id.into(), json!(error.to_string()));
            }
        }
    }
    Ok(Json(json!({"data":data,"errors":errors})))
}
pub(crate) async fn limits(state: &AppState, id: &str) -> AppResult<Value> {
    let result = state
        .providers
        .client(&state.db, id)
        .await?
        .request("account/rateLimits/read", json!({}))
        .await?;
    Ok(json!({"rateLimits":result["rateLimits"],"raw":result}))
}
pub(crate) async fn client_for_thread(state: &AppState, id: &str) -> AppResult<CodexClient> {
    match document(&state.db, "deleted-chats", id).await {
        Ok(_) => {
            return Err(AppError::NotFound(
                "This Codex conversation was deleted".into(),
            ));
        }
        Err(AppError::NotFound(_)) => {}
        Err(error) => return Err(error),
    }
    match document(&state.db, "provider-chats", id).await {
        Ok(chat) => match chat["accountId"].as_str() {
            Some(account_id) => state.providers.client(&state.db, account_id).await,
            None => state.codex.client().await,
        },
        Err(AppError::NotFound(_)) => state.codex.client().await,
        Err(error) => Err(error),
    }
}

pub(crate) async fn pending_approvals(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Vec<Value>>> {
    let active = state.active_codex_turns.read().await.get(&id).cloned();
    Ok(Json(
        documents(&state.db, "approvals")
            .await?
            .into_iter()
            .filter(|approval| {
                approval["threadId"] == id && active.as_deref() == approval["turnId"].as_str()
            })
            .collect(),
    ))
}
pub(crate) async fn answer_approval(
    State(state): State<AppState>,
    AxumPath((id, request_id)): AxumPath<(String, String)>,
    Json(input): Json<Value>,
) -> AppResult<StatusCode> {
    let approval = document(&state.db, "approvals", &request_id).await?;
    if approval["threadId"] != id
        || state
            .active_codex_turns
            .read()
            .await
            .get(&id)
            .map(String::as_str)
            != approval["turnId"].as_str()
    {
        return Err(AppError::Conflict(
            "This approval request is no longer active".into(),
        ));
    }
    let response = codex_request_response(&approval, &input)?;
    client_for_thread(&state, &id)
        .await?
        .respond(approval["requestId"].clone(), response)
        .await?;
    sqlx::query("DELETE FROM feature_documents WHERE namespace='approvals' AND id=?")
        .bind(request_id)
        .execute(&state.db.pool)
        .await?;
    state.emit("codex.approval", json!({"threadId":id}));
    Ok(StatusCode::NO_CONTENT)
}

fn codex_request_response(request: &Value, input: &Value) -> AppResult<Value> {
    if request["method"] == "item/tool/requestUserInput" {
        let answers = input["answers"]
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Question answers are required".into()))?;
        let questions = request["params"]["questions"]
            .as_array()
            .ok_or_else(|| AppError::BadRequest("Invalid question request".into()))?;
        if answers.len() != questions.len()
            || questions.iter().any(|question| {
                let Some(id) = question["id"].as_str() else {
                    return true;
                };
                let Some(values) = answers
                    .get(id)
                    .and_then(|value| value["answers"].as_array())
                else {
                    return true;
                };
                values.is_empty()
                    || values.iter().any(|value| {
                        !value
                            .as_str()
                            .is_some_and(|answer| !answer.trim().is_empty())
                    })
            })
        {
            return Err(AppError::BadRequest(
                "Provide an answer for each question".into(),
            ));
        }
        return Ok(json!({"answers":answers}));
    }
    let decision = text(input, "decision", 30)?;
    if !matches!(decision.as_str(), "accept" | "decline" | "cancel") {
        return Err(AppError::BadRequest("Invalid approval decision".into()));
    }
    Ok(json!({"decision":decision}))
}

#[cfg(test)]
mod question_tests {
    use super::*;

    fn question_request() -> Value {
        json!({"method":"item/tool/requestUserInput","params":{"questions":[{"id":"first"},{"id":"second"}]}})
    }

    #[test]
    fn question_responses_use_question_ids_and_answer_arrays() {
        let response =
            json!({"answers":{"first":{"answers":["yes"]},"second":{"answers":["custom answer"]}}});
        assert_eq!(
            codex_request_response(&question_request(), &response).unwrap(),
            response
        );
    }

    #[test]
    fn question_responses_reject_incomplete_or_invalid_answers() {
        for input in [
            json!({"decision":"accept"}),
            json!({"answers":{"first":{"answers":["yes"]}}}),
            json!({"answers":{"first":{"answers":["yes"]},"second":{"answers":[]}}}),
            json!({"answers":{"first":{"answers":["yes"]},"second":{"answers":[42]}}}),
            json!({"answers":{"first":{"answers":["yes"]},"second":{"answers":["  "]}}}),
            json!({"answers":{"first":{"answers":["yes"]},"unknown":{"answers":["yes"]}}}),
        ] {
            assert!(codex_request_response(&question_request(), &input).is_err());
        }
    }

    #[test]
    fn command_and_file_approvals_keep_their_decision_protocol() {
        let request = json!({"method":"item/fileChange/requestApproval"});
        assert_eq!(
            codex_request_response(&request, &json!({"decision":"decline"})).unwrap(),
            json!({"decision":"decline"})
        );
        assert!(codex_request_response(&request, &json!({"decision":"unknown"})).is_err());
    }
}

pub(crate) async fn runtime_defaults(state: &AppState, id: &str) -> AppResult<Option<Value>> {
    match document(&state.db, "chat-runtime", id).await {
        Ok(settings) => Ok(Some(settings)),
        Err(AppError::NotFound(_)) => match document(&state.db, "provider-chats", id).await {
            Ok(chat) => {
                let mut defaults = chat["runtimeDefaults"].clone();
                if !defaults.is_object() {
                    defaults = json!({});
                }
                let permission = defaults["permissionMode"]
                    .as_str()
                    .unwrap_or("askForApproval");
                let (access, approval) = match permission {
                    "fullAccess" | "danger-full-access" => ("fullAccess", "never"),
                    "readOnly" | "read-only" => ("readOnly", "never"),
                    "workspaceWrite" => ("workspaceWrite", "never"),
                    _ => ("workspaceWrite", "on-request"),
                };
                if defaults.get("accessMode").is_none() {
                    defaults["accessMode"] = json!(access);
                }
                if defaults.get("approvalPolicy").is_none() {
                    defaults["approvalPolicy"] = json!(approval);
                }
                Ok(Some(defaults))
            }
            Err(AppError::NotFound(_)) => Ok(None),
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    }
}
