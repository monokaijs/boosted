use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, RwLock, broadcast, oneshot},
    time::{Duration, timeout},
};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInfo {
    pub available: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct CodexClient {
    writer: Arc<Mutex<tokio::process::ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<AppResult<Value>>>>>,
    next_id: Arc<AtomicU64>,
    notifications: broadcast::Sender<Value>,
    _child: Arc<Mutex<Child>>,
}

impl CodexClient {
    async fn spawn() -> AppResult<Self> {
        let mut child = Command::new("codex")
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                AppError::Internal(format!("unable to start Codex app-server: {error}"))
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Internal("Codex stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("Codex stdout unavailable".into()))?;
        let stderr = child.stderr.take();
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<AppResult<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (notifications, _) = broadcast::channel(2048);
        let client = Self {
            writer: Arc::new(Mutex::new(stdin)),
            pending: pending.clone(),
            next_id: Arc::new(AtomicU64::new(1)),
            notifications: notifications.clone(),
            _child: Arc::new(Mutex::new(child)),
        };
        let writer = client.writer.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    tracing::warn!(%line, "invalid Codex protocol line");
                    continue;
                };
                if message.get("method").is_some() {
                    let _ = notifications.send(message.clone());
                    if message.get("method").and_then(Value::as_str)
                        != Some("item/tool/requestUserInput")
                    {
                        if let Some(id) = message.get("id") {
                            let response = json!({"id": id, "error": {"code": -32601, "message": "Boosted does not support this server request yet"}});
                            let mut guard = writer.lock().await;
                            let _ = guard.write_all(format!("{}\n", response).as_bytes()).await;
                            let _ = guard.flush().await;
                        }
                    }
                } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = pending.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(AppError::Internal(format!(
                                "Codex: {}",
                                error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("request failed")
                            )))
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                } else {
                    let _ = notifications.send(message);
                }
            }
            let mut waiting = pending.lock().await;
            for (_, sender) in waiting.drain() {
                let _ = sender.send(Err(AppError::Internal(
                    "Codex app-server disconnected".into(),
                )));
            }
        });
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "codex", %line);
                }
            });
        }
        client.request("initialize", json!({"clientInfo":{"name":"boosted","title":"Boosted","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    pub async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let payload = json!({ "method": method, "id": id, "params": params });
        let mut writer = self.writer.lock().await;
        writer
            .write_all(format!("{}\n", payload).as_bytes())
            .await?;
        writer.flush().await?;
        drop(writer);
        timeout(Duration::from_secs(45), receiver)
            .await
            .map_err(|_| AppError::Internal(format!("Codex {method} timed out")))?
            .map_err(|_| AppError::Internal("Codex response channel closed".into()))?
    }

    pub async fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(format!("{}\n", json!({"method":method,"params":params})).as_bytes())
            .await?;
        writer.flush().await?;
        Ok(())
    }

    pub async fn respond(&self, id: Value, result: Value) -> AppResult<()> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(format!("{}\n", json!({"id":id,"result":result})).as_bytes())
            .await?;
        writer.flush().await?;
        Ok(())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.notifications.subscribe()
    }
}

#[derive(Clone)]
pub struct CodexManager {
    client: Arc<RwLock<Option<CodexClient>>>,
    info: Arc<RwLock<CodexInfo>>,
}

impl CodexManager {
    pub async fn new() -> Self {
        let version = Command::new("codex")
            .arg("--version")
            .output()
            .await
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
        let available = version.is_some();
        let authenticated = available
            && Command::new("codex")
                .args(["login", "status"])
                .output()
                .await
                .map(|output| output.status.success())
                .unwrap_or(false);
        let (client, error) = if available {
            match CodexClient::spawn().await {
                Ok(client) => (Some(client), None),
                Err(error) => (None, Some(error.to_string())),
            }
        } else {
            (None, Some("Codex CLI was not found in PATH".into()))
        };
        Self {
            client: Arc::new(RwLock::new(client)),
            info: Arc::new(RwLock::new(CodexInfo {
                available,
                authenticated,
                version,
                error,
            })),
        }
    }

    pub async fn info(&self) -> CodexInfo {
        let mut info = self.info.read().await.clone();
        if let Some(client) = self.client.read().await.as_ref() {
            if let Ok(value) = client
                .request("account/read", json!({"refreshToken":false}))
                .await
            {
                info.authenticated = value
                    .get("account")
                    .is_some_and(|account| !account.is_null());
            }
        }
        info
    }

    pub async fn client(&self) -> AppResult<CodexClient> {
        if let Some(client) = self.client.read().await.clone() {
            return Ok(client);
        }
        let message = self
            .info
            .read()
            .await
            .error
            .clone()
            .unwrap_or_else(|| "Codex is unavailable".into());
        Err(AppError::Internal(message))
    }

    pub async fn start_device_login(&self) -> AppResult<Value> {
        self.client()
            .await?
            .request("account/login/start", json!({"type":"chatgptDeviceCode"}))
            .await
    }
}
