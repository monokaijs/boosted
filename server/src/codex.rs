use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::{Value, json};
#[cfg(target_os = "macos")]
use std::path::Path;
use std::{
    collections::HashMap,
    ffi::OsString,
    path::PathBuf,
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

#[derive(Clone, Debug)]
struct CodexCommand {
    program: PathBuf,
    path: Option<OsString>,
}

impl CodexCommand {
    #[cfg(not(target_os = "macos"))]
    fn inherited() -> Self {
        Self {
            program: PathBuf::from("codex"),
            path: None,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        command
    }
}

async fn resolve_codex_command() -> Option<CodexCommand> {
    #[cfg(target_os = "macos")]
    {
        let path = macos_command_path().await;
        executable_in_path(&path, "codex").map(|program| CodexCommand {
            program,
            path: Some(path),
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        Some(CodexCommand::inherited())
    }
}

#[cfg(target_os = "macos")]
async fn macos_command_path() -> OsString {
    let mut directories = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        append_path_directories(&mut directories, &path);
    }
    if let Some(path) = login_shell_path().await {
        append_path_directories(&mut directories, &path);
    }
    if let Some(home) = dirs_next::home_dir() {
        append_unique(&mut directories, home.join(".local/bin"));
        append_unique(&mut directories, home.join(".cargo/bin"));
    }
    for directory in ["/opt/homebrew/bin", "/usr/local/bin"] {
        append_unique(&mut directories, PathBuf::from(directory));
    }
    std::env::join_paths(directories).unwrap_or_else(|_| {
        OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    })
}

#[cfg(target_os = "macos")]
fn append_path_directories(directories: &mut Vec<PathBuf>, path: &OsString) {
    for directory in std::env::split_paths(path) {
        append_unique(directories, directory);
    }
}

#[cfg(target_os = "macos")]
fn append_unique(directories: &mut Vec<PathBuf>, directory: PathBuf) {
    if !directories.contains(&directory) {
        directories.push(directory);
    }
}

#[cfg(target_os = "macos")]
async fn login_shell_path() -> Option<OsString> {
    const START: &str = "__BOOSTED_PATH_START__";
    const END: &str = "__BOOSTED_PATH_END__";

    let shell = std::env::var_os("SHELL")
        .filter(|value| Path::new(value).is_absolute())
        .unwrap_or_else(|| OsString::from("/bin/zsh"));
    let mut command = Command::new(shell);
    command
        .args([
            "-ilc",
            "printf '__BOOSTED_PATH_START__%s__BOOSTED_PATH_END__' \"$PATH\"",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let start = stdout.rfind(START)? + START.len();
    let end = stdout[start..].find(END)? + start;
    Some(OsString::from(&stdout[start..end]))
}

#[cfg(target_os = "macos")]
fn executable_in_path(path: &OsString, name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    std::env::split_paths(path)
        .map(|directory| directory.join(name))
        .find(|candidate| {
            candidate
                .metadata()
                .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

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
    async fn spawn(codex: &CodexCommand) -> AppResult<Self> {
        let mut command = codex.command();
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
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
        let codex = resolve_codex_command().await;
        let version = if let Some(codex) = &codex {
            codex
                .command()
                .arg("--version")
                .output()
                .await
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            None
        };
        let available = version.is_some();
        let authenticated = if available {
            let mut command = codex.as_ref().expect("available Codex command").command();
            command
                .args(["login", "status"])
                .output()
                .await
                .map(|output| output.status.success())
                .unwrap_or(false)
        } else {
            false
        };
        let (client, error) = if let (true, Some(codex)) = (available, &codex) {
            match CodexClient::spawn(codex).await {
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn finds_an_executable_in_the_supplied_path() {
        let root = tempfile::tempdir().expect("temporary path");
        let bin = root.path().join("bin");
        fs::create_dir(&bin).expect("bin directory");
        let executable = bin.join("codex");
        fs::write(&executable, b"#!/bin/sh\n").expect("Codex fixture");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("executable permissions");

        let path = std::env::join_paths([root.path().join("missing"), bin]).expect("test PATH");
        assert_eq!(executable_in_path(&path, "codex"), Some(executable));
    }

    #[test]
    fn ignores_non_executable_files() {
        let root = tempfile::tempdir().expect("temporary path");
        let executable = root.path().join("codex");
        fs::write(&executable, b"not executable").expect("Codex fixture");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o644))
            .expect("non-executable permissions");

        let path = std::env::join_paths([root.path()]).expect("test PATH");
        assert_eq!(executable_in_path(&path, "codex"), None);
    }
}
