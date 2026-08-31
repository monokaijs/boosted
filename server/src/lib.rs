mod auth;
pub mod cli;
mod codex;
mod db;
mod error;
mod files;
mod git;
mod integrations;
mod models;
mod process;
mod remote_viewer;
mod terminal;
mod updater;

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{
        ConnectInfo, DefaultBodyLimit, Multipart, Path as AxumPath, Query, Request, State,
        WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::{HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
};
use chrono::{TimeZone, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{RwLock, broadcast};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use uuid::Uuid;

#[cfg(feature = "embedded-web")]
use axum::http::{Uri, header};
#[cfg(feature = "embedded-web")]
use rust_embed::Embed;

use crate::{
    auth::{
        authenticate, create_session, hash_password, token_hash, validate_username, verify_password,
    },
    codex::{CodexClient, CodexManager},
    db::Database,
    error::{AppError, AppResult},
    models::*,
    remote_viewer::{
        ControlEvent, MediaMessage, RemoteViewerManager, ViewerSessionPatch, ViewerSessionRequest,
    },
    terminal::TerminalManager,
};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: Option<SocketAddr>,
    pub local_bind: Option<SocketAddr>,
    pub data_dir: PathBuf,
    pub web_dir: PathBuf,
    pub web_ui_enabled: Option<bool>,
    pub allowed_ips: Option<Vec<IpAddr>>,
}

impl Config {
    pub fn default_data_dir() -> PathBuf {
        dirs_next::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("boosted")
    }

    pub fn default_web_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist")
    }

    pub fn from_env() -> Self {
        let bind = std::env::var("BOOSTED_BIND").ok().map(|value| {
            value
                .parse()
                .expect("BOOSTED_BIND must be a socket address")
        });
        let data_dir = std::env::var_os("BOOSTED_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(Self::default_data_dir);
        let web_dir = std::env::var_os("BOOSTED_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(Self::default_web_dir);
        let web_ui_enabled = std::env::var("BOOSTED_DISABLE_WEB_UI")
            .ok()
            .map(|value| !matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"));
        let allowed_ips = std::env::var("BOOSTED_ALLOWED_IPS").ok().map(|value| {
            value
                .split(',')
                .filter(|entry| !entry.trim().is_empty())
                .map(|entry| {
                    entry
                        .trim()
                        .parse()
                        .expect("BOOSTED_ALLOWED_IPS must contain comma-separated IP addresses")
                })
                .collect()
        });
        Self {
            bind,
            local_bind: None,
            data_dir,
            web_dir,
            web_ui_enabled,
            allowed_ips,
        }
    }
}

#[cfg(feature = "embedded-web")]
#[derive(Embed)]
#[folder = "../web/dist/"]
struct EmbeddedWeb;

#[derive(Clone)]
struct PendingInput {
    request_id: Value,
    question_ids: Vec<String>,
    client: CodexClient,
    resume_status: String,
}

#[derive(Clone)]
struct AppState {
    db: Database,
    codex: CodexManager,
    terminals: TerminalManager,
    remote_viewer: RemoteViewerManager,
    live: broadcast::Sender<LiveEvent>,
    sequence: Arc<AtomicU64>,
    pending_inputs: Arc<RwLock<HashMap<String, PendingInput>>>,
    active_codex_turns: Arc<RwLock<HashMap<String, String>>>,
    uploads_dir: PathBuf,
    worktrees_dir: PathBuf,
    updater: updater::ServerUpdater,
}

impl AppState {
    fn emit(&self, topic: impl Into<String>, data: Value) {
        let _ = self.live.send(LiveEvent {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            topic: topic.into(),
            data,
        });
    }

    async fn event(
        &self,
        task_id: &str,
        kind: &str,
        actor: Option<&str>,
        payload: Value,
    ) -> AppResult<()> {
        let id = self.db.add_event(task_id, kind, actor, &payload).await?;
        self.emit("task.event", json!({"taskId":task_id,"eventId":id}));
        Ok(())
    }

    async fn set_task_state(
        &self,
        task_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> AppResult<()> {
        sqlx::query("UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?")
            .bind(status)
            .bind(error)
            .bind(Utc::now().to_rfc3339())
            .bind(task_id)
            .execute(&self.db.pool)
            .await?;
        self.event(
            task_id,
            if status == "failed" {
                "error"
            } else {
                "status_changed"
            },
            None,
            json!({"message": task_status_message(status,error)}),
        )
        .await?;
        self.emit("task.updated", json!({"taskId":task_id,"status":status}));
        Ok(())
    }
}

pub async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    tokio::fs::create_dir_all(&config.data_dir).await?;
    let db = Database::connect(&config.data_dir.join("boosted.sqlite3")).await?;
    let global_settings = db.global_settings().await?;
    let bind = config.bind.unwrap_or_else(|| {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), global_settings.web_port)
    });
    let web_ui_enabled = config
        .web_ui_enabled
        .unwrap_or(global_settings.web_ui_enabled);
    let allowed_ips = match config.allowed_ips {
        Some(allowed_ips) => allowed_ips,
        None => global_settings
            .allowed_ips
            .iter()
            .map(|value| value.parse::<IpAddr>())
            .collect::<Result<Vec<_>, _>>()?,
    };
    // Reserve the HTTP ports before the slower Codex discovery starts. Desktop
    // webviews can begin requesting /setup as soon as their shell loads; an
    // already-listening socket lets that request wait for initialization instead
    // of failing immediately with a connection-refused error.
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let local_listener = match config
        .local_bind
        .filter(|local_bind| !bind_covers(bind, *local_bind))
    {
        Some(local_bind) => Some((local_bind, tokio::net::TcpListener::bind(local_bind).await?)),
        None => None,
    };
    let codex = CodexManager::new().await;
    let uploads_dir = config.data_dir.join("uploads");
    tokio::fs::create_dir_all(&uploads_dir).await?;
    let (live, _) = broadcast::channel(4096);
    let remote_viewer_settings = db.remote_viewer_settings().await?;
    let state = AppState {
        db,
        codex,
        terminals: TerminalManager::default(),
        remote_viewer: RemoteViewerManager::new(remote_viewer_settings),
        live,
        sequence: Arc::new(AtomicU64::new(1)),
        pending_inputs: Arc::new(RwLock::new(HashMap::new())),
        active_codex_turns: Arc::new(RwLock::new(HashMap::new())),
        uploads_dir,
        worktrees_dir: config.data_dir.join("worktrees"),
        updater: updater::ServerUpdater::from_env(),
    };
    let scheduler_state = state.clone();
    tokio::spawn(async move {
        integration_scheduler(scheduler_state).await;
    });
    let app = router(state, &config.web_dir, web_ui_enabled, allowed_ips);
    if let Some((local_bind, local_listener)) = local_listener {
        let local_app = app.clone();
        tokio::spawn(async move {
            tracing::info!(address=%local_bind, "Boosted local API listening");
            if let Err(error) = axum::serve(
                local_listener,
                local_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::warn!(%error, address=%local_bind, "Boosted local API stopped");
            }
        });
    }
    tracing::info!(address=%bind, web_ui_enabled, "Boosted server listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

fn bind_covers(bind: SocketAddr, local_bind: SocketAddr) -> bool {
    bind.port() == local_bind.port() && (bind.ip().is_unspecified() || bind.ip() == local_bind.ip())
}

fn router(
    state: AppState,
    web_dir: &Path,
    web_ui_enabled: bool,
    allowed_ips: Vec<IpAddr>,
) -> Router {
    let public = Router::new()
        .route("/health", get(health))
        .route("/setup", get(setup_state))
        .route("/setup/admin", post(create_admin))
        .route("/auth/login", post(login))
        .route("/ws", get(live_ws))
        .route("/terminals/{id}/ws", get(terminal_ws))
        .route(
            "/remote-viewer/sessions/{id}/media",
            get(remote_viewer_media_ws),
        )
        .route(
            "/remote-viewer/sessions/{id}/control",
            get(remote_viewer_control_ws),
        );
    let protected = Router::new()
        .route("/auth/me", get(me))
        .route("/auth/session", delete(logout))
        .route("/auth/password", put(change_password))
        .route(
            "/settings/global",
            get(read_global_settings).put(update_global_settings),
        )
        .route(
            "/settings/remote-viewer",
            get(read_remote_viewer_settings).put(update_remote_viewer_settings),
        )
        .route("/updates/status", get(read_update_status))
        .route("/updates/check", post(check_for_update))
        .route("/updates/install", post(install_update))
        .route(
            "/remote-viewer/capabilities",
            get(remote_viewer_capabilities),
        )
        .route("/remote-viewer/sources", get(remote_viewer_sources))
        .route(
            "/remote-viewer/sources/{id}/thumbnail",
            get(remote_viewer_thumbnail),
        )
        .route(
            "/remote-viewer/sessions",
            post(create_remote_viewer_session),
        )
        .route(
            "/remote-viewer/sessions/{id}",
            patch(patch_remote_viewer_session).delete(delete_remote_viewer_session),
        )
        .route("/users", get(list_users).post(create_user))
        .route("/users/{id}", patch(patch_user))
        .route("/codex/login", post(start_codex_login))
        .route("/codex/options", get(read_codex_options))
        .route(
            "/task-attachments",
            post(upload_task_attachment).layer(DefaultBodyLimit::max(22 * 1024 * 1024)),
        )
        .route(
            "/task-attachments/{id}",
            delete(delete_pending_task_attachment),
        )
        .route(
            "/codex/attachments",
            post(upload_codex_attachment).layer(DefaultBodyLimit::max(12 * 1024 * 1024)),
        )
        .route("/codex/attachments/{id}", delete(delete_codex_attachment))
        .route(
            "/codex/chats",
            get(list_codex_chats).post(create_codex_chat),
        )
        .route("/codex/chats/{id}", get(read_codex_chat))
        .route("/codex/chats/{id}/messages", post(send_codex_message))
        .route("/codex/chats/{id}/stop", post(stop_codex_turn))
        .route("/folders", get(browse_folders))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{id}/files", get(list_project_files))
        .route("/projects/{id}/file", get(read_project_file))
        .route("/projects/{id}/git/branches", get(list_project_branches))
        .route("/projects/{id}/git/history", get(project_git_history))
        .route("/projects/{id}/terminals", post(create_project_terminal))
        .route(
            "/projects/{id}/integrations",
            get(list_integrations).post(create_integration),
        )
        .route(
            "/projects/{id}/integrations/discover",
            post(discover_integration_targets),
        )
        .route(
            "/projects/{project_id}/integrations/{id}",
            put(update_integration).delete(delete_integration),
        )
        .route(
            "/projects/{project_id}/integrations/{id}/sync",
            post(sync_integration),
        )
        .route(
            "/projects/{id}/codex-settings",
            get(read_workspace_codex_settings).put(update_workspace_codex_settings),
        )
        .route(
            "/projects/{id}/codex-settings/mcps",
            post(upsert_workspace_mcp),
        )
        .route("/tasks", get(list_tasks).post(create_task))
        .route("/tasks/{id}", get(get_task))
        .route("/tasks/{id}/events", get(task_events))
        .route(
            "/tasks/{task_id}/attachments/{id}",
            get(download_task_attachment),
        )
        .route("/tasks/{id}/messages", post(send_task_message))
        .route("/tasks/{id}/plan", post(start_task_plan))
        .route("/tasks/{id}/plan/approve", post(approve_plan))
        .route("/tasks/{id}/stop", post(stop_task))
        .route("/tasks/{id}/status", put(update_task_status))
        .route("/tasks/{id}/files", get(list_files))
        .route("/tasks/{id}/file", get(read_file).put(write_file))
        .route("/tasks/{id}/git/status", get(git_status))
        .route("/tasks/{id}/git/diff", get(git_diff))
        .route("/tasks/{id}/git/stage", post(git_stage))
        .route("/tasks/{id}/git/unstage", post(git_unstage))
        .route("/tasks/{id}/git/discard", post(git_discard))
        .route("/tasks/{id}/git/commit", post(git_commit))
        .route("/tasks/{id}/git/history", get(git_history))
        .route("/tasks/{id}/terminals", post(create_terminal))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));
    let api = public.merge(protected).with_state(state);
    let app = Router::new()
        .nest("/api/v1", api)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                ]),
        )
        .layer(TraceLayer::new_for_http());
    let app = if web_ui_enabled {
        web_app_fallback(app, web_dir)
    } else {
        tracing::info!("Web UI serving is disabled");
        app
    };
    let allowed_ips = Arc::new(
        allowed_ips
            .into_iter()
            .map(normalize_ip)
            .collect::<HashSet<_>>(),
    );
    app.layer(middleware::from_fn_with_state(
        allowed_ips,
        ip_allowlist_middleware,
    ))
}

fn web_app_fallback(app: Router, web_dir: &Path) -> Router {
    let index = web_dir.join("index.html");
    if index.is_file() {
        return app
            .fallback_service(ServeDir::new(web_dir).not_found_service(ServeFile::new(index)));
    }
    embedded_web_fallback(app, web_dir)
}

fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    }
}

async fn ip_allowlist_middleware(
    State(allowed_ips): State<Arc<HashSet<IpAddr>>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if allowed_ips.is_empty() {
        return next.run(request).await;
    }
    let peer_ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| normalize_ip(address.ip()));
    if peer_ip_allowed(&allowed_ips, peer_ip) {
        next.run(request).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

fn peer_ip_allowed(allowed_ips: &HashSet<IpAddr>, peer_ip: Option<IpAddr>) -> bool {
    allowed_ips.is_empty()
        || peer_ip
            .map(normalize_ip)
            .is_some_and(|ip| ip.is_loopback() || allowed_ips.contains(&ip))
}

#[cfg(feature = "embedded-web")]
fn embedded_web_fallback(app: Router, web_dir: &Path) -> Router {
    tracing::debug!(path=%web_dir.display(), "external web assets not found; using embedded frontend");
    app.fallback(embedded_web_asset)
}

#[cfg(feature = "embedded-web")]
async fn embedded_web_asset(uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let path = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let asset = EmbeddedWeb::get(path)
        .map(|asset| (path, asset))
        .or_else(|| EmbeddedWeb::get("index.html").map(|asset| ("index.html", asset)));
    match asset {
        Some((asset_path, asset)) => {
            let content_type = mime_guess::from_path(asset_path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, content_type.as_ref())],
                asset.data.into_owned(),
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(not(feature = "embedded-web"))]
fn embedded_web_fallback(app: Router, web_dir: &Path) -> Router {
    tracing::warn!(path=%web_dir.display(), "web assets not found; build the frontend or set BOOSTED_WEB_DIR");
    let index = web_dir.join("index.html");
    app.fallback_service(ServeDir::new(web_dir).not_found_service(ServeFile::new(index)))
}

async fn auth_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let token = bearer(&headers);
    let authenticated = match token {
        Some(token) => authenticate(&state.db, token).await.ok(),
        None => None,
    };
    match authenticated {
        Some(user) => {
            request.extensions_mut().insert(user);
            next.run(request).await
        }
        None => AppError::Unauthorized.into_response(),
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn ensure_admin(user: &AuthUser) -> AppResult<()> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    version: &'static str,
    codex_available: bool,
}
async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        codex_available: state.codex.info().await.available,
    })
}

async fn read_update_status(State(state): State<AppState>) -> Json<updater::UpdateStatus> {
    Json(state.updater.status())
}

async fn check_for_update(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<updater::UpdateStatus>> {
    ensure_admin(&user)?;
    Ok(Json(state.updater.check().await?))
}

async fn install_update(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<updater::UpdateStatus>> {
    ensure_admin(&user)?;
    let status = state.updater.install().await?;
    if status.restart_pending {
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(750)).await;
            std::process::exit(updater::restart_exit_code());
        });
    }
    Ok(Json(status))
}

async fn setup_state(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(
        json!({"needsSetup":state.db.user_count().await? == 0,"codex":state.codex.info().await}),
    ))
}

#[derive(Serialize)]
struct SessionResponse {
    token: String,
    user: User,
}

async fn create_admin(
    State(state): State<AppState>,
    Json(input): Json<Credentials>,
) -> AppResult<(StatusCode, Json<SessionResponse>)> {
    if state.db.user_count().await? != 0 {
        return Err(AppError::Conflict("administrator already exists".into()));
    }
    let username = validate_username(&input.username)?;
    let hash = hash_password(&input.password)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO users(id,username,password_hash,role,must_change_password,disabled,created_at) VALUES(?,?,?,'admin',0,0,?)").bind(&id).bind(username).bind(hash).bind(now).execute(&state.db.pool).await.map_err(|_| AppError::Conflict("administrator already exists".into()))?;
    let (token, user) = create_session(&state.db, state.db.user(&id).await?).await?;
    Ok((StatusCode::CREATED, Json(SessionResponse { token, user })))
}

async fn login(
    State(state): State<AppState>,
    Json(input): Json<Credentials>,
) -> AppResult<Json<SessionResponse>> {
    let (user, hash) = state
        .db
        .user_by_username_with_hash(&input.username)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if user.disabled || !verify_password(&input.password, &hash) {
        return Err(AppError::Unauthorized);
    }
    let (token, user) = create_session(&state.db, user).await?;
    Ok(Json(SessionResponse { token, user }))
}

async fn me(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<User>> {
    Ok(Json(state.db.user(&user.id).await?))
}

async fn logout(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthUser>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    let token = bearer(&headers).ok_or(AppError::Unauthorized)?;
    state.db.revoke_session(&token_hash(token)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn change_password(
    State(state): State<AppState>,
    Extension(auth_user): Extension<AuthUser>,
    Json(input): Json<PasswordChange>,
) -> AppResult<Json<User>> {
    let (user, hash) = state
        .db
        .user_by_username_with_hash(&auth_user.username)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if !verify_password(&input.current_password, &hash) {
        return Err(AppError::BadRequest("current password is incorrect".into()));
    }
    let next = hash_password(&input.next_password)?;
    sqlx::query("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?")
        .bind(next)
        .bind(&user.id)
        .execute(&state.db.pool)
        .await?;
    Ok(Json(state.db.user(&user.id).await?))
}

async fn read_global_settings(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthUser>,
) -> AppResult<Json<GlobalSettings>> {
    Ok(Json(state.db.global_settings().await?))
}

async fn update_global_settings(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<GlobalSettingsUpdate>,
) -> AppResult<Json<GlobalSettings>> {
    ensure_admin(&user)?;
    if input.web_port == 0 {
        return Err(AppError::BadRequest(
            "web port must be between 1 and 65535".into(),
        ));
    }
    let mut allowed_ips = HashSet::new();
    for value in input.allowed_ips {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let ip = value.parse::<IpAddr>().map_err(|_| {
            AppError::BadRequest(format!("'{value}' is not a valid IPv4 or IPv6 address"))
        })?;
        allowed_ips.insert(normalize_ip(ip).to_string());
    }
    let mut allowed_ips = allowed_ips.into_iter().collect::<Vec<_>>();
    allowed_ips.sort();
    let settings = GlobalSettings {
        web_port: input.web_port,
        web_ui_enabled: input.web_ui_enabled,
        allowed_ips,
        updated_at: None,
    };
    Ok(Json(state.db.update_global_settings(&settings).await?))
}

async fn read_remote_viewer_settings(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthUser>,
) -> AppResult<Json<RemoteViewerSettings>> {
    Ok(Json(state.db.remote_viewer_settings().await?))
}

async fn update_remote_viewer_settings(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(settings): Json<RemoteViewerSettings>,
) -> AppResult<Json<RemoteViewerSettings>> {
    ensure_admin(&user)?;
    remote_viewer::validate_settings(&settings)?;
    let saved = state.db.update_remote_viewer_settings(&settings).await?;
    state.remote_viewer.apply_settings(saved.clone());
    Ok(Json(saved))
}

async fn remote_viewer_capabilities(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthUser>,
) -> Json<remote_viewer::RemoteViewerCapabilities> {
    Json(state.remote_viewer.capabilities())
}

#[derive(Deserialize)]
struct RemoteViewerSourcesQuery {
    kind: Option<String>,
}

async fn remote_viewer_sources(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthUser>,
    Query(query): Query<RemoteViewerSourcesQuery>,
) -> AppResult<Json<Vec<remote_viewer::CaptureSource>>> {
    if let Some(kind) = query.kind.as_deref()
        && !matches!(kind, "window" | "display")
    {
        return Err(AppError::BadRequest(
            "source kind must be window or display".into(),
        ));
    }
    Ok(Json(
        state.remote_viewer.list_sources(query.kind.as_deref())?,
    ))
}

async fn remote_viewer_thumbnail(
    State(state): State<AppState>,
    Extension(_user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Response> {
    let (bytes, content_type) = state.remote_viewer.thumbnail(&id)?;
    Ok(([(axum::http::header::CONTENT_TYPE, content_type)], bytes).into_response())
}

async fn create_remote_viewer_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(request): Json<ViewerSessionRequest>,
) -> AppResult<(StatusCode, Json<remote_viewer::ViewerSession>)> {
    let session = state.remote_viewer.create_session(&user.id, request)?;
    Ok((StatusCode::CREATED, Json(session)))
}

async fn patch_remote_viewer_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(patch): Json<ViewerSessionPatch>,
) -> AppResult<Json<remote_viewer::ViewerSession>> {
    Ok(Json(
        state.remote_viewer.patch_session(&user.id, &id, patch)?,
    ))
}

async fn delete_remote_viewer_session(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<StatusCode> {
    state.remote_viewer.delete_session(&user.id, &id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_users(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<Vec<User>>> {
    ensure_admin(&user)?;
    Ok(Json(state.db.users().await?))
}

async fn create_user(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<Credentials>,
) -> AppResult<(StatusCode, Json<User>)> {
    ensure_admin(&user)?;
    let username = validate_username(&input.username)?;
    let hash = hash_password(&input.password)?;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,username,password_hash,role,must_change_password,disabled,created_at) VALUES(?,?,?,'member',1,0,?)").bind(&id).bind(username).bind(hash).bind(Utc::now().to_rfc3339()).execute(&state.db.pool).await.map_err(|_| AppError::Conflict("username is already in use".into()))?;
    Ok((StatusCode::CREATED, Json(state.db.user(&id).await?)))
}

async fn patch_user(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<UserPatch>,
) -> AppResult<Json<User>> {
    ensure_admin(&user)?;
    let target = state.db.user(&id).await?;
    if target.role == "admin" {
        return Err(AppError::BadRequest(
            "the administrator account cannot be disabled".into(),
        ));
    }
    sqlx::query("UPDATE users SET disabled=? WHERE id=?")
        .bind(input.disabled)
        .bind(&id)
        .execute(&state.db.pool)
        .await?;
    if input.disabled {
        sqlx::query("DELETE FROM sessions WHERE user_id=?")
            .bind(&id)
            .execute(&state.db.pool)
            .await?;
    }
    Ok(Json(state.db.user(&id).await?))
}

async fn start_codex_login(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> AppResult<Json<Value>> {
    ensure_admin(&user)?;
    Ok(Json(state.codex.start_device_login().await?))
}

fn access_options() -> Vec<CodexAccessOption> {
    vec![
        CodexAccessOption {
            id: "fullAccess".into(),
            label: "Full access".into(),
            description: "Read and write anywhere; network access is available.".into(),
        },
        CodexAccessOption {
            id: "workspaceWrite".into(),
            label: "Workspace".into(),
            description: "Write only inside the task worktree; network access is available.".into(),
        },
        CodexAccessOption {
            id: "readOnly".into(),
            label: "Read only".into(),
            description: "Inspect files without writing or using the network.".into(),
        },
    ]
}

async fn load_codex_options(client: &CodexClient) -> AppResult<CodexOptions> {
    let response = client
        .request("model/list", json!({"limit":100,"includeHidden":false}))
        .await?;
    let models = response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            if entry
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return None;
            }
            let model = entry
                .get("model")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)?
                .to_string();
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(&model)
                .to_string();
            let default_reasoning_effort = entry
                .get("defaultReasoningEffort")
                .and_then(Value::as_str)
                .unwrap_or("medium")
                .to_string();
            let supported_reasoning_efforts = entry
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    Some(CodexReasoningEffortOption {
                        id: effort
                            .get("reasoningEffort")
                            .and_then(Value::as_str)?
                            .to_string(),
                        description: effort
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect();
            Some(CodexModelOption {
                id,
                model,
                display_name: entry
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex")
                    .to_string(),
                description: entry
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                default_reasoning_effort,
                supported_reasoning_efforts,
                input_modalities: entry
                    .get("inputModalities")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_else(|| vec!["text".into(), "image".into()]),
                is_default: entry
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    let default_model = models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first())
        .map(|model| model.model.clone())
        .ok_or_else(|| AppError::Internal("Codex returned no available models".into()))?;
    Ok(CodexOptions {
        models,
        access_modes: access_options(),
        default_model,
        default_access_mode: "fullAccess".into(),
    })
}

async fn read_codex_options(State(state): State<AppState>) -> AppResult<Json<CodexOptions>> {
    let client = state.codex.client().await?;
    Ok(Json(load_codex_options(&client).await?))
}

fn codex_image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

async fn upload_codex_attachment(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<CodexAttachment>)> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::BadRequest(format!("invalid attachment: {error}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let original_name = field
            .file_name()
            .and_then(|name| Path::new(name).file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("image")
            .to_string();
        let mime_type = field.content_type().unwrap_or("").to_string();
        let extension = codex_image_extension(&mime_type).ok_or_else(|| {
            AppError::BadRequest("attachments must be PNG, JPEG, WebP, or GIF images".into())
        })?;
        let bytes = field
            .bytes()
            .await
            .map_err(|error| AppError::BadRequest(format!("unable to read attachment: {error}")))?;
        if bytes.is_empty() {
            return Err(AppError::BadRequest("attachment is empty".into()));
        }
        if bytes.len() > 10 * 1024 * 1024 {
            return Err(AppError::BadRequest(
                "attachment exceeds the 10 MB limit".into(),
            ));
        }
        let id = format!("{}.{}", Uuid::new_v4(), extension);
        tokio::fs::write(state.uploads_dir.join(&id), bytes).await?;
        return Ok((
            StatusCode::CREATED,
            Json(CodexAttachment {
                id,
                name: original_name,
                mime_type,
            }),
        ));
    }
    Err(AppError::BadRequest("image attachment is required".into()))
}

async fn delete_codex_attachment(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<StatusCode> {
    let path = codex_attachment_path(&state.uploads_dir, &id)?;
    tokio::fs::remove_file(path).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn upload_task_attachment(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<TaskAttachment>)> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::BadRequest(format!("invalid attachment: {error}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let name = field
            .file_name()
            .and_then(|name| Path::new(name).file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("attachment")
            .to_string();
        let mime_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|error| AppError::BadRequest(format!("unable to read attachment: {error}")))?;
        if bytes.is_empty() {
            return Err(AppError::BadRequest("attachment is empty".into()));
        }
        if bytes.len() > 20 * 1024 * 1024 {
            return Err(AppError::BadRequest(
                "attachment exceeds the 20 MB limit".into(),
            ));
        }
        let id = Uuid::new_v4().to_string();
        let path = state.uploads_dir.join(format!("task-{id}"));
        tokio::fs::write(&path, &bytes).await?;
        sqlx::query("INSERT INTO pending_task_attachments(id,name,mime_type,size,path,created_by,created_at) VALUES(?,?,?,?,?,?,?)")
            .bind(&id).bind(&name).bind(&mime_type).bind(bytes.len() as i64).bind(path.to_string_lossy().to_string())
            .bind(&user.id).bind(Utc::now().to_rfc3339()).execute(&state.db.pool).await?;
        return Ok((
            StatusCode::CREATED,
            Json(TaskAttachment {
                id,
                name,
                mime_type,
                size: bytes.len() as i64,
            }),
        ));
    }
    Err(AppError::BadRequest("attachment is required".into()))
}

async fn delete_pending_task_attachment(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<StatusCode> {
    let row = sqlx::query("SELECT path FROM pending_task_attachments WHERE id=? AND created_by=?")
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&state.db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("attachment not found".into()))?;
    let path: String = row.get("path");
    sqlx::query("DELETE FROM pending_task_attachments WHERE id=?")
        .bind(&id)
        .execute(&state.db.pool)
        .await?;
    let _ = tokio::fs::remove_file(path).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn download_task_attachment(
    State(state): State<AppState>,
    AxumPath((task_id, id)): AxumPath<(String, String)>,
) -> AppResult<Response> {
    let row =
        sqlx::query("SELECT name,mime_type,path FROM task_attachments WHERE id=? AND task_id=?")
            .bind(&id)
            .bind(&task_id)
            .fetch_optional(&state.db.pool)
            .await?
            .ok_or_else(|| AppError::NotFound("attachment not found".into()))?;
    let bytes = tokio::fs::read(row.get::<String, _>("path")).await?;
    let name = row.get::<String, _>("name").replace(['\r', '\n', '"'], "_");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", row.get::<String, _>("mime_type"))
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        )
        .body(Body::from(bytes))
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn codex_attachment_path(root: &Path, id: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(id);
    if candidate.file_name().and_then(|name| name.to_str()) != Some(id) {
        return Err(AppError::BadRequest("invalid attachment id".into()));
    }
    let stem = candidate
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| AppError::BadRequest("invalid attachment id".into()))?;
    Uuid::parse_str(stem).map_err(|_| AppError::BadRequest("invalid attachment id".into()))?;
    let extension = candidate
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !matches!(extension, "png" | "jpg" | "webp" | "gif") {
        return Err(AppError::BadRequest("invalid attachment id".into()));
    }
    let path = root.join(id);
    if !path.is_file() {
        return Err(AppError::NotFound("attachment not found".into()));
    }
    Ok(path)
}

fn compact_chat_text(value: String, fallback: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let value = if compact.is_empty() {
        fallback
    } else {
        &compact
    };
    value.chars().take(220).collect()
}

fn codex_source(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(source)) => source.clone(),
        Some(Value::Object(source)) => source
            .keys()
            .next()
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        _ => "unknown".into(),
    }
}

fn codex_time(value: Option<i64>) -> String {
    let seconds = value.unwrap_or_default();
    let timestamp = if seconds > 10_000_000_000 {
        Utc.timestamp_millis_opt(seconds).single()
    } else {
        Utc.timestamp_opt(seconds, 0).single()
    };
    timestamp.unwrap_or_else(Utc::now).to_rfc3339()
}

fn codex_chat(thread: &Value) -> CodexChat {
    let preview = thread
        .get("preview")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let title = thread
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(preview);
    CodexChat {
        id: thread
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        title: compact_chat_text(title.to_string(), "Untitled chat"),
        preview: compact_chat_text(preview.to_string(), ""),
        cwd: thread
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source: codex_source(thread.get("source")),
        model: thread
            .get("model")
            .or_else(|| thread.get("modelProvider"))
            .and_then(Value::as_str)
            .map(str::to_string),
        updated_at: codex_time(
            thread
                .get("recencyAt")
                .or_else(|| thread.get("updatedAt"))
                .and_then(Value::as_i64),
        ),
        is_pinned: thread
            .get("isPinned")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        status: thread
            .pointer("/status/type")
            .and_then(Value::as_str)
            .unwrap_or("notLoaded")
            .to_string(),
    }
}

#[derive(Deserialize, Default)]
struct CodexChatListQuery {
    cwd: Option<String>,
}

async fn list_codex_chats(
    State(state): State<AppState>,
    Query(query): Query<CodexChatListQuery>,
) -> AppResult<Json<Vec<CodexChat>>> {
    let client = state.codex.client().await?;
    let mut chats = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let result = client
            .request(
                "thread/list",
                json!({
                    "cursor": cursor,
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "sourceKinds": ["cli", "vscode", "exec", "appServer", "unknown"],
                    "cwd": query.cwd.as_deref(),
                    "archived": false
                }),
            )
            .await?;
        if let Some(threads) = result.get("data").and_then(Value::as_array) {
            chats.extend(threads.iter().map(codex_chat));
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cursor.is_none() || chats.len() >= 500 {
            break;
        }
    }
    let task_thread_ids = sqlx::query_scalar::<_, String>(
        "SELECT provider_thread_id FROM tasks WHERE provider_thread_id IS NOT NULL",
    )
    .fetch_all(&state.db.pool)
    .await?
    .into_iter()
    .collect::<HashSet<_>>();
    chats.retain(|chat| !task_thread_ids.contains(&chat.id));
    chats.truncate(500);
    Ok(Json(chats))
}

async fn create_codex_chat(
    State(state): State<AppState>,
    Json(input): Json<CodexChatCreate>,
) -> AppResult<(StatusCode, Json<CodexChat>)> {
    let cwd = input.cwd.trim();
    if cwd.is_empty() || !Path::new(cwd).is_dir() {
        return Err(AppError::BadRequest(
            "chat working directory does not exist".into(),
        ));
    }
    let client = state.codex.client().await?;
    let options = load_codex_options(&client).await?;
    let requested_model = input.model.as_deref().unwrap_or(&options.default_model);
    let selected_model = options
        .models
        .iter()
        .find(|model| model.model == requested_model || model.id == requested_model)
        .ok_or_else(|| AppError::BadRequest("selected Codex model is unavailable".into()))?;
    let result = client
        .request(
            "thread/start",
            json!({
                "model": selected_model.model,
                "cwd": cwd,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "serviceName": "boosted"
            }),
        )
        .await?;
    let thread = result
        .get("thread")
        .ok_or_else(|| AppError::Internal("Codex returned no thread".into()))?;
    Ok((StatusCode::CREATED, Json(codex_chat(thread))))
}

fn codex_input_text(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|input| match input.get("type").and_then(Value::as_str) {
            Some("text") => input
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string),
            Some("image") => Some("[Image attachment]".into()),
            Some("localImage") => Some("[Image attachment]".into()),
            Some("audio") => Some("[Audio attachment]".into()),
            Some("localAudio") => Some("[Audio attachment]".into()),
            Some("skill") => Some(format!(
                "${}",
                input.get("name").and_then(Value::as_str).unwrap_or("skill")
            )),
            Some("mention") => Some(format!(
                "@{}",
                input
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("mention")
            )),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn codex_tool_text(item: &Value) -> Option<(String, String)> {
    match item.get("type").and_then(Value::as_str)? {
        "reasoning" => {
            let summary = item
                .get("summary")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n\n");
            (!summary.is_empty()).then(|| {
                (
                    "reasoning".into(),
                    format!(
                        "> **Reasoning summary**\n> {}",
                        summary.replace('\n', "\n> ")
                    ),
                )
            })
        }
        "plan" => item
            .get("text")
            .and_then(Value::as_str)
            .map(|text| ("plan".into(), format!("**Plan**\n\n{text}"))),
        "commandExecution" => {
            let command = item
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("command");
            let output = item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let exit = item
                .get("exitCode")
                .and_then(Value::as_i64)
                .map(|code| format!(" · exit {code}"))
                .unwrap_or_default();
            let body = if output.is_empty() {
                format!("`$ {command}`{exit}")
            } else {
                format!("`$ {command}`{exit}\n\n```text\n{}\n```", output.trim())
            };
            Some(("tool".into(), body))
        }
        "fileChange" => {
            let files = item
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|change| change.get("path").and_then(Value::as_str))
                .collect::<Vec<_>>();
            Some((
                "tool".into(),
                format!(
                    "**Files changed**\n\n{}",
                    files
                        .iter()
                        .map(|path| format!("- `{path}`"))
                        .collect::<Vec<_>>()
                        .join("\n")
                ),
            ))
        }
        "mcpToolCall" => Some((
            "tool".into(),
            format!(
                "**Tool** · `{}/{}`",
                item.get("server").and_then(Value::as_str).unwrap_or("MCP"),
                item.get("tool").and_then(Value::as_str).unwrap_or("call")
            ),
        )),
        "dynamicToolCall" => Some((
            "tool".into(),
            format!(
                "**Tool** · `{}`",
                item.get("tool").and_then(Value::as_str).unwrap_or("call")
            ),
        )),
        "collabAgentToolCall" => Some((
            "tool".into(),
            format!(
                "**Agent collaboration** · `{}`",
                item.get("tool").and_then(Value::as_str).unwrap_or("call")
            ),
        )),
        "webSearch" => Some((
            "tool".into(),
            format!(
                "**Web search** · {}",
                item.get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("search")
            ),
        )),
        "imageView" => Some((
            "tool".into(),
            format!(
                "**Viewed image** · `{}`",
                item.get("path").and_then(Value::as_str).unwrap_or("image")
            ),
        )),
        "contextCompaction" => Some((
            "system".into(),
            "*Codex compacted the conversation context.*".into(),
        )),
        "enteredReviewMode" => Some(("system".into(), "*Codex entered review mode.*".into())),
        "exitedReviewMode" => Some(("system".into(), "*Codex completed review mode.*".into())),
        _ => None,
    }
}

fn codex_messages(thread: &Value) -> Vec<CodexChatMessage> {
    let mut messages = Vec::new();
    let Some(turns) = thread.get("turns").and_then(Value::as_array) else {
        return messages;
    };
    for turn in turns {
        let created_at = turn
            .get("startedAt")
            .and_then(Value::as_i64)
            .map(|time| codex_time(Some(time)));
        let turn_id = turn.get("id").and_then(Value::as_str).unwrap_or("turn");
        for (index, item) in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(message) =
                codex_item_message(item, created_at.clone(), &format!("{turn_id}-item-{index}"))
            {
                messages.push(message);
            }
        }
    }
    messages
}

fn codex_item_message(
    item: &Value,
    created_at: Option<String>,
    fallback_id: &str,
) -> Option<CodexChatMessage> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("item");
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(fallback_id)
        .to_string();
    let normalized = match item_type {
        "userMessage" => {
            let content = codex_input_text(
                item.get("content")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
            );
            (!content.is_empty()).then(|| ("user".into(), "message".into(), content))
        }
        "agentMessage" => item
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| ("assistant".into(), "message".into(), text.to_string())),
        _ => codex_tool_text(item).map(|(kind, content)| ("assistant".into(), kind, content)),
    };
    normalized.map(|(role, kind, content)| CodexChatMessage {
        id,
        role,
        content,
        kind,
        created_at,
    })
}

fn codex_live_item_message(item: &Value, client_message_id: &str) -> Option<CodexChatMessage> {
    codex_item_message(item, None, "live-item").map(|mut message| {
        if message.role == "user" {
            message.id = client_message_id.to_string();
        }
        message
    })
}

fn is_codex_thread_writer_conflict(error: &AppError) -> bool {
    let message = match error {
        AppError::Internal(message) | AppError::Conflict(message) => message,
        _ => return false,
    };
    message.contains("already has an active writer")
        || message.contains("already has a live local writer")
}

async fn read_codex_chat(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<CodexChatThread>> {
    let result = state
        .codex
        .client()
        .await?
        .request(
            "thread/read",
            json!({ "threadId": id, "includeTurns": true }),
        )
        .await?;
    let thread = result
        .get("thread")
        .ok_or_else(|| AppError::Internal("Codex returned no thread".into()))?;
    Ok(Json(CodexChatThread {
        chat: codex_chat(thread),
        messages: codex_messages(thread),
    }))
}

async fn send_codex_message(
    State(state): State<AppState>,
    AxumPath(requested_thread_id): AxumPath<String>,
    Json(input): Json<CodexMessageCreate>,
) -> AppResult<(StatusCode, Json<CodexTurnStart>)> {
    let message = input.message.trim().to_string();
    if message.is_empty() && input.attachment_ids.is_empty() {
        return Err(AppError::BadRequest(
            "message or image attachment is required".into(),
        ));
    }
    if input.attachment_ids.len() > 4 {
        return Err(AppError::BadRequest(
            "a message can include at most 4 images".into(),
        ));
    }
    if state
        .active_codex_turns
        .read()
        .await
        .contains_key(&requested_thread_id)
    {
        return Err(AppError::Conflict(
            "This Codex chat already has a running turn".into(),
        ));
    }

    let client = state.codex.client().await?;
    let mut notifications = client.subscribe();
    let (thread_id, resumed, forked_from_thread_id) = match client
        .request("thread/resume", json!({ "threadId": requested_thread_id }))
        .await
    {
        Ok(resumed) => (requested_thread_id, resumed, None),
        Err(error) if is_codex_thread_writer_conflict(&error) => {
            let forked = client
                .request(
                    "thread/fork",
                    json!({
                        "threadId": requested_thread_id,
                        "threadSource": "boosted",
                        "excludeTurns": true
                    }),
                )
                .await?;
            let forked_thread_id = forked
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Internal("Codex returned no forked thread id".into()))?
                .to_string();
            (forked_thread_id, forked, Some(requested_thread_id))
        }
        Err(error) => return Err(error),
    };
    let codex_options = load_codex_options(&client).await?;
    let requested_model = input
        .model
        .as_deref()
        .or_else(|| resumed.pointer("/thread/model").and_then(Value::as_str))
        .unwrap_or(&codex_options.default_model);
    let selected_model = codex_options
        .models
        .iter()
        .find(|model| model.model == requested_model || model.id == requested_model)
        .ok_or_else(|| AppError::BadRequest("selected Codex model is unavailable".into()))?;
    let reasoning_effort = input
        .reasoning_effort
        .as_deref()
        .unwrap_or(&selected_model.default_reasoning_effort);
    if !selected_model.supported_reasoning_efforts.is_empty()
        && !selected_model
            .supported_reasoning_efforts
            .iter()
            .any(|effort| effort.id == reasoning_effort)
    {
        return Err(AppError::BadRequest(
            "selected reasoning effort is not supported by this model".into(),
        ));
    }
    if !input.attachment_ids.is_empty()
        && !selected_model
            .input_modalities
            .iter()
            .any(|modality| modality == "image")
    {
        return Err(AppError::BadRequest(
            "selected Codex model does not support image input".into(),
        ));
    }
    let access_mode = input
        .access_mode
        .as_deref()
        .unwrap_or(&codex_options.default_access_mode);
    if !codex_options
        .access_modes
        .iter()
        .any(|mode| mode.id == access_mode)
    {
        return Err(AppError::BadRequest(
            "selected Codex access mode is invalid".into(),
        ));
    }
    let cwd = resumed
        .pointer("/thread/cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sandbox_policy = match access_mode {
        "readOnly" => json!({"type":"readOnly","networkAccess":false}),
        "workspaceWrite" => {
            if cwd.is_empty() {
                return Err(AppError::BadRequest(
                    "workspace access requires a thread working directory".into(),
                ));
            }
            json!({"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":true,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
        }
        _ => json!({"type":"dangerFullAccess"}),
    };
    let mut turn_input = Vec::with_capacity(1 + input.attachment_ids.len());
    if !message.is_empty() {
        turn_input.push(json!({ "type": "text", "text": message }));
    }
    for attachment_id in &input.attachment_ids {
        let path = codex_attachment_path(&state.uploads_dir, attachment_id)?;
        turn_input.push(json!({ "type": "localImage", "path": path.to_string_lossy() }));
    }
    let client_message_id = input
        .client_message_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let forward_client_message_id = client_message_id.clone();
    let result = client
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "clientUserMessageId": client_message_id,
                "input": turn_input,
                "approvalPolicy": "never",
                "sandboxPolicy": sandbox_policy,
                "model": selected_model.model,
                "effort": reasoning_effort
            }),
        )
        .await?;
    let turn_id = result
        .pointer("/turn/id")
        .or_else(|| result.get("turnId"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Codex returned no turn id".into()))?
        .to_string();
    state
        .active_codex_turns
        .write()
        .await
        .insert(thread_id.clone(), turn_id.clone());
    state.emit(
        "codex.event",
        json!({ "threadId": thread_id, "turnId": turn_id, "method": "turn/started" }),
    );

    let forward_state = state.clone();
    let forward_thread_id = thread_id.clone();
    let forward_turn_id = turn_id.clone();
    tokio::spawn(async move {
        loop {
            let event = match notifications.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            };
            let params = event.get("params").unwrap_or(&Value::Null);
            let event_thread_id = params.get("threadId").and_then(Value::as_str);
            let event_turn_id = params
                .get("turnId")
                .and_then(Value::as_str)
                .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
            if event_thread_id != Some(forward_thread_id.as_str()) {
                continue;
            }
            if event_turn_id.is_some() && event_turn_id != Some(forward_turn_id.as_str()) {
                continue;
            }
            let Some(method) = event.get("method").and_then(Value::as_str) else {
                continue;
            };
            let data = match method {
                "item/started" | "item/completed" => {
                    let normalized = params
                        .get("item")
                        .and_then(|item| codex_live_item_message(item, &forward_client_message_id));
                    json!({ "threadId": forward_thread_id, "turnId": forward_turn_id, "method": method, "clientMessageId": forward_client_message_id, "message": normalized })
                }
                "item/agentMessage/delta"
                | "item/reasoning/summaryTextDelta"
                | "item/plan/delta"
                | "item/commandExecution/outputDelta" => json!({
                    "threadId": forward_thread_id,
                    "turnId": forward_turn_id,
                    "method": method,
                    "itemId": params.get("itemId").and_then(Value::as_str),
                    "delta": params.get("delta").and_then(Value::as_str).unwrap_or_default()
                }),
                "turn/completed" => json!({
                    "threadId": forward_thread_id,
                    "turnId": forward_turn_id,
                    "method": method,
                    "status": params.pointer("/turn/status"),
                    "error": params.pointer("/turn/error")
                }),
                "error" => {
                    json!({ "threadId": forward_thread_id, "turnId": forward_turn_id, "method": method, "error": params })
                }
                _ => continue,
            };
            forward_state.emit("codex.event", data);
            if method == "turn/completed" {
                break;
            }
        }
        let mut active = forward_state.active_codex_turns.write().await;
        if active.get(&forward_thread_id) == Some(&forward_turn_id) {
            active.remove(&forward_thread_id);
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(CodexTurnStart {
            turn_id,
            thread_id,
            forked_from_thread_id,
        }),
    ))
}

async fn stop_codex_turn(
    State(state): State<AppState>,
    AxumPath(thread_id): AxumPath<String>,
) -> AppResult<StatusCode> {
    let turn_id = state
        .active_codex_turns
        .read()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or_else(|| AppError::Conflict("This Codex chat has no running turn".into()))?;
    state
        .codex
        .client()
        .await?
        .request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct FolderBrowseQuery {
    path: Option<String>,
}

fn folder_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .map(|letter| PathBuf::from(format!("{}:\\", letter as char)))
            .filter(|path| path.is_dir())
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![PathBuf::from("/")]
    }
}

async fn has_git_marker(path: &Path) -> bool {
    tokio::fs::metadata(path.join(".git")).await.is_ok()
}

async fn browse_folders(
    Query(query): Query<FolderBrowseQuery>,
) -> AppResult<Json<FolderBrowseResponse>> {
    let requested = query
        .path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .or_else(dirs_next::home_dir)
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| AppError::Internal("unable to determine a starting folder".into()))?;
    let current = tokio::fs::canonicalize(&requested)
        .await
        .map_err(|_| AppError::BadRequest("folder does not exist or cannot be opened".into()))?;
    let metadata = tokio::fs::metadata(&current).await?;
    if !metadata.is_dir() {
        return Err(AppError::BadRequest("path is not a folder".into()));
    }

    let mut reader = tokio::fs::read_dir(&current)
        .await
        .map_err(|_| AppError::BadRequest("folder cannot be read".into()))?;
    let mut folders = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        let path = entry.path();
        let is_directory = match entry.file_type().await {
            Ok(kind) if kind.is_dir() => true,
            Ok(kind) if kind.is_symlink() => tokio::fs::metadata(&path)
                .await
                .map(|meta| meta.is_dir())
                .unwrap_or(false),
            _ => false,
        };
        if !is_directory {
            continue;
        }
        folders.push(FolderBrowseEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            is_git_repository: has_git_marker(&path).await,
        });
    }
    folders.sort_by_cached_key(|entry| entry.name.to_lowercase());
    let roots = folder_roots()
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let parent = current
        .parent()
        .map(|path| path.to_string_lossy().into_owned());
    Ok(Json(FolderBrowseResponse {
        path: current.to_string_lossy().into_owned(),
        parent,
        roots,
        entries: folders,
        is_git_repository: has_git_marker(&current).await,
    }))
}

async fn list_projects(State(state): State<AppState>) -> AppResult<Json<Vec<Project>>> {
    Ok(Json(state.db.projects().await?))
}

async fn list_project_branches(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Vec<String>>> {
    let project = state.db.project(&id).await?;
    Ok(Json(git::branches(Path::new(&project.repo_path)).await?))
}

async fn project_git_history(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HistoryQuery>,
) -> AppResult<Json<Vec<GitCommit>>> {
    let project = state.db.project(&id).await?;
    Ok(Json(
        git::history(Path::new(&project.repo_path), query.limit).await?,
    ))
}

async fn create_project_terminal(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let project = state.db.project(&id).await?;
    let session = state
        .terminals
        .create(Path::new(&project.repo_path))
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"id":session.id}))))
}

async fn create_project(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<ProjectCreate>,
) -> AppResult<(StatusCode, Json<Project>)> {
    if input.name.trim().is_empty() {
        return Err(AppError::BadRequest("project name is required".into()));
    }
    let root = git::repository_root(Path::new(&input.repo_path)).await?;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects(id,name,repo_path,default_branch,created_by,created_at) VALUES(?,?,?,?,?,?)").bind(&id).bind(input.name.trim()).bind(root.to_string_lossy().to_string()).bind(git::current_branch(&root).await?).bind(&user.id).bind(Utc::now().to_rfc3339()).execute(&state.db.pool).await.map_err(|_| AppError::Conflict("repository is already registered".into()))?;
    state.emit("project.created", json!({"projectId":id}));
    Ok((StatusCode::CREATED, Json(state.db.project(&id).await?)))
}

async fn list_integrations(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Vec<Integration>>> {
    state.db.project(&id).await?;
    Ok(Json(state.db.integrations(&id).await?))
}

async fn discover_integration_targets(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<IntegrationDiscoveryRequest>,
) -> AppResult<Json<integrations::IntegrationDiscoveryResult>> {
    state.db.project(&id).await?;
    Ok(Json(
        integrations::discover(&input.provider, &input.config).await?,
    ))
}

fn validate_integration(input: &IntegrationCreate) -> AppResult<()> {
    if !matches!(input.provider.as_str(), "gitlab" | "huly") {
        return Err(AppError::BadRequest(
            "provider must be GitLab or Huly".into(),
        ));
    }
    if input.name.trim().is_empty() {
        return Err(AppError::BadRequest("integration name is required".into()));
    }
    if let Some(minutes) = input.sync_interval_minutes {
        if !(5..=10_080).contains(&minutes) {
            return Err(AppError::BadRequest(
                "sync interval must be between 5 minutes and 7 days".into(),
            ));
        }
    }
    integrations::validate_config(&input.provider, &input.config)?;
    Ok(())
}

async fn create_integration(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(project_id): AxumPath<String>,
    Json(input): Json<IntegrationCreate>,
) -> AppResult<(StatusCode, Json<Integration>)> {
    state.db.project(&project_id).await?;
    validate_integration(&input)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO integrations(id,project_id,provider,name,config_json,enabled,sync_interval_minutes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(&project_id).bind(&input.provider).bind(input.name.trim()).bind(input.config.to_string())
        .bind(input.enabled).bind(input.sync_interval_minutes).bind(&user.id).bind(&now).bind(&now).execute(&state.db.pool).await?;
    state.emit(
        "integration.created",
        json!({"projectId":project_id,"integrationId":id}),
    );
    Ok((StatusCode::CREATED, Json(state.db.integration(&id).await?)))
}

async fn update_integration(
    State(state): State<AppState>,
    AxumPath((project_id, id)): AxumPath<(String, String)>,
    Json(input): Json<IntegrationUpdate>,
) -> AppResult<Json<Integration>> {
    let current = state.db.integration(&id).await?;
    if current.project_id != project_id {
        return Err(AppError::NotFound("integration not found".into()));
    }
    let validate = IntegrationCreate {
        provider: current.provider,
        name: input.name.clone(),
        config: input.config.clone(),
        enabled: input.enabled,
        sync_interval_minutes: input.sync_interval_minutes,
    };
    validate_integration(&validate)?;
    sqlx::query("UPDATE integrations SET name=?,config_json=?,enabled=?,sync_interval_minutes=?,updated_at=? WHERE id=?")
        .bind(input.name.trim()).bind(input.config.to_string()).bind(input.enabled).bind(input.sync_interval_minutes)
        .bind(Utc::now().to_rfc3339()).bind(&id).execute(&state.db.pool).await?;
    Ok(Json(state.db.integration(&id).await?))
}

async fn delete_integration(
    State(state): State<AppState>,
    AxumPath((project_id, id)): AxumPath<(String, String)>,
) -> AppResult<StatusCode> {
    let integration = state.db.integration(&id).await?;
    if integration.project_id != project_id {
        return Err(AppError::NotFound("integration not found".into()));
    }
    sqlx::query("DELETE FROM integrations WHERE id=?")
        .bind(&id)
        .execute(&state.db.pool)
        .await?;
    state.emit(
        "integration.deleted",
        json!({"projectId":project_id,"integrationId":id}),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn sync_integration(
    State(state): State<AppState>,
    AxumPath((project_id, id)): AxumPath<(String, String)>,
) -> AppResult<Json<IntegrationSyncResult>> {
    let integration = state.db.integration(&id).await?;
    if integration.project_id != project_id {
        return Err(AppError::NotFound("integration not found".into()));
    }
    Ok(Json(run_integration_sync(&state, &id).await?))
}

async fn run_integration_sync(state: &AppState, id: &str) -> AppResult<IntegrationSyncResult> {
    let integration = state.db.integration(id).await?;
    sqlx::query("UPDATE integrations SET last_sync_status='running',last_sync_error=NULL,updated_at=? WHERE id=?")
        .bind(Utc::now().to_rfc3339()).bind(id).execute(&state.db.pool).await?;
    let issues = match integrations::fetch_issues(&integration).await {
        Ok(issues) => issues,
        Err(error) => {
            let message = error.to_string();
            sqlx::query("UPDATE integrations SET last_synced_at=?,last_sync_status='failed',last_sync_error=?,updated_at=? WHERE id=?")
                .bind(Utc::now().to_rfc3339()).bind(&message).bind(Utc::now().to_rfc3339()).bind(id).execute(&state.db.pool).await?;
            state.emit(
                "integration.synced",
                json!({"projectId":integration.project_id,"integrationId":id,"imported":0,"skipped":0,"failed":1,"status":"failed","error":message}),
            );
            return Err(error);
        }
    };
    let created_by: String = sqlx::query_scalar("SELECT created_by FROM integrations WHERE id=?")
        .bind(id)
        .fetch_one(&state.db.pool)
        .await?;
    let mut imported = 0;
    let mut skipped = 0;
    let mut failed = 0;
    for issue in issues {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM task_sources WHERE integration_id=? AND external_id=?",
        )
        .bind(id)
        .bind(&issue.external_id)
        .fetch_one(&state.db.pool)
        .await?;
        if exists > 0 {
            skipped += 1;
            continue;
        }
        match create_imported_task(state, &integration, &created_by, &issue).await {
            Ok(_) => imported += 1,
            Err(error) => {
                failed += 1;
                tracing::warn!(integration_id=%id, %error, "failed to import task");
            }
        }
    }
    let status = if failed > 0 { "partial" } else { "success" };
    let message = format!("Imported {imported}, skipped {skipped}, failed {failed}");
    let now = Utc::now().to_rfc3339();
    sqlx::query("UPDATE integrations SET last_synced_at=?,last_sync_status=?,last_sync_error=?,updated_at=? WHERE id=?")
        .bind(&now).bind(status).bind(if failed > 0 { Some(message.as_str()) } else { None }).bind(&now).bind(id).execute(&state.db.pool).await?;
    state.emit(
        "integration.synced",
        json!({"projectId":integration.project_id,"integrationId":id,"imported":imported,"skipped":skipped,"failed":failed,"status":status}),
    );
    Ok(IntegrationSyncResult {
        imported,
        skipped,
        failed,
        message,
    })
}

async fn create_imported_task(
    state: &AppState,
    integration: &Integration,
    created_by: &str,
    issue: &integrations::ImportedIssue,
) -> AppResult<String> {
    let project = state.db.project(&integration.project_id).await?;
    let id = Uuid::new_v4().to_string();
    let branch = format!("boosted/{}-{}", slugify(&issue.title), &id[..8]);
    let worktree = state.worktrees_dir.join(&project.id).join(&id);
    git::create_worktree(
        Path::new(&project.repo_path),
        &worktree,
        &branch,
        &project.default_branch,
    )
    .await?;
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO tasks(id,project_id,title,description,status,branch_name,worktree_path,created_by,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?,?)")
        .bind(&id).bind(&project.id).bind(issue.title.trim()).bind(issue.description.trim()).bind(&branch)
        .bind(worktree.to_string_lossy().to_string()).bind(created_by).bind(&now).bind(&now).execute(&state.db.pool).await?;
    sqlx::query(
        "INSERT INTO task_options(task_id,base_branch,access_mode) VALUES(?,?,'fullAccess')",
    )
    .bind(&id)
    .bind(&project.default_branch)
    .execute(&state.db.pool)
    .await?;
    sqlx::query("INSERT INTO task_sources(task_id,integration_id,provider,external_id,external_url) VALUES(?,?,?,?,?)")
        .bind(&id).bind(&integration.id).bind(&integration.provider).bind(&issue.external_id).bind(issue.external_url.as_deref()).execute(&state.db.pool).await?;
    state
        .event(
            &id,
            "system",
            Some(created_by),
            json!({"message":format!("Imported from {}", integration.name)}),
        )
        .await?;
    state.emit("task.created", json!({"taskId":id,"projectId":project.id}));
    Ok(id)
}

async fn integration_scheduler(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        interval.tick().await;
        let ids = sqlx::query_scalar::<_, String>("SELECT id FROM integrations WHERE enabled=1 AND sync_interval_minutes IS NOT NULL AND (last_synced_at IS NULL OR datetime(last_synced_at) <= datetime('now', '-' || sync_interval_minutes || ' minutes'))")
            .fetch_all(&state.db.pool).await.unwrap_or_default();
        for id in ids {
            if let Err(error) = run_integration_sync(&state, &id).await {
                tracing::warn!(integration_id=%id, %error, "scheduled integration sync failed");
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCodexUpdate {
    instructions: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMcpUpdate {
    name: String,
    config: Value,
}

async fn workspace_instructions(state: &AppState, project_id: &str) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT instructions FROM workspace_codex_settings WHERE project_id=?",
    )
    .bind(project_id)
    .fetch_optional(&state.db.pool)
    .await?
    .filter(|value| !value.trim().is_empty()))
}

async fn read_workspace_codex_settings(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Value>> {
    let project = state.db.project(&id).await?;
    let instructions = workspace_instructions(&state, &id)
        .await?
        .unwrap_or_default();
    let info = state.codex.info().await;
    let Ok(client) = state.codex.client().await else {
        return Ok(Json(
            json!({"info":info,"instructions":instructions,"account":null,"rateLimits":null,"usage":null,"mcps":null,"config":null}),
        ));
    };
    let (account, rate_limits, usage, mcps, config) = tokio::join!(
        client.request("account/read", json!({"refreshToken":false})),
        client.request("account/rateLimits/read", Value::Null),
        client.request("account/usage/read", Value::Null),
        client.request(
            "mcpServerStatus/list",
            json!({"detail":"toolsAndAuthOnly","limit":100})
        ),
        client.request(
            "config/read",
            json!({"cwd":project.repo_path,"includeLayers":true})
        ),
    );
    Ok(Json(
        json!({"info":info,"instructions":instructions,"account":account.ok(),"rateLimits":rate_limits.ok(),"usage":usage.ok(),"mcps":mcps.ok(),"config":config.ok()}),
    ))
}

async fn update_workspace_codex_settings(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<WorkspaceCodexUpdate>,
) -> AppResult<Json<Value>> {
    state.db.project(&id).await?;
    sqlx::query("INSERT INTO workspace_codex_settings(project_id,instructions,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET instructions=excluded.instructions,updated_at=excluded.updated_at")
        .bind(&id).bind(input.instructions.trim()).bind(Utc::now().to_rfc3339()).execute(&state.db.pool).await?;
    Ok(Json(json!({"instructions":input.instructions.trim()})))
}

async fn upsert_workspace_mcp(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<WorkspaceMcpUpdate>,
) -> AppResult<Json<Value>> {
    let project = state.db.project(&id).await?;
    if input.name.is_empty()
        || !input
            .name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(AppError::BadRequest(
            "MCP name can only contain letters, numbers, dashes, and underscores".into(),
        ));
    }
    let config_dir = Path::new(&project.repo_path).join(".codex");
    tokio::fs::create_dir_all(&config_dir).await?;
    let config_path = config_dir.join("config.toml").to_string_lossy().to_string();
    let client = state.codex.client().await?;
    let result = client.request("config/value/write", json!({"keyPath":format!("mcp_servers.{}",input.name),"value":input.config,"mergeStrategy":"replace","filePath":config_path})).await?;
    client
        .request("config/mcpServer/reload", Value::Null)
        .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskListQuery {
    project_id: Option<String>,
}
async fn list_tasks(
    State(state): State<AppState>,
    Query(query): Query<TaskListQuery>,
) -> AppResult<Json<Vec<Task>>> {
    Ok(Json(state.db.tasks(query.project_id.as_deref()).await?))
}
async fn get_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Task>> {
    refresh_diff_stats(&state, &id).await.ok();
    Ok(Json(state.db.task(&id).await?))
}

async fn create_task(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<TaskCreate>,
) -> AppResult<(StatusCode, Json<Task>)> {
    if input.title.trim().is_empty() || input.description.trim().is_empty() {
        return Err(AppError::BadRequest(
            "task title and description are required".into(),
        ));
    }
    if input.attachment_ids.len() > 10 {
        return Err(AppError::BadRequest(
            "a task can have at most 10 attachments".into(),
        ));
    }
    for attachment_id in &input.attachment_ids {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pending_task_attachments WHERE id=? AND created_by=?",
        )
        .bind(attachment_id)
        .bind(&user.id)
        .fetch_one(&state.db.pool)
        .await?;
        if exists == 0 {
            return Err(AppError::BadRequest(
                "one or more attachments are unavailable".into(),
            ));
        }
    }
    let project = state.db.project(&input.project_id).await?;
    let branches = git::branches(Path::new(&project.repo_path)).await?;
    let base_branch = input
        .base_branch
        .as_deref()
        .unwrap_or(&project.default_branch);
    if !branches.iter().any(|branch| branch == base_branch) {
        return Err(AppError::BadRequest(
            "selected base branch does not exist".into(),
        ));
    }
    let access_mode = input.access_mode.as_deref().unwrap_or("fullAccess");
    if !matches!(access_mode, "fullAccess" | "workspaceWrite" | "readOnly") {
        return Err(AppError::BadRequest(
            "selected Codex access mode is invalid".into(),
        ));
    }
    let id = Uuid::new_v4().to_string();
    let short = &id[..8];
    let slug = slugify(&input.title);
    let branch = format!("boosted/{slug}-{short}");
    let worktree = state.worktrees_dir.join(&project.id).join(&id);
    git::create_worktree(
        Path::new(&project.repo_path),
        &worktree,
        &branch,
        base_branch,
    )
    .await?;
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO tasks(id,project_id,title,description,status,branch_name,worktree_path,created_by,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?,?)").bind(&id).bind(&project.id).bind(input.title.trim()).bind(input.description.trim()).bind(&branch).bind(worktree.to_string_lossy().to_string()).bind(&user.id).bind(&now).bind(&now).execute(&state.db.pool).await?;
    sqlx::query("INSERT INTO task_options(task_id,base_branch,model,reasoning_effort,access_mode) VALUES(?,?,?,?,?)").bind(&id).bind(base_branch).bind(input.model.as_deref()).bind(input.reasoning_effort.as_deref()).bind(access_mode).execute(&state.db.pool).await?;
    for attachment_id in &input.attachment_ids {
        sqlx::query("INSERT INTO task_attachments(id,task_id,name,mime_type,size,path,created_at) SELECT id,?,name,mime_type,size,path,created_at FROM pending_task_attachments WHERE id=? AND created_by=?")
            .bind(&id).bind(attachment_id).bind(&user.id).execute(&state.db.pool).await?;
        sqlx::query("DELETE FROM pending_task_attachments WHERE id=?")
            .bind(attachment_id)
            .execute(&state.db.pool)
            .await?;
    }
    state
        .event(
            &id,
            "system",
            Some(&user.id),
            json!({"message":"Task created"}),
        )
        .await?;
    state.emit("task.created", json!({"taskId":id,"projectId":project.id}));
    Ok((StatusCode::CREATED, Json(state.db.task(&id).await?)))
}

#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: i64,
}
async fn task_events(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<EventQuery>,
) -> AppResult<Json<Vec<TaskEvent>>> {
    state.db.task(&id).await?;
    Ok(Json(state.db.events(&id, query.after).await?))
}

async fn send_task_message(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<MessageCreate>,
) -> AppResult<Json<Task>> {
    let message = input.message.trim().to_string();
    if message.is_empty() {
        return Err(AppError::BadRequest("message is required".into()));
    }
    let task = state.db.task(&id).await?;
    state
        .event(&id, "user_message", Some(&user.id), json!({"text":message}))
        .await?;
    if let Some(pending) = state.pending_inputs.write().await.remove(&id) {
        let answers = pending
            .question_ids
            .into_iter()
            .map(|question| (question, json!({"answers":[message]})))
            .collect::<serde_json::Map<_, _>>();
        pending
            .client
            .respond(pending.request_id, json!({"answers":answers}))
            .await?;
        state
            .set_task_state(&id, &pending.resume_status, None)
            .await?;
    } else if matches!(task.status.as_str(), "planning" | "running") {
        let client = state.codex.client().await?;
        client.request("turn/steer", json!({"threadId":task.provider_thread_id.ok_or_else(|| AppError::Conflict("task has no Codex thread".into()))?,"expectedTurnId":task.active_turn_id.ok_or_else(|| AppError::Conflict("task has no active turn".into()))?,"input":[{"type":"text","text":message}]})).await?;
    } else {
        sqlx::query("UPDATE plans SET approved_at=NULL,approved_by=NULL WHERE task_id=?")
            .bind(&id)
            .execute(&state.db.pool)
            .await?;
        state.set_task_state(&id, "planning", None).await?;
        let runner_state = state.clone();
        let task_id = id.clone();
        let planning_prompt = if task.status == "queued" {
            format!(
                "{}\n\nAdditional instructions:\n{}",
                task.description, message
            )
        } else {
            message
        };
        tokio::spawn(async move {
            if let Err(error) =
                start_plan(runner_state.clone(), task_id.clone(), planning_prompt).await
            {
                let _ = runner_state
                    .set_task_state(&task_id, "failed", Some(&error.to_string()))
                    .await;
            }
        });
    }
    Ok(Json(state.db.task(&id).await?))
}

async fn start_task_plan(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Task>> {
    let task = state.db.task(&id).await?;
    if task.status != "queued" {
        return Err(AppError::Conflict(
            "task is not waiting to start planning".into(),
        ));
    }
    state
        .event(
            &id,
            "user_message",
            Some(&user.id),
            json!({"text":task.description}),
        )
        .await?;
    state.set_task_state(&id, "planning", None).await?;
    let runner_state = state.clone();
    let task_id = id.clone();
    let prompt = task.description;
    tokio::spawn(async move {
        if let Err(error) = start_plan(runner_state.clone(), task_id.clone(), prompt).await {
            let _ = runner_state
                .set_task_state(&task_id, "failed", Some(&error.to_string()))
                .await;
        }
    });
    Ok(Json(state.db.task(&id).await?))
}

async fn approve_plan(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<PlanApprove>,
) -> AppResult<Json<Task>> {
    let task = state.db.task(&id).await?;
    if task.status != "ready" {
        return Err(AppError::Conflict(
            "task is not waiting for plan approval".into(),
        ));
    }
    let plan = task
        .plan
        .ok_or_else(|| AppError::Conflict("task has no plan".into()))?;
    if plan.revision != input.revision {
        return Err(AppError::Conflict(
            "plan changed; review the latest revision".into(),
        ));
    }
    sqlx::query("UPDATE plans SET approved_at=?,approved_by=? WHERE task_id=? AND revision=?")
        .bind(Utc::now().to_rfc3339())
        .bind(&user.id)
        .bind(&id)
        .bind(input.revision)
        .execute(&state.db.pool)
        .await?;
    state.set_task_state(&id, "running", None).await?;
    let runner_state = state.clone();
    let task_id = id.clone();
    tokio::spawn(async move {
        if let Err(error) = start_execution(runner_state.clone(), task_id.clone()).await {
            let _ = runner_state
                .set_task_state(&task_id, "failed", Some(&error.to_string()))
                .await;
        }
    });
    Ok(Json(state.db.task(&id).await?))
}

async fn stop_task(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<Task>> {
    let task = state.db.task(&id).await?;
    let client = state.codex.client().await?;
    client.request("turn/interrupt",json!({"threadId":task.provider_thread_id.ok_or_else(||AppError::Conflict("task has no Codex thread".into()))?,"turnId":task.active_turn_id.ok_or_else(||AppError::Conflict("task is not running".into()))?})).await?;
    state
        .set_task_state(&id, "failed", Some("Run stopped by user"))
        .await?;
    Ok(Json(state.db.task(&id).await?))
}

async fn update_task_status(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<StatusUpdate>,
) -> AppResult<Json<Task>> {
    let task = state.db.task(&id).await?;
    let allowed = matches!(
        (task.status.as_str(), input.status.as_str()),
        ("review", "done") | ("done", "review")
    );
    if !allowed {
        return Err(AppError::Conflict(
            "this board transition is controlled by the agent workflow".into(),
        ));
    }
    state.set_task_state(&id, &input.status, None).await?;
    Ok(Json(state.db.task(&id).await?))
}

#[derive(Deserialize, Default)]
struct FileQuery {
    #[serde(default)]
    path: String,
}
async fn list_project_files(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FileQuery>,
) -> AppResult<Json<Vec<FileEntry>>> {
    let project = state.db.project(&id).await?;
    Ok(Json(
        files::list(Path::new(&project.repo_path), &query.path).await?,
    ))
}
async fn read_project_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FileQuery>,
) -> AppResult<Json<FileContent>> {
    let project = state.db.project(&id).await?;
    Ok(Json(
        files::read(Path::new(&project.repo_path), &query.path).await?,
    ))
}
async fn list_files(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FileQuery>,
) -> AppResult<Json<Vec<FileEntry>>> {
    let task = state.db.task(&id).await?;
    Ok(Json(
        files::list(Path::new(&task.worktree_path), &query.path).await?,
    ))
}
async fn read_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FileQuery>,
) -> AppResult<Json<FileContent>> {
    let task = state.db.task(&id).await?;
    Ok(Json(
        files::read(Path::new(&task.worktree_path), &query.path).await?,
    ))
}
async fn write_file(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<FileWrite>,
) -> AppResult<Json<FileContent>> {
    let task = state.db.task(&id).await?;
    let file = files::write(
        Path::new(&task.worktree_path),
        &input.path,
        &input.content,
        &input.revision,
    )
    .await?;
    state
        .event(
            &id,
            "file_change",
            Some(&user.id),
            json!({"path":input.path,"summary":"File saved from editor"}),
        )
        .await?;
    refresh_diff_stats(&state, &id).await?;
    Ok(Json(file))
}

async fn git_status(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<Json<GitStatus>> {
    let task = state.db.task(&id).await?;
    Ok(Json(git::status(Path::new(&task.worktree_path)).await?))
}
#[derive(Deserialize, Default)]
struct DiffQuery {
    path: Option<String>,
    #[serde(default)]
    staged: bool,
}
async fn git_diff(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<DiffQuery>,
) -> AppResult<Json<Value>> {
    let task = state.db.task(&id).await?;
    Ok(Json(
        json!({"diff":git::diff(Path::new(&task.worktree_path),query.path.as_deref(),query.staged).await?}),
    ))
}
async fn git_stage(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<GitPaths>,
) -> AppResult<Json<GitStatus>> {
    let task = state.db.task(&id).await?;
    git::stage(Path::new(&task.worktree_path), &input.paths).await?;
    Ok(Json(git::status(Path::new(&task.worktree_path)).await?))
}
async fn git_unstage(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<GitPaths>,
) -> AppResult<Json<GitStatus>> {
    let task = state.db.task(&id).await?;
    git::unstage(Path::new(&task.worktree_path), &input.paths).await?;
    Ok(Json(git::status(Path::new(&task.worktree_path)).await?))
}
async fn git_discard(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<GitPaths>,
) -> AppResult<Json<GitStatus>> {
    let task = state.db.task(&id).await?;
    git::discard(Path::new(&task.worktree_path), &input.paths).await?;
    state
        .event(
            &id,
            "system",
            Some(&user.id),
            json!({"message":format!("Discarded {} path(s)",input.paths.len())}),
        )
        .await?;
    refresh_diff_stats(&state, &id).await?;
    Ok(Json(git::status(Path::new(&task.worktree_path)).await?))
}
async fn git_commit(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<GitCommitCreate>,
) -> AppResult<Json<Value>> {
    let task = state.db.task(&id).await?;
    let commit = git::commit(Path::new(&task.worktree_path), &input.message).await?;
    state
        .event(
            &id,
            "system",
            Some(&user.id),
            json!({"message":format!("Created commit {}",&commit[..8])}),
        )
        .await?;
    refresh_diff_stats(&state, &id).await?;
    Ok(Json(json!({"commit":commit})))
}
#[derive(Deserialize)]
struct HistoryQuery {
    #[serde(default = "history_default")]
    limit: usize,
}
fn history_default() -> usize {
    100
}
async fn git_history(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HistoryQuery>,
) -> AppResult<Json<Vec<GitCommit>>> {
    let task = state.db.task(&id).await?;
    Ok(Json(
        git::history(Path::new(&task.worktree_path), query.limit).await?,
    ))
}

async fn create_terminal(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let task = state.db.task(&id).await?;
    let session = state
        .terminals
        .create(Path::new(&task.worktree_path))
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"id":session.id}))))
}

async fn live_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_live_ws(socket, state))
}
async fn handle_live_ws(mut socket: WebSocket, state: AppState) {
    let Some(Ok(WsMessage::Text(auth_message))) = socket.recv().await else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&auth_message) else {
        return;
    };
    let Some(token) = value.get("token").and_then(Value::as_str) else {
        return;
    };
    if authenticate(&state.db, token).await.is_err() {
        let _ = socket.send(WsMessage::Close(None)).await;
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let mut events = state.live.subscribe();
    loop {
        tokio::select! { event=events.recv()=>match event {Ok(event)=>{if sender.send(WsMessage::Text(serde_json::to_string(&event).unwrap_or_default().into())).await.is_err(){break}},Err(broadcast::error::RecvError::Lagged(_))=>continue,Err(_)=>break}, incoming=receiver.next()=>if incoming.is_none(){break} }
    }
}

async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_terminal_ws(socket, state, id))
}

async fn remote_viewer_media_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_remote_viewer_media_ws(socket, state, id))
}

async fn handle_remote_viewer_media_ws(mut socket: WebSocket, state: AppState, id: String) {
    let Some(user) = authenticate_websocket(&mut socket, &state).await else {
        return;
    };
    if state
        .remote_viewer
        .owned_description(&user.id, &id)
        .is_err()
    {
        let _ = socket.send(WsMessage::Close(None)).await;
        return;
    }
    let Ok((mut media, config)) = state.remote_viewer.subscribe(&user.id, &id) else {
        return;
    };
    if let Some(config) = config {
        let _ = socket.send(WsMessage::Text(config.into())).await;
    }
    let _ = socket
        .send(WsMessage::Text(
            json!({"type":"status","state":"connected"})
                .to_string()
                .into(),
        ))
        .await;
    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            message = media.recv() => match message {
                Ok(MediaMessage::Text(text)) => {
                    if sender.send(WsMessage::Text(text.into())).await.is_err() { break; }
                }
                Ok(MediaMessage::Binary(bytes)) => {
                    if sender.send(WsMessage::Binary(bytes.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = state.remote_viewer.request_keyframe(&user.id, &id);
                    continue;
                }
                Err(_) => break,
            },
            incoming = receiver.next() => match incoming {
                Some(Ok(WsMessage::Text(text))) => {
                    if serde_json::from_str::<Value>(&text).ok().and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned)).as_deref() == Some("keyframe") {
                        let _ = state.remote_viewer.request_keyframe(&user.id, &id);
                    }
                }
                Some(Ok(WsMessage::Ping(bytes))) => {
                    if sender.send(WsMessage::Pong(bytes)).await.is_err() { break; }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
    }
}

async fn remote_viewer_control_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_remote_viewer_control_ws(socket, state, id))
}

async fn handle_remote_viewer_control_ws(mut socket: WebSocket, state: AppState, id: String) {
    let Some(user) = authenticate_websocket(&mut socket, &state).await else {
        return;
    };
    if state
        .remote_viewer
        .owned_description(&user.id, &id)
        .is_err()
    {
        let _ = socket.send(WsMessage::Close(None)).await;
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let mut lease_check = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            _ = lease_check.tick() => state.remote_viewer.expire_leases(),
            incoming = receiver.next() => match incoming {
                Some(Ok(WsMessage::Text(text))) => {
                    let response = match serde_json::from_str::<ControlEvent>(&text) {
                        Ok(event) => state.remote_viewer.handle_control(&user.id, &id, event),
                        Err(error) => Err(AppError::BadRequest(format!("invalid control event: {error}"))),
                    };
                    let message = match response {
                        Ok(value) => value,
                        Err(error) => json!({"type":"error","message":error.to_string()}),
                    };
                    if sender.send(WsMessage::Text(message.to_string().into())).await.is_err() { break; }
                }
                Some(Ok(WsMessage::Ping(bytes))) => {
                    if sender.send(WsMessage::Pong(bytes)).await.is_err() { break; }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
    }
    state.remote_viewer.release_control(&user.id, &id);
}

async fn authenticate_websocket(socket: &mut WebSocket, state: &AppState) -> Option<AuthUser> {
    let Some(Ok(WsMessage::Text(auth_message))) = socket.recv().await else {
        return None;
    };
    let token = serde_json::from_str::<Value>(&auth_message)
        .ok()
        .and_then(|value| {
            value
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let Some(token) = token else {
        let _ = socket.send(WsMessage::Close(None)).await;
        return None;
    };
    match authenticate(&state.db, &token).await {
        Ok(user) => Some(user),
        Err(_) => {
            let _ = socket.send(WsMessage::Close(None)).await;
            None
        }
    }
}

async fn handle_terminal_ws(mut socket: WebSocket, state: AppState, id: String) {
    let Some(Ok(WsMessage::Text(auth_message))) = socket.recv().await else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&auth_message) else {
        return;
    };
    let Some(token) = value.get("token").and_then(Value::as_str) else {
        return;
    };
    if authenticate(&state.db, token).await.is_err() {
        let _ = socket.send(WsMessage::Close(None)).await;
        return;
    }
    let Ok(session) = state.terminals.get(&id).await else {
        return;
    };
    if let (Some(cols), Some(rows)) = (
        value.get("cols").and_then(Value::as_u64),
        value.get("rows").and_then(Value::as_u64),
    ) {
        let _ = session.resize(cols as u16, rows as u16);
    }
    let snapshot = session.snapshot();
    if !snapshot.is_empty() {
        let _ = socket.send(WsMessage::Binary(snapshot.into())).await;
    }
    let (mut sender, mut receiver) = socket.split();
    let mut output = session.subscribe();
    loop {
        tokio::select! {chunk=output.recv()=>match chunk{Ok(chunk)=>if sender.send(WsMessage::Binary(chunk.into())).await.is_err(){break},Err(broadcast::error::RecvError::Lagged(_))=>continue,Err(_)=>break},incoming=receiver.next()=>match incoming{Some(Ok(WsMessage::Text(text)))=>if let Ok(message)=serde_json::from_str::<Value>(&text){match message.get("type").and_then(Value::as_str){Some("input")=>if let Some(data)=message.get("data").and_then(Value::as_str){let _=session.write(data.as_bytes());},Some("resize")=>{let cols=message.get("cols").and_then(Value::as_u64).unwrap_or(120)as u16;let rows=message.get("rows").and_then(Value::as_u64).unwrap_or(30)as u16;let _=session.resize(cols,rows);},_=>{}}},Some(Ok(_))=>{},_=>break}}
    }
}

async fn start_plan(state: AppState, task_id: String, prompt: String) -> AppResult<()> {
    let client = state.codex.client().await?;
    let task = state.db.task(&task_id).await?;
    let codex_options = load_codex_options(&client).await?;
    let requested_model = task
        .model
        .as_deref()
        .unwrap_or(&codex_options.default_model);
    let selected_model = codex_options
        .models
        .iter()
        .find(|model| model.model == requested_model || model.id == requested_model)
        .ok_or_else(|| AppError::BadRequest("selected Codex model is unavailable".into()))?;
    let reasoning_effort = task
        .reasoning_effort
        .as_deref()
        .unwrap_or(&selected_model.default_reasoning_effort);
    if !selected_model.supported_reasoning_efforts.is_empty()
        && !selected_model
            .supported_reasoning_efforts
            .iter()
            .any(|effort| effort.id == reasoning_effort)
    {
        return Err(AppError::BadRequest(
            "selected reasoning effort is not supported by this model".into(),
        ));
    }
    sqlx::query("UPDATE task_options SET model=?,reasoning_effort=? WHERE task_id=?")
        .bind(&selected_model.model)
        .bind(reasoning_effort)
        .bind(&task_id)
        .execute(&state.db.pool)
        .await?;
    let task = state.db.task(&task_id).await?;
    let mut notifications = client.subscribe();
    let (thread_id, model) = ensure_thread(&state, &client, &task).await?;
    let revision: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(revision),0)+1 FROM plans WHERE task_id=?")
            .bind(&task_id)
            .fetch_one(&state.db.pool)
            .await?;
    sqlx::query("INSERT INTO plans(task_id,revision,steps_json) VALUES(?,?, '[]')")
        .bind(&task_id)
        .bind(revision)
        .execute(&state.db.pool)
        .await?;
    let planning_prompt = format!(
        "Inspect the repository as needed, then create a concise execution plan for the task below. You must publish at least one concrete, actionable plan step before finishing. Do not edit files or execute the task yet.\n\nTask:\n{prompt}"
    );
    let developer_instructions = workspace_instructions(&state, &task.project_id).await?;
    let result=client.request("turn/start",json!({"threadId":thread_id,"clientUserMessageId":Uuid::new_v4().to_string(),"input":[{"type":"text","text":planning_prompt}],"cwd":task.worktree_path,"approvalPolicy":"never","sandboxPolicy":{"type":"readOnly","networkAccess":false},"model":model,"effort":task.reasoning_effort,"collaborationMode":{"mode":"plan","settings":{"model":model,"reasoning_effort":task.reasoning_effort,"developer_instructions":developer_instructions}}})).await?;
    let turn_id = result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Codex did not return a turn id".into()))?
        .to_string();
    sqlx::query("UPDATE tasks SET provider_thread_id=?,active_turn_id=?,status='planning',updated_at=? WHERE id=?").bind(&thread_id).bind(&turn_id).bind(Utc::now().to_rfc3339()).bind(&task_id).execute(&state.db.pool).await?;
    tokio::spawn(async move {
        consume_turn(
            state,
            client,
            &task_id,
            &thread_id,
            &turn_id,
            "plan",
            revision,
            &mut notifications,
        )
        .await;
    });
    Ok(())
}

async fn start_execution(state: AppState, task_id: String) -> AppResult<()> {
    let task = state.db.task(&task_id).await?;
    let plan = task
        .plan
        .clone()
        .ok_or_else(|| AppError::Conflict("approved plan not found".into()))?;
    let client = state.codex.client().await?;
    let mut notifications = client.subscribe();
    let (thread_id, model) = ensure_thread(&state, &client, &task).await?;
    set_first_plan_step_in_progress(&state, &task_id, plan.revision).await?;
    let plan_text = plan
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| format!("{}. {}", index + 1, step.step))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "Execute the approved plan below completely. Make the required code changes, verify them with relevant tests or checks, and report the outcome.\n\n{plan_text}"
    );
    let sandbox_policy = match task.access_mode.as_str() {
        "readOnly" => json!({"type":"readOnly","networkAccess":false}),
        "workspaceWrite" => {
            json!({"type":"workspaceWrite","writableRoots":[task.worktree_path],"networkAccess":true,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
        }
        _ => json!({"type":"dangerFullAccess"}),
    };
    let developer_instructions = workspace_instructions(&state, &task.project_id).await?;
    let result=client.request("turn/start",json!({"threadId":thread_id,"clientUserMessageId":Uuid::new_v4().to_string(),"input":[{"type":"text","text":prompt}],"cwd":task.worktree_path,"approvalPolicy":"never","sandboxPolicy":sandbox_policy,"model":model,"effort":task.reasoning_effort,"collaborationMode":{"mode":"default","settings":{"model":model,"reasoning_effort":task.reasoning_effort,"developer_instructions":developer_instructions}}})).await?;
    let turn_id = result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("Codex did not return a turn id".into()))?
        .to_string();
    sqlx::query("UPDATE tasks SET active_turn_id=?,status='running',updated_at=? WHERE id=?")
        .bind(&turn_id)
        .bind(Utc::now().to_rfc3339())
        .bind(&task_id)
        .execute(&state.db.pool)
        .await?;
    tokio::spawn(async move {
        consume_turn(
            state,
            client,
            &task_id,
            &thread_id,
            &turn_id,
            "execute",
            plan.revision,
            &mut notifications,
        )
        .await;
    });
    Ok(())
}

async fn ensure_thread(
    state: &AppState,
    client: &CodexClient,
    task: &Task,
) -> AppResult<(String, String)> {
    let response = if let Some(thread_id) = &task.provider_thread_id {
        client.request("thread/resume",json!({"threadId":thread_id,"model":task.model,"cwd":task.worktree_path,"approvalPolicy":"never","sandbox":"read-only"})).await?
    } else {
        client.request("thread/start",json!({"model":task.model,"cwd":task.worktree_path,"approvalPolicy":"never","sandbox":"read-only","serviceName":"boosted"})).await?
    };
    let thread_id = response
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .or(task.provider_thread_id.as_deref())
        .ok_or_else(|| AppError::Internal("Codex did not return a thread id".into()))?
        .to_string();
    let model = if let Some(model) = task.model.clone().or_else(|| {
        response
            .pointer("/thread/model")
            .and_then(Value::as_str)
            .map(str::to_string)
    }) {
        model
    } else {
        load_codex_options(client).await?.default_model
    };
    sqlx::query("UPDATE tasks SET provider_thread_id=? WHERE id=?")
        .bind(&thread_id)
        .bind(&task.id)
        .execute(&state.db.pool)
        .await?;
    Ok((thread_id, model))
}

async fn consume_turn(
    state: AppState,
    client: CodexClient,
    task_id: &str,
    thread_id: &str,
    turn_id: &str,
    mode: &str,
    revision: i64,
    notifications: &mut broadcast::Receiver<Value>,
) {
    let mut last_agent = String::new();
    loop {
        let message = match notifications.recv().await {
            Ok(message) => message,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::warn!(task_id,%skipped,"Codex event consumer lagged");
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => {
                let _ = state
                    .set_task_state(task_id, "failed", Some("Codex app-server disconnected"))
                    .await;
                let _ = sqlx::query("UPDATE tasks SET active_turn_id=NULL WHERE id=?")
                    .bind(task_id)
                    .execute(&state.db.pool)
                    .await;
                break;
            }
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if params.get("threadId").and_then(Value::as_str) != Some(thread_id) {
            continue;
        }
        if params
            .get("turnId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != turn_id)
        {
            continue;
        }
        match method {
            "turn/plan/updated" => {
                let explanation = params.get("explanation").and_then(Value::as_str);
                let steps = params.get("plan").cloned().unwrap_or_else(|| json!([]));
                let normalized = normalize_steps(&steps);
                let _ = sqlx::query(
                    "UPDATE plans SET explanation=?,steps_json=? WHERE task_id=? AND revision=?",
                )
                .bind(explanation)
                .bind(normalized.to_string())
                .bind(task_id)
                .bind(revision)
                .execute(&state.db.pool)
                .await;
                let _ = state
                    .event(
                        task_id,
                        "plan_updated",
                        None,
                        json!({"revision":revision,"steps":normalized}),
                    )
                    .await;
            }
            "item/completed" => {
                if let Some(item) = params.get("item") {
                    match item.get("type").and_then(Value::as_str) {
                        Some("agentMessage") => {
                            last_agent = item
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let _ = state
                                .event(task_id, "agent_message", None, json!({"text":last_agent}))
                                .await;
                        }
                        Some("reasoning") => {
                            let text = item
                                .get("summary")
                                .and_then(Value::as_array)
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .unwrap_or_default();
                            if !text.is_empty() {
                                let _ = state
                                    .event(task_id, "reasoning", None, json!({"text":text}))
                                    .await;
                            }
                        }
                        Some("commandExecution") => {
                            let _=state.event(task_id,"command",None,json!({"command":item.get("command"),"output":item.get("aggregatedOutput"),"exitCode":item.get("exitCode")})).await;
                        }
                        Some("fileChange") => {
                            let _=state.event(task_id,"file_change",None,json!({"summary":"Codex updated files","changes":item.get("changes")})).await;
                        }
                        Some("plan") => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                let _ = sqlx::query(
                                    "UPDATE plans SET markdown=? WHERE task_id=? AND revision=?",
                                )
                                .bind(text)
                                .bind(task_id)
                                .bind(revision)
                                .execute(&state.db.pool)
                                .await;
                            }
                        }
                        _ => {}
                    }
                }
            }
            "item/tool/requestUserInput" => {
                let request_id = message.get("id").cloned().unwrap_or_else(|| json!(0));
                let question_ids = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .map(|questions| {
                        questions
                            .iter()
                            .filter_map(|q| q.get("id").and_then(Value::as_str).map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                state.pending_inputs.write().await.insert(
                    task_id.into(),
                    PendingInput {
                        request_id,
                        question_ids,
                        client: client.clone(),
                        resume_status: if mode == "plan" {
                            "planning".into()
                        } else {
                            "running".into()
                        },
                    },
                );
                let _ = state.set_task_state(task_id, "needs_input", None).await;
                let question = params
                    .pointer("/questions/0/question")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex needs more information.");
                let _ = state
                    .event(task_id, "agent_message", None, json!({"text":question}))
                    .await;
            }
            "turn/completed" => {
                let status = params
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                if status == "completed" {
                    if mode == "plan" {
                        let has_steps: i64=sqlx::query_scalar("SELECT json_array_length(steps_json) FROM plans WHERE task_id=? AND revision=?").bind(task_id).bind(revision).fetch_one(&state.db.pool).await.unwrap_or(0);
                        if has_steps == 0 {
                            let fallback_step = state
                                .db
                                .task(task_id)
                                .await
                                .map(|task| task.description)
                                .unwrap_or_else(|_| {
                                    "Execute the requested task and verify the result".into()
                                });
                            let fallback = vec![PlanStep {
                                step: fallback_step,
                                status: "pending".into(),
                            }];
                            let _=sqlx::query("UPDATE plans SET markdown=?,steps_json=? WHERE task_id=? AND revision=?").bind(&last_agent).bind(serde_json::to_string(&fallback).unwrap_or_else(|_|"[]".into())).bind(task_id).bind(revision).execute(&state.db.pool).await;
                        }
                        let _ = state.set_task_state(task_id, "ready", None).await;
                    } else {
                        let _ = complete_plan_steps(&state, task_id, revision).await;
                        let _ = refresh_diff_stats(&state, task_id).await;
                        let _ = state.set_task_state(task_id, "review", None).await;
                    }
                } else {
                    let error = params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed");
                    let _ = state.set_task_state(task_id, "failed", Some(error)).await;
                }
                let _ = sqlx::query("UPDATE tasks SET active_turn_id=NULL WHERE id=?")
                    .bind(task_id)
                    .execute(&state.db.pool)
                    .await;
                break;
            }
            _ => {}
        }
    }
}

fn normalize_steps(value: &Value) -> Value {
    Value::Array(value.as_array().into_iter().flatten().map(|step|json!({"step":step.get("step").and_then(Value::as_str).unwrap_or(""),"status":match step.get("status").and_then(Value::as_str).unwrap_or("pending"){"inProgress"=>"in_progress",other=>other}})).collect())
}

async fn set_first_plan_step_in_progress(
    state: &AppState,
    task_id: &str,
    revision: i64,
) -> AppResult<()> {
    update_plan_step_statuses(state, task_id, revision, false).await
}

async fn complete_plan_steps(state: &AppState, task_id: &str, revision: i64) -> AppResult<()> {
    update_plan_step_statuses(state, task_id, revision, true).await
}

async fn update_plan_step_statuses(
    state: &AppState,
    task_id: &str,
    revision: i64,
    complete: bool,
) -> AppResult<()> {
    let raw: String =
        sqlx::query_scalar("SELECT steps_json FROM plans WHERE task_id=? AND revision=?")
            .bind(task_id)
            .bind(revision)
            .fetch_one(&state.db.pool)
            .await?;
    let mut steps: Vec<PlanStep> = serde_json::from_str(&raw).unwrap_or_default();
    if complete {
        for step in &mut steps {
            step.status = "completed".into();
        }
    } else if let Some(step) = steps.iter_mut().find(|step| step.status != "completed") {
        step.status = "in_progress".into();
    }
    let value = serde_json::to_value(&steps)?;
    sqlx::query("UPDATE plans SET steps_json=? WHERE task_id=? AND revision=?")
        .bind(value.to_string())
        .bind(task_id)
        .bind(revision)
        .execute(&state.db.pool)
        .await?;
    state
        .event(
            task_id,
            "plan_updated",
            None,
            json!({"revision":revision,"steps":value}),
        )
        .await?;
    Ok(())
}

async fn refresh_diff_stats(state: &AppState, task_id: &str) -> AppResult<()> {
    let task = state.db.task(task_id).await?;
    let status = git::status(Path::new(&task.worktree_path)).await?;
    let additions = status
        .changes
        .iter()
        .map(|change| change.additions)
        .sum::<i64>();
    let deletions = status
        .changes
        .iter()
        .map(|change| change.deletions)
        .sum::<i64>();
    sqlx::query("UPDATE tasks SET additions=?,deletions=?,updated_at=? WHERE id=?")
        .bind(additions)
        .bind(deletions)
        .bind(Utc::now().to_rfc3339())
        .bind(task_id)
        .execute(&state.db.pool)
        .await?;
    state.emit(
        "task.git",
        json!({"taskId":task_id,"additions":additions,"deletions":deletions}),
    );
    Ok(())
}
fn task_status_message(status: &str, error: Option<&str>) -> String {
    match status {
        "queued" => "Task added to the board".into(),
        "planning" => "Planning started".into(),
        "ready" => "Plan is ready for approval".into(),
        "running" => "Execution started".into(),
        "needs_input" => "Codex needs input".into(),
        "review" => "Execution finished; review required".into(),
        "done" => "Task completed".into(),
        "failed" => error.unwrap_or("Task failed").into(),
        _ => status.into(),
    }
}
fn slugify(value: &str) -> String {
    let slug = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let slug = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() { "task".into() } else { slug }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_safe_slug() {
        assert_eq!(
            slugify("Add loading skeleton to SearchBox"),
            "add-loading-skeleton-to-searchbox"
        );
    }
    #[test]
    fn normalizes_plan_status() {
        assert_eq!(
            normalize_steps(&json!([{"step":"Build","status":"inProgress"}]))[0]["status"],
            "in_progress"
        );
    }
    #[test]
    fn live_user_message_keeps_client_id() {
        let item = json!({"id":"server-item","type":"userMessage","content":[{"type":"text","text":"Hello"}]});
        let message = codex_live_item_message(&item, "client-message").expect("user message");
        assert_eq!(message.id, "client-message");
        assert_eq!(message.content, "Hello");
    }
    #[test]
    fn recognizes_codex_thread_writer_conflicts() {
        assert!(is_codex_thread_writer_conflict(&AppError::Internal(
            "Codex: thread thread-a already has an active writer".into()
        )));
        assert!(is_codex_thread_writer_conflict(&AppError::Internal(
            "Codex: thread thread-a already has a live local writer".into()
        )));
        assert!(!is_codex_thread_writer_conflict(&AppError::Internal(
            "Codex app-server disconnected".into()
        )));
    }
    #[test]
    fn codex_images_only_accept_supported_mime_types() {
        assert_eq!(codex_image_extension("image/png"), Some("png"));
        assert_eq!(codex_image_extension("image/jpeg"), Some("jpg"));
        assert_eq!(codex_image_extension("image/svg+xml"), None);
        assert_eq!(codex_image_extension("text/plain"), None);
    }
    #[test]
    fn codex_attachment_paths_are_confined_to_uploads() {
        let root = tempfile::tempdir().expect("temporary uploads directory");
        let id = format!("{}.png", Uuid::new_v4());
        std::fs::write(root.path().join(&id), b"image").expect("attachment fixture");
        assert_eq!(
            codex_attachment_path(root.path(), &id).expect("valid attachment"),
            root.path().join(&id)
        );
        assert!(codex_attachment_path(root.path(), "../attachment.png").is_err());
        assert!(codex_attachment_path(root.path(), "not-a-uuid.png").is_err());
    }
    #[test]
    fn ip_allowlist_is_public_when_empty_and_always_accepts_localhost() {
        let empty = HashSet::new();
        assert!(peer_ip_allowed(
            &empty,
            Some("198.51.100.8".parse().unwrap())
        ));

        let allowed = HashSet::from(["192.0.2.10".parse().unwrap()]);
        assert!(peer_ip_allowed(
            &allowed,
            Some("192.0.2.10".parse().unwrap())
        ));
        assert!(peer_ip_allowed(
            &allowed,
            Some("127.0.0.1".parse().unwrap())
        ));
        assert!(!peer_ip_allowed(
            &allowed,
            Some("198.51.100.8".parse().unwrap())
        ));
        assert!(!peer_ip_allowed(&allowed, None));
    }
    #[test]
    fn public_listener_covers_the_desktop_local_port() {
        assert!(bind_covers(
            "0.0.0.0:4782".parse().unwrap(),
            "127.0.0.1:4782".parse().unwrap()
        ));
        assert!(bind_covers(
            "127.0.0.1:4782".parse().unwrap(),
            "127.0.0.1:4782".parse().unwrap()
        ));
        assert!(!bind_covers(
            "0.0.0.0:9000".parse().unwrap(),
            "127.0.0.1:4782".parse().unwrap()
        ));
    }
    #[tokio::test]
    async fn global_web_settings_default_and_round_trip() {
        let root = tempfile::tempdir().expect("temporary database directory");
        let db = Database::connect(&root.path().join("boosted.sqlite3"))
            .await
            .expect("database");
        let defaults = db.global_settings().await.expect("default settings");
        assert_eq!(defaults.web_port, 4782);
        assert!(defaults.web_ui_enabled);
        assert!(defaults.allowed_ips.is_empty());

        let saved = db
            .update_global_settings(&GlobalSettings {
                web_port: 9000,
                web_ui_enabled: false,
                allowed_ips: vec!["192.0.2.10".into()],
                updated_at: None,
            })
            .await
            .expect("saved settings");
        assert_eq!(saved.web_port, 9000);
        assert!(!saved.web_ui_enabled);
        assert_eq!(
            db.global_settings()
                .await
                .expect("reloaded settings")
                .allowed_ips,
            vec!["192.0.2.10"]
        );
    }
    #[tokio::test]
    async fn existing_sessions_are_migrated_to_never_expire() {
        let root = tempfile::tempdir().expect("temporary database directory");
        let database_path = root.path().join("boosted.sqlite3");
        let db = Database::connect(&database_path).await.expect("database");
        let user_id = Uuid::new_v4().to_string();
        let raw_token = "persisted-session-token";
        sqlx::query("INSERT INTO users(id,username,password_hash,role,must_change_password,disabled,created_at) VALUES(?,?,?,'member',0,0,?)")
            .bind(&user_id)
            .bind("persistent-user")
            .bind("unused-password-hash")
            .bind(Utc::now().to_rfc3339())
            .execute(&db.pool)
            .await
            .expect("user fixture");
        sqlx::query(
            "INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&user_id)
        .bind(token_hash(raw_token))
        .bind("2000-01-01T00:00:00Z")
        .bind(Utc::now().to_rfc3339())
        .execute(&db.pool)
        .await
        .expect("expired session fixture");
        db.pool.close().await;

        let db = Database::connect(&database_path)
            .await
            .expect("reopened database");
        let expires_at: String =
            sqlx::query_scalar("SELECT expires_at FROM sessions WHERE user_id=?")
                .bind(&user_id)
                .fetch_one(&db.pool)
                .await
                .expect("session expiry");
        assert_eq!(expires_at, auth::SESSION_NEVER_EXPIRES);
        let authenticated = db
            .auth_by_token_hash(&token_hash(raw_token))
            .await
            .expect("authentication")
            .expect("persistent session");
        assert_eq!(authenticated.id, user_id);
    }
    #[tokio::test]
    async fn remote_viewer_settings_default_disabled_and_round_trip() {
        let root = tempfile::tempdir().expect("temporary database directory");
        let db = Database::connect(&root.path().join("boosted.sqlite3"))
            .await
            .expect("database");
        let defaults = db
            .remote_viewer_settings()
            .await
            .expect("default viewer settings");
        assert!(!defaults.enabled);
        assert!(!defaults.control_enabled);
        assert!(defaults.audio_enabled);
        assert_eq!(defaults.default_fps, 30);
        assert_eq!(defaults.max_concurrent_streams, 4);

        let saved = RemoteViewerSettings {
            enabled: true,
            control_enabled: true,
            max_fps: 45,
            default_fps: 24,
            ..defaults
        };
        db.update_remote_viewer_settings(&saved)
            .await
            .expect("saved viewer settings");
        assert_eq!(
            db.remote_viewer_settings()
                .await
                .expect("reloaded viewer settings"),
            saved
        );
    }
    #[cfg(feature = "embedded-web")]
    #[tokio::test]
    async fn embedded_web_serves_the_spa_entrypoint() {
        let response = embedded_web_asset("/workspace/active".parse().unwrap()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
    }

    #[cfg(feature = "embedded-web")]
    #[tokio::test]
    async fn embedded_web_serves_installable_pwa_assets() {
        for (path, content_type) in [
            ("/manifest.webmanifest", "application/manifest+json"),
            ("/sw.js", "text/javascript"),
            ("/pwa-192x192.png", "image/png"),
        ] {
            let response = embedded_web_asset(path.parse().unwrap()).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                content_type,
                "{path}"
            );
        }
    }
}
