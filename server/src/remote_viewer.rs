use crate::{
    error::{AppError, AppResult},
    models::{RemoteViewerCodec, RemoteViewerResolution, RemoteViewerSettings},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::broadcast;
use uuid::Uuid;

const MEDIA_QUEUE_CAPACITY: usize = 12;
const LEASE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteViewerCapabilities {
    pub platform: &'static str,
    pub capture_available: bool,
    pub control_available: bool,
    pub capture_permission: &'static str,
    pub control_permission: &'static str,
    pub codecs: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
}

#[derive(Clone, Debug)]
struct NativeSource {
    public: CaptureSource,
    native_id: u32,
    pid: Option<u32>,
    x: i32,
    y: i32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSessionRequest {
    pub source_id: String,
    pub fps: Option<u32>,
    pub resolution: Option<RemoteViewerResolution>,
    #[serde(default)]
    pub supported_codecs: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSessionPatch {
    pub source_id: Option<String>,
    pub fps: Option<u32>,
    pub resolution: Option<RemoteViewerResolution>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSession {
    pub id: String,
    pub source: CaptureSource,
    pub effective_codec: String,
    pub effective_fps: u32,
    pub width: u32,
    pub height: u32,
    pub audio_enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlEvent {
    Lease,
    Heartbeat,
    ReleaseAll,
    Pointer {
        x: f64,
        y: f64,
    },
    Button {
        button: String,
        pressed: bool,
        x: Option<f64>,
        y: Option<f64>,
    },
    Wheel {
        delta_x: f64,
        delta_y: f64,
    },
    Keyboard {
        code: String,
        key: String,
        pressed: bool,
    },
    Text {
        text: String,
    },
}

#[derive(Clone, Debug)]
pub enum MediaMessage {
    Text(String),
    Binary(Vec<u8>),
}

struct SessionState {
    id: String,
    owner_id: String,
    description: Mutex<ViewerSession>,
    resolution: Mutex<RemoteViewerResolution>,
    media: broadcast::Sender<MediaMessage>,
    latest_config: Mutex<Option<String>>,
    generation: AtomicU64,
    pipeline_key: Mutex<Option<PipelineKey>>,
    supported_codecs: Vec<String>,
    input: Mutex<Option<platform::InputController>>,
}

impl SessionState {
    fn description(&self) -> ViewerSession {
        self.description
            .lock()
            .expect("viewer session lock")
            .clone()
    }

    fn stop(&self, reason: &str) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.release_input();
        let _ = self.media.send(MediaMessage::Text(
            json!({"type":"status","state":"stopped","reason":reason}).to_string(),
        ));
    }

    fn release_input(&self) {
        if let Some(mut input) = self.input.lock().expect("viewer input lock").take() {
            input.release_all();
        }
    }
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct PipelineKey {
    source_id: String,
    codec: String,
    fps: u32,
    width: u32,
    height: u32,
    bitrate_kbps: u32,
}

struct CapturePipeline {
    key: PipelineKey,
    source: NativeSource,
    subscribers: Mutex<HashMap<String, Weak<SessionState>>>,
    latest_video_config: Mutex<Option<serde_json::Value>>,
    force_keyframe: AtomicBool,
    active: AtomicBool,
}

impl CapturePipeline {
    fn subscribers(&self) -> Vec<Arc<SessionState>> {
        let mut subscribers = self
            .subscribers
            .lock()
            .expect("viewer pipeline subscribers lock");
        let live = subscribers
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        subscribers.retain(|_, session| session.strong_count() > 0);
        live
    }
}

#[derive(Clone)]
struct Lease {
    session_id: String,
    expires_at: Instant,
}

#[derive(Clone)]
struct AudioHub {
    subscribers: Arc<Mutex<HashMap<String, Weak<SessionState>>>>,
    running: Arc<AtomicBool>,
}

impl AudioHub {
    fn new() -> Self {
        Self {
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn subscribe(&self, session: &Arc<SessionState>) {
        self.subscribers
            .lock()
            .expect("viewer audio subscribers lock")
            .insert(session.id.clone(), Arc::downgrade(session));
        platform::ensure_audio_hub(self.clone());
    }

    fn unsubscribe(&self, id: &str) {
        self.subscribers
            .lock()
            .expect("viewer audio subscribers lock")
            .remove(id);
    }

    fn clear(&self) {
        self.subscribers
            .lock()
            .expect("viewer audio subscribers lock")
            .clear();
    }
}

#[derive(Clone)]
pub struct RemoteViewerManager {
    settings: Arc<Mutex<RemoteViewerSettings>>,
    sources: Arc<Mutex<HashMap<String, NativeSource>>>,
    source_keys: Arc<Mutex<HashMap<String, String>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionState>>>>,
    pipelines: Arc<Mutex<HashMap<PipelineKey, Arc<CapturePipeline>>>>,
    leases: Arc<Mutex<HashMap<String, Lease>>>,
    audio: AudioHub,
}

impl RemoteViewerManager {
    pub fn new(settings: RemoteViewerSettings) -> Self {
        Self {
            settings: Arc::new(Mutex::new(settings)),
            sources: Arc::new(Mutex::new(HashMap::new())),
            source_keys: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pipelines: Arc::new(Mutex::new(HashMap::new())),
            leases: Arc::new(Mutex::new(HashMap::new())),
            audio: AudioHub::new(),
        }
    }

    pub fn capabilities(&self) -> RemoteViewerCapabilities {
        platform::capabilities()
    }

    pub fn settings(&self) -> RemoteViewerSettings {
        self.settings.lock().expect("viewer settings lock").clone()
    }

    pub fn apply_settings(&self, settings: RemoteViewerSettings) {
        let previous = {
            let mut current = self.settings.lock().expect("viewer settings lock");
            let previous = current.clone();
            *current = settings.clone();
            previous
        };
        if previous.enabled && !settings.enabled {
            let sessions = self
                .sessions
                .lock()
                .expect("viewer sessions lock")
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for session in &sessions {
                session.stop("disabled-by-administrator");
                self.detach_pipeline(session);
            }
            self.sessions.lock().expect("viewer sessions lock").clear();
            self.audio.clear();
        }
        if previous.control_enabled && !settings.control_enabled {
            self.revoke_all_control("disabled-by-administrator");
        }
    }

    pub fn list_sources(&self, kind: Option<&str>) -> AppResult<Vec<CaptureSource>> {
        if !self.settings().enabled {
            return Err(AppError::Forbidden);
        }
        let discovered = platform::list_sources()?;
        let mut keys = self.source_keys.lock().expect("viewer source keys lock");
        let mut sources = self.sources.lock().expect("viewer sources lock");
        let mut live_ids = std::collections::HashSet::new();
        for mut source in discovered {
            let key = format!(
                "{}:{}:{}",
                source.public.kind,
                source.native_id,
                source
                    .pid
                    .map_or_else(|| "display".into(), |pid| pid.to_string())
            );
            let public_id = keys
                .entry(key)
                .or_insert_with(|| Uuid::new_v4().to_string())
                .clone();
            source.public.id = public_id.clone();
            live_ids.insert(public_id.clone());
            sources.insert(public_id, source);
        }
        sources.retain(|id, _| live_ids.contains(id));
        let mut result = sources
            .values()
            .filter(|source| kind.is_none_or(|kind| source.public.kind == kind))
            .map(|source| source.public.clone())
            .collect::<Vec<_>>();
        result.sort_by(|a, b| {
            a.app_name
                .as_deref()
                .unwrap_or("")
                .cmp(b.app_name.as_deref().unwrap_or(""))
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(result)
    }

    pub fn thumbnail(&self, source_id: &str) -> AppResult<(Vec<u8>, &'static str)> {
        if !self.settings().enabled {
            return Err(AppError::Forbidden);
        }
        let source = self.source(source_id)?;
        platform::thumbnail(&source)
    }

    pub fn create_session(
        &self,
        owner_id: &str,
        request: ViewerSessionRequest,
    ) -> AppResult<ViewerSession> {
        let settings = self.settings();
        if !settings.enabled {
            return Err(AppError::Forbidden);
        }
        let capabilities = self.capabilities();
        if !capabilities.capture_available {
            return Err(AppError::BadRequest(
                "remote capture is unavailable on this machine".into(),
            ));
        }
        let source = self.source(&request.source_id)?;
        let mut sessions = self.sessions.lock().expect("viewer sessions lock");
        if sessions.len() >= settings.max_concurrent_streams {
            return Err(AppError::Conflict(format!(
                "the maximum of {} concurrent streams is active",
                settings.max_concurrent_streams
            )));
        }
        let fps = request.fps.unwrap_or(settings.default_fps);
        validate_fps(fps, settings.max_fps)?;
        let resolution = request
            .resolution
            .unwrap_or_else(|| settings.default_resolution.clone());
        validate_resolution(&resolution, &settings.max_resolution)?;
        let codec = select_codec(&settings.preferred_codec, &request.supported_codecs)?;
        let (width, height) =
            fit_resolution(source.public.width, source.public.height, &resolution);
        let id = Uuid::new_v4().to_string();
        let description = ViewerSession {
            id: id.clone(),
            source: source.public.clone(),
            effective_codec: codec.into(),
            effective_fps: fps,
            width,
            height,
            audio_enabled: settings.audio_enabled,
        };
        let (media, _) = broadcast::channel(MEDIA_QUEUE_CAPACITY);
        let session = Arc::new(SessionState {
            id: id.clone(),
            owner_id: owner_id.into(),
            description: Mutex::new(description.clone()),
            resolution: Mutex::new(resolution),
            media,
            latest_config: Mutex::new(None),
            generation: AtomicU64::new(0),
            pipeline_key: Mutex::new(None),
            supported_codecs: request.supported_codecs,
            input: Mutex::new(None),
        });
        sessions.insert(id, session.clone());
        drop(sessions);
        if settings.audio_enabled {
            self.audio.subscribe(&session);
        }
        self.attach_pipeline(session, source, settings.max_bitrate_kbps);
        Ok(description)
    }

    pub fn patch_session(
        &self,
        owner_id: &str,
        id: &str,
        patch: ViewerSessionPatch,
    ) -> AppResult<ViewerSession> {
        let settings = self.settings();
        if !settings.enabled {
            return Err(AppError::Forbidden);
        }
        let session = self.owned_session(owner_id, id)?;
        let old = session.description();
        let source = match patch.source_id {
            Some(source_id) => self.source(&source_id)?,
            None => self.source(&old.source.id)?,
        };
        let fps = patch.fps.unwrap_or(old.effective_fps);
        validate_fps(fps, settings.max_fps)?;
        let resolution = patch.resolution.unwrap_or_else(|| {
            session
                .resolution
                .lock()
                .expect("viewer resolution lock")
                .clone()
        });
        validate_resolution(&resolution, &settings.max_resolution)?;
        let (width, height) =
            fit_resolution(source.public.width, source.public.height, &resolution);
        self.release_lease(&session);
        self.detach_pipeline(&session);
        let effective_codec = select_codec(&settings.preferred_codec, &session.supported_codecs)?;
        let next = ViewerSession {
            source: source.public.clone(),
            effective_codec: effective_codec.into(),
            effective_fps: fps,
            width,
            height,
            audio_enabled: settings.audio_enabled,
            ..old
        };
        *session.description.lock().expect("viewer session lock") = next.clone();
        *session.resolution.lock().expect("viewer resolution lock") = resolution;
        if settings.audio_enabled {
            self.audio.subscribe(&session);
        } else {
            self.audio.unsubscribe(&session.id);
        }
        let generation = session.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *session.latest_config.lock().expect("viewer config lock") = None;
        let _ = session.media.send(MediaMessage::Text(
            json!({"type":"discontinuity","generation":generation}).to_string(),
        ));
        self.attach_pipeline(session, source, settings.max_bitrate_kbps);
        Ok(next)
    }

    pub fn delete_session(&self, owner_id: &str, id: &str) -> AppResult<()> {
        let session = self.owned_session(owner_id, id)?;
        self.release_lease(&session);
        self.detach_pipeline(&session);
        session.stop("closed");
        self.audio.unsubscribe(id);
        self.sessions
            .lock()
            .expect("viewer sessions lock")
            .remove(id);
        Ok(())
    }

    pub fn owned_description(&self, owner_id: &str, id: &str) -> AppResult<ViewerSession> {
        Ok(self.owned_session(owner_id, id)?.description())
    }

    pub fn subscribe(
        &self,
        owner_id: &str,
        id: &str,
    ) -> AppResult<(broadcast::Receiver<MediaMessage>, Option<String>)> {
        let session = self.owned_session(owner_id, id)?;
        self.force_keyframe(&session);
        let config = session
            .latest_config
            .lock()
            .expect("viewer config lock")
            .clone();
        Ok((session.media.subscribe(), config))
    }

    pub fn request_keyframe(&self, owner_id: &str, id: &str) -> AppResult<()> {
        let session = self.owned_session(owner_id, id)?;
        self.force_keyframe(&session);
        Ok(())
    }

    pub fn handle_control(
        &self,
        owner_id: &str,
        id: &str,
        event: ControlEvent,
    ) -> AppResult<serde_json::Value> {
        let session = self.owned_session(owner_id, id)?;
        match event {
            ControlEvent::Lease => {
                if !self.settings().control_enabled {
                    return Err(AppError::Forbidden);
                }
                let source = self.source(&session.description().source.id)?;
                self.cleanup_expired_leases();
                let mut leases = self.leases.lock().expect("viewer leases lock");
                if let Some(lease) = leases.get(&source.public.id)
                    && lease.session_id != session.id
                {
                    return Err(AppError::Conflict(
                        "another viewer controls this source".into(),
                    ));
                }
                let controller = platform::InputController::new()?;
                session
                    .input
                    .lock()
                    .expect("viewer input lock")
                    .replace(controller);
                leases.insert(
                    source.public.id,
                    Lease {
                        session_id: session.id.clone(),
                        expires_at: Instant::now() + LEASE_TIMEOUT,
                    },
                );
                Ok(json!({"type":"lease","state":"granted"}))
            }
            ControlEvent::Heartbeat => {
                self.require_lease(&session)?;
                Ok(json!({"type":"lease","state":"active"}))
            }
            ControlEvent::ReleaseAll => {
                session.release_input();
                self.release_lease(&session);
                Ok(json!({"type":"lease","state":"released"}))
            }
            event => {
                self.require_lease(&session)?;
                let source = self.refresh_source(&session.description().source.id)?;
                let mut input = session.input.lock().expect("viewer input lock");
                input
                    .as_mut()
                    .ok_or_else(|| AppError::Conflict("control lease is not active".into()))?
                    .apply(&source, event)?;
                Ok(json!({"type":"input","state":"accepted"}))
            }
        }
    }

    pub fn release_control(&self, owner_id: &str, id: &str) {
        if let Ok(session) = self.owned_session(owner_id, id) {
            session.release_input();
            self.release_lease(&session);
        }
    }

    pub fn expire_leases(&self) {
        self.cleanup_expired_leases();
    }

    fn attach_pipeline(&self, session: Arc<SessionState>, source: NativeSource, bitrate_kbps: u32) {
        let key = pipeline_key(&session.description(), bitrate_kbps);
        let (pipeline, created) = acquire_pipeline(&self.pipelines, key.clone(), source);
        pipeline
            .subscribers
            .lock()
            .expect("viewer pipeline subscribers lock")
            .insert(session.id.clone(), Arc::downgrade(&session));
        *session
            .pipeline_key
            .lock()
            .expect("viewer pipeline key lock") = Some(key);
        if let Some(video) = pipeline
            .latest_video_config
            .lock()
            .expect("viewer pipeline config lock")
            .clone()
        {
            send_video_config_to_session(&session, video);
            pipeline.force_keyframe.store(true, Ordering::SeqCst);
        }
        if created {
            let thread_pipeline = pipeline.clone();
            if std::thread::Builder::new()
                .name(format!("viewer-pipeline-{}", &session.id[..8]))
                .spawn(move || platform::capture_loop(thread_pipeline))
                .is_err()
            {
                pipeline.active.store(false, Ordering::SeqCst);
                send_pipeline_error(
                    &pipeline,
                    "capture-failed",
                    "Unable to start capture thread",
                );
            }
        }
    }

    fn detach_pipeline(&self, session: &SessionState) {
        let Some(key) = session
            .pipeline_key
            .lock()
            .expect("viewer pipeline key lock")
            .take()
        else {
            return;
        };
        let mut pipelines = self.pipelines.lock().expect("viewer pipelines lock");
        let Some(pipeline) = pipelines.get(&key).cloned() else {
            return;
        };
        let empty = {
            let mut subscribers = pipeline
                .subscribers
                .lock()
                .expect("viewer pipeline subscribers lock");
            subscribers.remove(&session.id);
            subscribers.is_empty()
        };
        if empty {
            pipeline.active.store(false, Ordering::SeqCst);
            pipelines.remove(&key);
        }
    }

    fn force_keyframe(&self, session: &SessionState) {
        let key = session
            .pipeline_key
            .lock()
            .expect("viewer pipeline key lock")
            .clone();
        if let Some(pipeline) = key.and_then(|key| {
            self.pipelines
                .lock()
                .expect("viewer pipelines lock")
                .get(&key)
                .cloned()
        }) {
            pipeline.force_keyframe.store(true, Ordering::SeqCst);
        }
    }

    fn source(&self, id: &str) -> AppResult<NativeSource> {
        self.sources
            .lock()
            .expect("viewer sources lock")
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("capture source not found; refresh sources".into()))
    }

    fn refresh_source(&self, id: &str) -> AppResult<NativeSource> {
        let previous = self.source(id)?;
        let mut refreshed = platform::refresh_source(&previous)?;
        refreshed.public.id = id.into();
        self.sources
            .lock()
            .expect("viewer sources lock")
            .insert(id.into(), refreshed.clone());
        Ok(refreshed)
    }

    fn owned_session(&self, owner_id: &str, id: &str) -> AppResult<Arc<SessionState>> {
        let session = self
            .sessions
            .lock()
            .expect("viewer sessions lock")
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("viewer session not found".into()))?;
        if session.owner_id != owner_id {
            return Err(AppError::NotFound("viewer session not found".into()));
        }
        Ok(session)
    }

    fn require_lease(&self, session: &SessionState) -> AppResult<()> {
        if !self.settings().control_enabled {
            return Err(AppError::Forbidden);
        }
        let source_id = session.description().source.id;
        let mut leases = self.leases.lock().expect("viewer leases lock");
        let lease = leases
            .get_mut(&source_id)
            .filter(|lease| lease.session_id == session.id && lease.expires_at > Instant::now())
            .ok_or_else(|| AppError::Conflict("control lease expired or was revoked".into()))?;
        lease.expires_at = Instant::now() + LEASE_TIMEOUT;
        Ok(())
    }

    fn release_lease(&self, session: &SessionState) {
        let mut leases = self.leases.lock().expect("viewer leases lock");
        leases.retain(|_, lease| lease.session_id != session.id);
        session.release_input();
    }

    fn cleanup_expired_leases(&self) {
        let now = Instant::now();
        let expired = {
            let mut leases = self.leases.lock().expect("viewer leases lock");
            let expired = leases
                .values()
                .filter(|lease| lease.expires_at <= now)
                .map(|lease| lease.session_id.clone())
                .collect::<Vec<_>>();
            leases.retain(|_, lease| lease.expires_at > now);
            expired
        };
        let sessions = self.sessions.lock().expect("viewer sessions lock");
        for id in expired {
            if let Some(session) = sessions.get(&id) {
                session.release_input();
            }
        }
    }

    fn revoke_all_control(&self, reason: &str) {
        self.leases.lock().expect("viewer leases lock").clear();
        let sessions = self.sessions.lock().expect("viewer sessions lock");
        for session in sessions.values() {
            session.release_input();
            let _ = session.media.send(MediaMessage::Text(
                json!({"type":"control","state":"revoked","reason":reason}).to_string(),
            ));
        }
    }
}

fn pipeline_key(description: &ViewerSession, bitrate_kbps: u32) -> PipelineKey {
    PipelineKey {
        source_id: description.source.id.clone(),
        codec: description.effective_codec.clone(),
        fps: description.effective_fps,
        width: description.width,
        height: description.height,
        bitrate_kbps,
    }
}

fn acquire_pipeline(
    pipelines: &Mutex<HashMap<PipelineKey, Arc<CapturePipeline>>>,
    key: PipelineKey,
    source: NativeSource,
) -> (Arc<CapturePipeline>, bool) {
    let mut pipelines = pipelines.lock().expect("viewer pipelines lock");
    if let Some(pipeline) = pipelines
        .get(&key)
        .filter(|pipeline| pipeline.active.load(Ordering::SeqCst))
    {
        return (pipeline.clone(), false);
    }
    pipelines.remove(&key);
    let pipeline = Arc::new(CapturePipeline {
        key: key.clone(),
        source,
        subscribers: Mutex::new(HashMap::new()),
        latest_video_config: Mutex::new(None),
        force_keyframe: AtomicBool::new(true),
        active: AtomicBool::new(true),
    });
    pipelines.insert(key, pipeline.clone());
    (pipeline, true)
}

fn send_video_config_to_session(session: &SessionState, video: serde_json::Value) {
    let description = session.description();
    let config = json!({
        "type":"config",
        "generation":session.generation.load(Ordering::SeqCst),
        "video":video,
        "audio": if description.audio_enabled { Some(json!({
            "codec":"opus","sampleRate":48000,"numberOfChannels":2
        })) } else { None }
    })
    .to_string();
    *session.latest_config.lock().expect("viewer config lock") = Some(config.clone());
    let _ = session.media.send(MediaMessage::Text(config));
}

fn publish_video_config(pipeline: &CapturePipeline, video: serde_json::Value) {
    *pipeline
        .latest_video_config
        .lock()
        .expect("viewer pipeline config lock") = Some(video.clone());
    for session in pipeline.subscribers() {
        send_video_config_to_session(&session, video.clone());
    }
}

fn pipeline_send(pipeline: &CapturePipeline, message: MediaMessage) {
    for session in pipeline.subscribers() {
        let _ = session.media.send(message.clone());
    }
}

fn send_pipeline_error(pipeline: &CapturePipeline, code: &str, message: &str) {
    pipeline_send(
        pipeline,
        MediaMessage::Text(
            json!({"type":"status","state":"error","code":code,"message":message}).to_string(),
        ),
    );
}

fn validate_fps(fps: u32, max_fps: u32) -> AppResult<()> {
    if fps == 0 || fps > max_fps {
        return Err(AppError::BadRequest(format!(
            "fps must be between 1 and {max_fps}"
        )));
    }
    Ok(())
}

fn select_codec<'a>(
    policy: &RemoteViewerCodec,
    supported_codecs: &'a [String],
) -> AppResult<&'static str> {
    let supports = |codec: &str| {
        supported_codecs.is_empty() || supported_codecs.iter().any(|value| value == codec)
    };
    match policy {
        RemoteViewerCodec::H264 if supports("h264") => Ok("h264"),
        RemoteViewerCodec::Vp8 if supports("vp8") => Ok("vp8"),
        RemoteViewerCodec::Auto if supports("h264") => Ok("h264"),
        RemoteViewerCodec::Auto if supports("vp8") => Ok("vp8"),
        RemoteViewerCodec::H264 => Err(AppError::BadRequest(
            "H.264 is required by administrator policy but unsupported by this client".into(),
        )),
        RemoteViewerCodec::Vp8 => Err(AppError::BadRequest(
            "VP8 is required by administrator policy but unsupported by this client".into(),
        )),
        RemoteViewerCodec::Auto => Err(AppError::BadRequest(
            "this client supports neither H.264 nor VP8".into(),
        )),
    }
}

pub fn validate_settings(settings: &RemoteViewerSettings) -> AppResult<()> {
    if settings.max_fps == 0 || settings.max_fps > 240 {
        return Err(AppError::BadRequest(
            "maximum FPS must be between 1 and 240".into(),
        ));
    }
    validate_fps(settings.default_fps, settings.max_fps)?;
    validate_resolution(&settings.default_resolution, &settings.max_resolution)?;
    if !(100..=100_000).contains(&settings.max_bitrate_kbps) {
        return Err(AppError::BadRequest(
            "maximum bitrate must be between 100 and 100000 Kbps".into(),
        ));
    }
    if !(1..=32).contains(&settings.max_concurrent_streams) {
        return Err(AppError::BadRequest(
            "maximum concurrent streams must be between 1 and 32".into(),
        ));
    }
    Ok(())
}

fn validate_resolution(
    resolution: &RemoteViewerResolution,
    max: &RemoteViewerResolution,
) -> AppResult<()> {
    if resolution.rank() > max.rank() {
        return Err(AppError::BadRequest(
            "resolution exceeds the administrator limit".into(),
        ));
    }
    Ok(())
}

fn fit_resolution(
    source_width: u32,
    source_height: u32,
    resolution: &RemoteViewerResolution,
) -> (u32, u32) {
    let (bound_width, bound_height) = match resolution {
        RemoteViewerResolution::P720 => (1280, 720),
        RemoteViewerResolution::P1080 => (1920, 1080),
        RemoteViewerResolution::P1440 => (2560, 1440),
        RemoteViewerResolution::Native => return even_dimensions(source_width, source_height),
    };
    let (bound_width, bound_height) = if source_height > source_width {
        (bound_height, bound_width)
    } else {
        (bound_width, bound_height)
    };
    let scale = (bound_width as f64 / source_width.max(1) as f64)
        .min(bound_height as f64 / source_height.max(1) as f64)
        .min(1.0);
    even_dimensions(
        (source_width as f64 * scale).round() as u32,
        (source_height as f64 * scale).round() as u32,
    )
}

fn even_dimensions(width: u32, height: u32) -> (u32, u32) {
    ((width.max(2) / 2) * 2, (height.max(2) / 2) * 2)
}

fn media_envelope(kind: u8, key: bool, sequence: u64, pts_us: u64, payload: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(24 + payload.len());
    packet.extend_from_slice(b"BRV1");
    packet.push(kind);
    packet.push(u8::from(key));
    packet.extend_from_slice(&[0, 0]);
    packet.extend_from_slice(&sequence.to_be_bytes());
    packet.extend_from_slice(&pts_us.to_be_bytes());
    packet.extend_from_slice(payload);
    packet
}

fn media_timestamp_us() -> u64 {
    static CLOCK: OnceLock<Instant> = OnceLock::new();
    CLOCK.get_or_init(Instant::now).elapsed().as_micros() as u64
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[allow(unexpected_cfgs)]
mod platform {
    use super::*;
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
    use image::ImageFormat;
    use openh264::{
        OpenH264API,
        encoder::{
            BitRate, Encoder, EncoderConfig, FrameRate, FrameType as H264FrameType, Profile,
            RateControlMode, UsageType,
        },
        formats::YUVBuffer,
    };
    use opus_pure::{Application, MAX_PACKET_BYTES, OpusEncoder};
    use scap::{
        Target,
        capturer::{Capturer, Options, Resolution},
        frame::{AudioFormat, Frame, FrameType, VideoFrame, YUVFrame},
    };
    use std::{collections::HashSet, io::Cursor};

    struct CapturedNv12Frame {
        width: i32,
        height: i32,
        luminance_bytes: Vec<u8>,
        luminance_stride: i32,
        chrominance_bytes: Vec<u8>,
        chrominance_stride: i32,
    }

    enum VideoCapturer {
        Primary(Capturer),
        #[cfg(target_os = "macos")]
        CrossProcessWindow(scap_vc::capturer::Capturer),
    }

    impl VideoCapturer {
        fn build(source: &NativeSource, fps: u32) -> AppResult<Self> {
            #[cfg(target_os = "macos")]
            if source.public.kind == "window" {
                let target = scap_vc::get_all_targets()
                    .into_iter()
                    .find(|target| matches!(target, scap_vc::Target::Window(window) if window.id == source.native_id))
                    .ok_or_else(|| AppError::NotFound("capture source was closed".into()))?;
                let options = scap_vc::capturer::Options {
                    fps,
                    show_cursor: false,
                    show_highlight: false,
                    target: Some(target),
                    output_type: scap_vc::frame::FrameType::YUVFrame,
                    output_resolution: scap_vc::capturer::Resolution::Captured,
                    ..scap_vc::capturer::Options::default()
                };
                return scap_vc::capturer::Capturer::build(options)
                    .map(Self::CrossProcessWindow)
                    .map_err(AppError::internal);
            }

            let target = capture_target(source)
                .ok_or_else(|| AppError::NotFound("capture source was closed".into()))?;
            let options = Options {
                fps,
                show_cursor: false,
                show_highlight: false,
                target: Some(target),
                output_type: FrameType::YUVFrame,
                output_resolution: Resolution::Captured,
                captures_audio: false,
                exclude_current_process_audio: true,
                ..Options::default()
            };
            Capturer::build(options)
                .map(Self::Primary)
                .map_err(AppError::internal)
        }

        fn start(&mut self) -> AppResult<()> {
            match self {
                Self::Primary(capturer) => {
                    capturer.start_capture();
                    Ok(())
                }
                #[cfg(target_os = "macos")]
                Self::CrossProcessWindow(capturer) => {
                    capturer.start_capture().map_err(AppError::internal)
                }
            }
        }

        fn next_frame(&self) -> AppResult<CapturedNv12Frame> {
            loop {
                match self {
                    Self::Primary(capturer) => {
                        let frame = capturer.get_next_frame().map_err(AppError::internal)?;
                        if let Frame::Video(VideoFrame::YUVFrame(frame)) = frame {
                            return Ok(CapturedNv12Frame::from(frame));
                        }
                    }
                    #[cfg(target_os = "macos")]
                    Self::CrossProcessWindow(capturer) => {
                        let frame = capturer.get_next_frame().map_err(AppError::internal)?;
                        if let scap_vc::frame::Frame::YUVFrame(frame) = frame {
                            return Ok(CapturedNv12Frame {
                                width: frame.width,
                                height: frame.height,
                                luminance_bytes: frame.luminance_bytes,
                                luminance_stride: frame.luminance_stride,
                                chrominance_bytes: frame.chrominance_bytes,
                                chrominance_stride: frame.chrominance_stride,
                            });
                        }
                    }
                }
            }
        }

        fn stop(&mut self) {
            match self {
                Self::Primary(capturer) => capturer.stop_capture(),
                #[cfg(target_os = "macos")]
                Self::CrossProcessWindow(capturer) => {
                    let _ = capturer.stop_capture();
                }
            }
        }
    }

    impl From<YUVFrame> for CapturedNv12Frame {
        fn from(frame: YUVFrame) -> Self {
            Self {
                width: frame.width,
                height: frame.height,
                luminance_bytes: frame.luminance_bytes,
                luminance_stride: frame.luminance_stride,
                chrominance_bytes: frame.chrominance_bytes,
                chrominance_stride: frame.chrominance_stride,
            }
        }
    }

    pub struct InputController {
        enigo: Enigo,
        held_keys: HashSet<String>,
        held_buttons: HashSet<String>,
    }

    impl InputController {
        pub fn new() -> AppResult<Self> {
            let enigo = Enigo::new(&Settings {
                open_prompt_to_get_permissions: false,
                ..Settings::default()
            })
            .map_err(|error| {
                AppError::BadRequest(format!("input permission unavailable: {error}"))
            })?;
            Ok(Self {
                enigo,
                held_keys: HashSet::new(),
                held_buttons: HashSet::new(),
            })
        }

        pub fn apply(&mut self, source: &NativeSource, event: ControlEvent) -> AppResult<()> {
            match event {
                ControlEvent::Pointer { x, y } => self.move_to(source, x, y)?,
                ControlEvent::Button {
                    button,
                    pressed,
                    x,
                    y,
                } => {
                    if pressed {
                        focus_source(source)?;
                    }
                    if let (Some(x), Some(y)) = (x, y) {
                        self.move_to(source, x, y)?;
                    }
                    let native = mouse_button(&button)?;
                    self.enigo
                        .button(
                            native,
                            if pressed {
                                Direction::Press
                            } else {
                                Direction::Release
                            },
                        )
                        .map_err(AppError::internal)?;
                    if pressed {
                        self.held_buttons.insert(button);
                    } else {
                        self.held_buttons.remove(&button);
                    }
                }
                ControlEvent::Wheel { delta_x, delta_y } => {
                    let horizontal = wheel_steps(delta_x);
                    let vertical = wheel_steps(delta_y);
                    if horizontal != 0 {
                        self.enigo
                            .scroll(horizontal, Axis::Horizontal)
                            .map_err(AppError::internal)?;
                    }
                    if vertical != 0 {
                        self.enigo
                            .scroll(vertical, Axis::Vertical)
                            .map_err(AppError::internal)?;
                    }
                }
                ControlEvent::Keyboard { code, key, pressed } => {
                    if pressed {
                        focus_source(source)?;
                    }
                    let native = keyboard_key(&code, &key)?;
                    self.enigo
                        .key(
                            native,
                            if pressed {
                                Direction::Press
                            } else {
                                Direction::Release
                            },
                        )
                        .map_err(AppError::internal)?;
                    if pressed {
                        self.held_keys.insert(code);
                    } else {
                        self.held_keys.remove(&code);
                    }
                }
                ControlEvent::Text { text } => {
                    focus_source(source)?;
                    self.enigo.text(&text).map_err(AppError::internal)?;
                }
                _ => {}
            }
            Ok(())
        }

        fn move_to(&mut self, source: &NativeSource, x: f64, y: f64) -> AppResult<()> {
            let x = source.x + (x.clamp(0.0, 1.0) * source.public.width as f64) as i32;
            let y = source.y + (y.clamp(0.0, 1.0) * source.public.height as f64) as i32;
            self.enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(AppError::internal)
        }

        pub fn release_all(&mut self) {
            for code in self.held_keys.drain().collect::<Vec<_>>() {
                if let Ok(key) = keyboard_key(&code, "") {
                    let _ = self.enigo.key(key, Direction::Release);
                }
            }
            for button in self.held_buttons.drain().collect::<Vec<_>>() {
                if let Ok(button) = mouse_button(&button) {
                    let _ = self.enigo.button(button, Direction::Release);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[allow(unexpected_cfgs)]
    fn focus_source(source: &NativeSource) -> AppResult<()> {
        if source.public.kind != "window" {
            return Ok(());
        }
        let pid = source
            .pid
            .ok_or_else(|| AppError::NotFound("window process is no longer available".into()))?;
        unsafe {
            use cocoa::base::{BOOL, YES, id, nil};
            use objc::{class, msg_send, sel, sel_impl};

            let application: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid as i32];
            if application == nil {
                return Err(AppError::NotFound(
                    "window process is no longer available".into(),
                ));
            }
            const ACTIVATE_IGNORING_OTHER_APPS: usize = 1 << 1;
            let activated: BOOL =
                msg_send![application, activateWithOptions: ACTIVATE_IGNORING_OTHER_APPS];
            if activated != YES {
                return Err(AppError::BadRequest(
                    "the selected window could not be focused".into(),
                ));
            }
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn focus_source(source: &NativeSource) -> AppResult<()> {
        if source.public.kind != "window" {
            return Ok(());
        }
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow},
        };
        let window = HWND(source.native_id as usize as *mut std::ffi::c_void);
        unsafe {
            if !IsWindow(window).as_bool() {
                return Err(AppError::NotFound("capture source was closed".into()));
            }
            if !SetForegroundWindow(window).as_bool() {
                return Err(AppError::BadRequest(
                    "Windows rejected foreground activation for this application".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn capabilities() -> RemoteViewerCapabilities {
        let capture_available = scap::is_supported();
        let capture_permission = if !capture_available {
            "unavailable"
        } else if scap::has_permission() {
            "granted"
        } else {
            "prompt"
        };
        let control_permission = if InputController::new().is_ok() {
            "granted"
        } else {
            "prompt"
        };
        RemoteViewerCapabilities {
            platform: if cfg!(target_os = "macos") {
                "macos"
            } else {
                "windows"
            },
            capture_available,
            control_available: true,
            capture_permission,
            control_permission,
            codecs: vec!["h264", "vp8"],
        }
    }

    pub fn list_sources() -> AppResult<Vec<NativeSource>> {
        let mut result = Vec::new();
        for window in xcap::Window::all().map_err(AppError::internal)? {
            let title = window.title().unwrap_or_default();
            let app_name = window.app_name().unwrap_or_default();
            let width = window.width().unwrap_or(0);
            let height = window.height().unwrap_or(0);
            if width < 2
                || height < 2
                || (title.is_empty() && app_name.is_empty())
                || is_system_ui_window(&app_name, &title)
            {
                continue;
            }
            let scale = window
                .current_monitor()
                .and_then(|monitor| monitor.scale_factor())
                .unwrap_or(1.0);
            result.push(NativeSource {
                public: CaptureSource {
                    id: String::new(),
                    kind: "window".into(),
                    name: if title.is_empty() {
                        app_name.clone()
                    } else {
                        title
                    },
                    app_name: Some(app_name).filter(|name| !name.is_empty()),
                    width,
                    height,
                    scale,
                },
                native_id: window.id().map_err(AppError::internal)?,
                pid: window.pid().ok(),
                x: window.x().unwrap_or(0),
                y: window.y().unwrap_or(0),
            });
        }
        for monitor in xcap::Monitor::all().map_err(AppError::internal)? {
            let name = monitor.name().unwrap_or_else(|_| "Display".into());
            result.push(NativeSource {
                public: CaptureSource {
                    id: String::new(),
                    kind: "display".into(),
                    name,
                    app_name: None,
                    width: monitor.width().unwrap_or(0),
                    height: monitor.height().unwrap_or(0),
                    scale: monitor.scale_factor().unwrap_or(1.0),
                },
                native_id: monitor.id().map_err(AppError::internal)?,
                pid: None,
                x: monitor.x().unwrap_or(0),
                y: monitor.y().unwrap_or(0),
            });
        }
        Ok(result)
    }

    pub(super) fn is_system_ui_window(app_name: &str, title: &str) -> bool {
        fn normalized(value: &str) -> String {
            value
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect()
        }

        let app = normalized(app_name);
        let title = normalized(title);
        #[cfg(target_os = "macos")]
        let blocked = [
            "controlcenter",
            "notificationcenter",
            "systemuiserver",
            "windowmanager",
            "dock",
            "spotlight",
            "wallpaper",
            "loginwindow",
            "textinputmenuagent",
        ];
        #[cfg(target_os = "windows")]
        let blocked = [
            "shellexperiencehost",
            "startmenuexperiencehost",
            "searchhost",
            "textinputhost",
            "windowsinputexperience",
            "programmanager",
        ];
        blocked.contains(&app.as_str()) || blocked.contains(&title.as_str())
    }

    pub fn refresh_source(previous: &NativeSource) -> AppResult<NativeSource> {
        list_sources()?
            .into_iter()
            .find(|source| {
                source.native_id == previous.native_id
                    && source.public.kind == previous.public.kind
                    && (previous.pid.is_none() || source.pid == previous.pid)
            })
            .ok_or_else(|| AppError::NotFound("capture source was closed".into()))
    }

    pub fn thumbnail(source: &NativeSource) -> AppResult<(Vec<u8>, &'static str)> {
        let image = if source.public.kind == "window" {
            let window = xcap::Window::all()
                .map_err(AppError::internal)?
                .into_iter()
                .find(|window| window.id().ok() == Some(source.native_id))
                .ok_or_else(|| AppError::NotFound("capture source was closed".into()))?;
            window.capture_image().map_err(AppError::internal)?
        } else {
            let monitor = xcap::Monitor::all()
                .map_err(AppError::internal)?
                .into_iter()
                .find(|monitor| monitor.id().ok() == Some(source.native_id))
                .ok_or_else(|| AppError::NotFound("capture source was removed".into()))?;
            monitor.capture_image().map_err(AppError::internal)?
        };
        let thumbnail = image::DynamicImage::ImageRgba8(image).thumbnail(360, 220);
        let mut bytes = Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut bytes, ImageFormat::Png)
            .map_err(AppError::internal)?;
        Ok((bytes.into_inner(), "image/png"))
    }

    pub fn capture_loop(pipeline: Arc<CapturePipeline>) {
        if !scap::has_permission() && !scap::request_permission() {
            send_pipeline_error(
                &pipeline,
                "permission-denied",
                "Screen Recording permission is required",
            );
            pipeline.active.store(false, Ordering::SeqCst);
            return;
        }
        let Ok(mut capturer) = VideoCapturer::build(&pipeline.source, pipeline.key.fps) else {
            send_pipeline_error(
                &pipeline,
                "capture-failed",
                "Unable to start capture for this source",
            );
            pipeline.active.store(false, Ordering::SeqCst);
            return;
        };
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(
                pipeline.key.bitrate_kbps.saturating_mul(1000),
            ))
            .max_frame_rate(FrameRate::from_hz(pipeline.key.fps as f32))
            .rate_control_mode(RateControlMode::Bitrate)
            .usage_type(UsageType::ScreenContentRealTime)
            .profile(Profile::Baseline)
            .skip_frames(true);
        let mut h264 = match pipeline.key.codec.as_str() {
            "h264" => match Encoder::with_api_config(OpenH264API::from_source(), config) {
                Ok(encoder) => Some(encoder),
                Err(_) => {
                    send_pipeline_error(
                        &pipeline,
                        "encoder-unavailable",
                        "The H.264 encoder could not be initialized",
                    );
                    pipeline.active.store(false, Ordering::SeqCst);
                    return;
                }
            },
            _ => None,
        };
        if capturer.start().is_err() {
            send_pipeline_error(
                &pipeline,
                "capture-failed",
                "Unable to start capture for this source",
            );
            pipeline.active.store(false, Ordering::SeqCst);
            return;
        }
        let mut sequence = 0_u64;
        let mut frames_since_key = pipeline.key.fps.saturating_mul(2);
        let mut bytes_sent = 0_u64;
        let mut stats_at = Instant::now();
        let mut config_sent = false;

        while pipeline.active.load(Ordering::SeqCst) && !pipeline.subscribers().is_empty() {
            let Ok(frame) = capturer.next_frame() else {
                send_pipeline_error(
                    &pipeline,
                    "source-closed",
                    "The selected source stopped producing frames",
                );
                break;
            };
            let (target_width, target_height) = (pipeline.key.width, pipeline.key.height);
            let yuv = scale_nv12_to_i420(&frame, target_width, target_height);
            if !config_sent {
                let codec = if h264.is_some() { "avc1.42E01F" } else { "vp8" };
                publish_video_config(
                    &pipeline,
                    json!({
                        "codec":codec,
                        "codedWidth":target_width,
                        "codedHeight":target_height,
                        "optimizeForLatency":true,
                        "avc": if h264.is_some() { Some(json!({"format":"annexb"})) } else { None }
                    }),
                );
                config_sent = true;
            }
            let force = pipeline.force_keyframe.swap(false, Ordering::SeqCst)
                || frames_since_key >= pipeline.key.fps.saturating_mul(2);
            let (payload, key) = if let Some(encoder) = h264.as_mut() {
                if force {
                    encoder.force_intra_frame();
                }
                let Ok(encoded) = encoder.encode(&yuv) else {
                    continue;
                };
                let key = matches!(encoded.frame_type(), H264FrameType::IDR | H264FrameType::I);
                let mut bytes = Vec::new();
                encoded.write_vec(&mut bytes);
                (bytes, key)
            } else {
                let rgb = i420_to_rgba(&yuv, target_width, target_height);
                let webp = webp::Encoder::from_rgba(&rgb, target_width, target_height).encode(72.0);
                let Some(vp8) = extract_vp8(&webp) else {
                    continue;
                };
                (vp8.to_vec(), true)
            };
            if payload.is_empty() {
                continue;
            }
            if key {
                frames_since_key = 0;
            } else {
                frames_since_key = frames_since_key.saturating_add(1);
            }
            sequence = sequence.wrapping_add(1);
            let pts = media_timestamp_us();
            bytes_sent = bytes_sent.saturating_add(payload.len() as u64);
            pipeline_send(
                &pipeline,
                MediaMessage::Binary(media_envelope(1, key, sequence, pts, &payload)),
            );
            if stats_at.elapsed() >= Duration::from_secs(1) {
                let elapsed = stats_at.elapsed().as_secs_f64();
                pipeline_send(
                    &pipeline,
                    MediaMessage::Text(
                        json!({
                            "type":"stats",
                            "videoSequence":sequence,
                            "bitrateKbps":(bytes_sent as f64 * 8.0 / 1000.0 / elapsed).round(),
                            "queueCapacity":MEDIA_QUEUE_CAPACITY
                        })
                        .to_string(),
                    ),
                );
                stats_at = Instant::now();
                bytes_sent = 0;
            }
        }
        capturer.stop();
        pipeline.active.store(false, Ordering::SeqCst);
    }

    pub fn ensure_audio_hub(hub: AudioHub) {
        if hub.running.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::Builder::new()
            .name("remote-viewer-system-audio".into())
            .spawn(move || {
                let target = Target::Display(scap::get_main_display());
                let options = Options {
                    fps: 1,
                    show_cursor: false,
                    target: Some(target),
                    output_type: FrameType::YUVFrame,
                    output_resolution: Resolution::_480p,
                    captures_audio: true,
                    exclude_current_process_audio: true,
                    ..Options::default()
                };
                let Ok(mut capturer) = Capturer::build(options) else {
                    for session in live_audio_subscribers(&hub) {
                        let _ = session.media.send(MediaMessage::Text(
                            json!({"type":"status","state":"audio-unavailable"}).to_string(),
                        ));
                    }
                    hub.running.store(false, Ordering::SeqCst);
                    return;
                };
                let Ok(mut encoder) = OpusEncoder::new(48_000, 2, Application::RestrictedLowDelay)
                else {
                    hub.running.store(false, Ordering::SeqCst);
                    return;
                };
                encoder.bitrate_bps = 128_000;
                capturer.start_capture();
                let mut pcm = Vec::<f32>::new();
                let mut sequence = 0_u64;
                while !live_audio_subscribers(&hub).is_empty() {
                    let Ok(Frame::Audio(frame)) = capturer.get_next_frame() else {
                        continue;
                    };
                    pcm.extend(convert_audio(&frame));
                    while pcm.len() >= 1_920 {
                        let block = pcm.drain(..1_920).collect::<Vec<_>>();
                        let mut encoded = vec![0_u8; MAX_PACKET_BYTES];
                        let Ok(size) = encoder.encode(&block, 960, &mut encoded) else {
                            continue;
                        };
                        encoded.truncate(size);
                        sequence = sequence.wrapping_add(1);
                        let packet =
                            media_envelope(2, true, sequence, media_timestamp_us(), &encoded);
                        for session in live_audio_subscribers(&hub) {
                            let _ = session.media.send(MediaMessage::Binary(packet.clone()));
                        }
                    }
                }
                capturer.stop_capture();
                hub.running.store(false, Ordering::SeqCst);
                if !live_audio_subscribers(&hub).is_empty() {
                    ensure_audio_hub(hub);
                }
            })
            .ok();
    }

    fn live_audio_subscribers(hub: &AudioHub) -> Vec<Arc<SessionState>> {
        let mut subscribers = hub
            .subscribers
            .lock()
            .expect("viewer audio subscribers lock");
        let live = subscribers
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        subscribers.retain(|_, session| session.strong_count() > 0);
        live
    }

    fn capture_target(source: &NativeSource) -> Option<Target> {
        scap::get_all_targets()
            .into_iter()
            .find(|target| match target {
                Target::Window(window) => {
                    source.public.kind == "window" && window.id == source.native_id
                }
                Target::Display(display) => {
                    source.public.kind == "display" && display.id == source.native_id
                }
            })
    }

    fn scale_nv12_to_i420(frame: &CapturedNv12Frame, width: u32, height: u32) -> YUVBuffer {
        let src_width = frame.width.max(2) as usize;
        let src_height = frame.height.max(2) as usize;
        let width = width.max(2) as usize;
        let height = height.max(2) as usize;
        let mut output = vec![0_u8; width * height * 3 / 2];
        let (y_plane, uv_planes) = output.split_at_mut(width * height);
        let (u_plane, v_plane) = uv_planes.split_at_mut(width * height / 4);
        let y_stride = frame.luminance_stride.max(frame.width) as usize;
        let uv_stride = frame.chrominance_stride.max(frame.width) as usize;
        for y in 0..height {
            let src_y = y * src_height / height;
            for x in 0..width {
                let src_x = x * src_width / width;
                y_plane[y * width + x] = frame
                    .luminance_bytes
                    .get(src_y * y_stride + src_x)
                    .copied()
                    .unwrap_or(16);
            }
        }
        for y in 0..height / 2 {
            let src_y = y * (src_height / 2) / (height / 2);
            for x in 0..width / 2 {
                let src_x = x * (src_width / 2) / (width / 2);
                let offset = src_y * uv_stride + src_x * 2;
                u_plane[y * (width / 2) + x] =
                    frame.chrominance_bytes.get(offset).copied().unwrap_or(128);
                v_plane[y * (width / 2) + x] = frame
                    .chrominance_bytes
                    .get(offset + 1)
                    .copied()
                    .unwrap_or(128);
            }
        }
        YUVBuffer::from_vec(output, width, height)
    }

    fn i420_to_rgba(yuv: &YUVBuffer, width: u32, height: u32) -> Vec<u8> {
        use openh264::formats::YUVSource;
        let width = width as usize;
        let height = height as usize;
        let mut rgba = vec![255_u8; width * height * 4];
        for row in 0..height {
            for col in 0..width {
                let y = yuv.y()[row * width + col] as f32;
                let u = yuv.u()[(row / 2) * (width / 2) + col / 2] as f32 - 128.0;
                let v = yuv.v()[(row / 2) * (width / 2) + col / 2] as f32 - 128.0;
                let base = (row * width + col) * 4;
                rgba[base] = (y + 1.402 * v).clamp(0.0, 255.0) as u8;
                rgba[base + 1] = (y - 0.344_136 * u - 0.714_136 * v).clamp(0.0, 255.0) as u8;
                rgba[base + 2] = (y + 1.772 * u).clamp(0.0, 255.0) as u8;
            }
        }
        rgba
    }

    fn extract_vp8(webp: &[u8]) -> Option<&[u8]> {
        if webp.len() < 20 || &webp[..4] != b"RIFF" || &webp[8..12] != b"WEBP" {
            return None;
        }
        let mut offset = 12;
        while offset + 8 <= webp.len() {
            let name = &webp[offset..offset + 4];
            let size = u32::from_le_bytes(webp[offset + 4..offset + 8].try_into().ok()?) as usize;
            let start = offset + 8;
            let end = start.checked_add(size)?;
            if end > webp.len() {
                return None;
            }
            if name == b"VP8 " {
                return Some(&webp[start..end]);
            }
            offset = end + (size & 1);
        }
        None
    }

    fn convert_audio(frame: &scap::frame::AudioFrame) -> Vec<f32> {
        let channels = frame.channels().max(1) as usize;
        let count = frame.sample_count();
        let mut stereo = Vec::with_capacity(count * 2);
        for sample in 0..count {
            let left = audio_sample(frame, sample, 0);
            let right = if channels > 1 {
                audio_sample(frame, sample, 1)
            } else {
                left
            };
            stereo.extend_from_slice(&[left, right]);
        }
        if frame.rate() == 48_000 || stereo.is_empty() {
            return stereo;
        }
        let output_frames = count.saturating_mul(48_000) / frame.rate().max(1) as usize;
        let mut resampled = Vec::with_capacity(output_frames * 2);
        for index in 0..output_frames {
            let position = index as f64 * frame.rate() as f64 / 48_000.0;
            let lower = position.floor() as usize;
            let upper = (lower + 1).min(count.saturating_sub(1));
            let mix = (position - lower as f64) as f32;
            for channel in 0..2 {
                let a = stereo[lower.min(count.saturating_sub(1)) * 2 + channel];
                let b = stereo[upper * 2 + channel];
                resampled.push(a + (b - a) * mix);
            }
        }
        resampled
    }

    fn audio_sample(frame: &scap::frame::AudioFrame, sample: usize, channel: usize) -> f32 {
        let bytes = if frame.is_planar() {
            frame.plane_data(channel.min(frame.channels().saturating_sub(1) as usize))
        } else {
            frame.raw_data()
        };
        let channels = if frame.is_planar() {
            1
        } else {
            frame.channels() as usize
        };
        let index = sample * channels + if frame.is_planar() { 0 } else { channel };
        let size = frame.format().sample_size();
        let offset = index.saturating_mul(size);
        let slice = bytes.get(offset..offset + size).unwrap_or(&[]);
        match frame.format() {
            AudioFormat::F32 if slice.len() == 4 => {
                f32::from_ne_bytes(slice.try_into().unwrap()).clamp(-1.0, 1.0)
            }
            AudioFormat::F64 if slice.len() == 8 => {
                f64::from_ne_bytes(slice.try_into().unwrap()).clamp(-1.0, 1.0) as f32
            }
            AudioFormat::I16 if slice.len() == 2 => {
                i16::from_ne_bytes(slice.try_into().unwrap()) as f32 / i16::MAX as f32
            }
            AudioFormat::I32 if slice.len() == 4 => {
                i32::from_ne_bytes(slice.try_into().unwrap()) as f32 / i32::MAX as f32
            }
            AudioFormat::U8 if slice.len() == 1 => (slice[0] as f32 - 128.0) / 128.0,
            _ => 0.0,
        }
    }

    fn mouse_button(button: &str) -> AppResult<Button> {
        match button {
            "left" | "0" => Ok(Button::Left),
            "middle" | "1" => Ok(Button::Middle),
            "right" | "2" => Ok(Button::Right),
            "back" | "3" => Ok(Button::Back),
            "forward" | "4" => Ok(Button::Forward),
            _ => Err(AppError::BadRequest("unsupported pointer button".into())),
        }
    }

    fn keyboard_key(code: &str, key: &str) -> AppResult<Key> {
        let special = match code {
            "AltLeft" | "AltRight" => Some(Key::Alt),
            "Backspace" => Some(Key::Backspace),
            "CapsLock" => Some(Key::CapsLock),
            "ControlLeft" | "ControlRight" => Some(Key::Control),
            "Delete" => Some(Key::Delete),
            "ArrowDown" => Some(Key::DownArrow),
            "End" => Some(Key::End),
            "Enter" | "NumpadEnter" => Some(Key::Return),
            "Escape" => Some(Key::Escape),
            "Home" => Some(Key::Home),
            "ArrowLeft" => Some(Key::LeftArrow),
            "MetaLeft" | "MetaRight" => Some(Key::Meta),
            "PageDown" => Some(Key::PageDown),
            "PageUp" => Some(Key::PageUp),
            "ArrowRight" => Some(Key::RightArrow),
            "ShiftLeft" | "ShiftRight" => Some(Key::Shift),
            "Space" => Some(Key::Space),
            "Tab" => Some(Key::Tab),
            "ArrowUp" => Some(Key::UpArrow),
            "F1" => Some(Key::F1),
            "F2" => Some(Key::F2),
            "F3" => Some(Key::F3),
            "F4" => Some(Key::F4),
            "F5" => Some(Key::F5),
            "F6" => Some(Key::F6),
            "F7" => Some(Key::F7),
            "F8" => Some(Key::F8),
            "F9" => Some(Key::F9),
            "F10" => Some(Key::F10),
            "F11" => Some(Key::F11),
            "F12" => Some(Key::F12),
            _ => None,
        };
        special
            .or_else(|| {
                key.chars()
                    .next()
                    .filter(|_| key.chars().count() == 1)
                    .map(Key::Unicode)
            })
            .ok_or_else(|| AppError::BadRequest(format!("unsupported keyboard code: {code}")))
    }

    fn wheel_steps(delta: f64) -> i32 {
        if delta.abs() < 0.5 {
            0
        } else {
            (delta / 100.0).round().clamp(-20.0, 20.0) as i32
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;

    pub struct InputController;

    impl InputController {
        pub fn new() -> AppResult<Self> {
            Err(AppError::BadRequest(
                "remote control is unavailable on this platform".into(),
            ))
        }
        pub fn apply(&mut self, _source: &NativeSource, _event: ControlEvent) -> AppResult<()> {
            Err(AppError::BadRequest(
                "remote control is unavailable on this platform".into(),
            ))
        }
        pub fn release_all(&mut self) {}
    }

    pub fn capabilities() -> RemoteViewerCapabilities {
        RemoteViewerCapabilities {
            platform: "unsupported",
            capture_available: false,
            control_available: false,
            capture_permission: "unavailable",
            control_permission: "unavailable",
            codecs: Vec::new(),
        }
    }
    pub fn list_sources() -> AppResult<Vec<NativeSource>> {
        Ok(Vec::new())
    }
    pub fn refresh_source(_source: &NativeSource) -> AppResult<NativeSource> {
        Err(AppError::NotFound("capture source not found".into()))
    }
    pub fn thumbnail(_source: &NativeSource) -> AppResult<(Vec<u8>, &'static str)> {
        Err(AppError::NotFound("capture source not found".into()))
    }
    pub fn capture_loop(pipeline: Arc<CapturePipeline>) {
        pipeline_send(
            &pipeline,
            MediaMessage::Text(
                json!({"type":"status","state":"error","code":"unsupported-platform"}).to_string(),
            ),
        );
        pipeline.active.store(false, Ordering::SeqCst);
    }
    pub fn ensure_audio_hub(hub: AudioHub) {
        hub.running.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_presets_rotate_the_bounding_box() {
        assert_eq!(
            fit_resolution(1170, 2532, &RemoteViewerResolution::P1080),
            (886, 1920)
        );
        assert_eq!(
            fit_resolution(2532, 1170, &RemoteViewerResolution::P1080),
            (1920, 886)
        );
    }

    #[test]
    fn settings_reject_defaults_above_caps() {
        let settings = RemoteViewerSettings {
            default_fps: 61,
            max_fps: 60,
            ..RemoteViewerSettings::default()
        };
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn media_header_is_versioned_and_big_endian() {
        let packet = media_envelope(1, true, 9, 44, &[1, 2]);
        assert_eq!(&packet[..4], b"BRV1");
        assert_eq!(packet[4], 1);
        assert_eq!(packet[5], 1);
        assert_eq!(u64::from_be_bytes(packet[8..16].try_into().unwrap()), 9);
        assert_eq!(u64::from_be_bytes(packet[16..24].try_into().unwrap()), 44);
    }

    #[test]
    fn matching_sessions_reuse_capture_pipeline() {
        let source = NativeSource {
            public: CaptureSource {
                id: "source-1".into(),
                kind: "window".into(),
                name: "Simulator".into(),
                app_name: Some("Simulator".into()),
                width: 1280,
                height: 720,
                scale: 2.0,
            },
            native_id: 42,
            pid: Some(7),
            x: 0,
            y: 0,
        };
        let description = ViewerSession {
            id: "session-1".into(),
            source: source.public.clone(),
            effective_codec: "h264".into(),
            effective_fps: 30,
            width: 1280,
            height: 720,
            audio_enabled: true,
        };
        let key = pipeline_key(&description, 8_000);
        let pipelines = Mutex::new(HashMap::new());
        let (first, first_created) = acquire_pipeline(&pipelines, key.clone(), source.clone());
        let (second, second_created) = acquire_pipeline(&pipelines, key, source);
        assert!(first_created);
        assert!(!second_created);
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(pipelines.lock().unwrap().len(), 1);
    }

    #[test]
    fn automatic_codec_policy_uses_client_fallback() {
        assert_eq!(
            select_codec(&RemoteViewerCodec::Auto, &["vp8".into()]).unwrap(),
            "vp8"
        );
        assert!(select_codec(&RemoteViewerCodec::H264, &["vp8".into()]).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_system_surfaces_are_not_selectable() {
        assert!(platform::is_system_ui_window("Control Center", "Item-0"));
        assert!(platform::is_system_ui_window(
            "NotificationCenter",
            "Notification Center"
        ));
        assert!(!platform::is_system_ui_window("Simulator", "iPhone 17 Pro"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_system_surfaces_are_not_selectable() {
        assert!(platform::is_system_ui_window("ShellExperienceHost", ""));
        assert!(!platform::is_system_ui_window("Android Emulator", "Pixel"));
    }
}
