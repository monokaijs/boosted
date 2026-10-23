//! Claude Code transport adapted to the subset of the Codex app-server protocol
//! used by Boosted. Keeping the normalization here lets the rest of the app use
//! one chat/event pipeline for both providers.
use crate::{
    error::{AppError, AppResult},
    process::background_command,
};
use chrono::Utc;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc};
use tokio::{
    fs,
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, broadcast},
    time::{Duration, sleep, timeout},
};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct ClaudeClient {
    home: PathBuf,
    program: PathBuf,
    api_key: Option<String>,
    notifications: broadcast::Sender<Value>,
    active: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
}

impl ClaudeClient {
    pub(crate) async fn new(home: PathBuf, api_key: Option<String>) -> AppResult<Self> {
        let program = resolve_claude_command().ok_or_else(|| {
            AppError::Internal(
                "Claude Code CLI was not found. Install it before connecting a Claude account."
                    .into(),
            )
        })?;
        Self::with_program(home, api_key, program).await
    }

    async fn with_program(
        home: PathBuf,
        api_key: Option<String>,
        program: PathBuf,
    ) -> AppResult<Self> {
        fs::create_dir_all(&home).await?;
        let (notifications, _) = broadcast::channel(2048);
        Ok(Self {
            home,
            program,
            api_key,
            notifications,
            active: Default::default(),
        })
    }

    fn command(&self) -> Command {
        let mut command = background_command(&self.program);
        command
            .env("CLAUDE_CONFIG_DIR", &self.home)
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("ANTHROPIC_AUTH_TOKEN")
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN");
        if let Some(key) = &self.api_key {
            command.env("ANTHROPIC_API_KEY", key);
        }
        command
    }

    fn thread_dir(&self) -> PathBuf {
        self.home.join("boosted-threads")
    }

    fn thread_path(&self, id: &str) -> PathBuf {
        self.thread_dir().join(format!("{id}.json"))
    }

    async fn read_thread(&self, id: &str) -> AppResult<Value> {
        let data = fs::read_to_string(self.thread_path(id))
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    AppError::NotFound("Claude conversation not found".into())
                }
                _ => AppError::from(error),
            })?;
        Ok(serde_json::from_str(&data)?)
    }

    async fn write_thread(&self, thread: &Value) -> AppResult<()> {
        fs::create_dir_all(self.thread_dir()).await?;
        let id = thread["id"]
            .as_str()
            .ok_or_else(|| AppError::Internal("Claude thread has no id".into()))?;
        fs::write(self.thread_path(id), serde_json::to_vec(thread)?).await?;
        Ok(())
    }

    pub(crate) async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        match method {
            "account/read" => self.account_read().await,
            "account/rateLimits/read" | "account/usage/read" => Err(AppError::Internal(
                "Claude Code does not expose account quota through its CLI".into(),
            )),
            "model/list" => Ok(claude_models()),
            "thread/start" => self.thread_start(params).await,
            "thread/read" => {
                let mut thread = self.read_thread(required(&params, "threadId")?).await?;
                if params["includeTurns"] != true {
                    thread["turns"] = json!([]);
                }
                Ok(json!({"thread":thread,"model":thread["model"]}))
            }
            "thread/items/list" => {
                let thread = self.read_thread(required(&params, "threadId")?).await?;
                claude_item_page(&thread, &params)
            }
            "thread/resume" => {
                let id = required(&params, "threadId")?;
                let mut thread = if let Some(path) = params["path"].as_str() {
                    serde_json::from_slice::<Value>(&fs::read(path).await?)?
                } else {
                    self.read_thread(id).await?
                };
                thread["path"] = json!(self.thread_path(id));
                self.write_thread(&thread).await?;
                Ok(json!({"thread":thread,"model":thread["model"]}))
            }
            "thread/list" | "thread/loaded/list" => self.thread_list(&params).await,
            "thread/name/set" => self.thread_name(params).await,
            "thread/archive" => self.thread_archive(params).await,
            "thread/delete" => self.thread_delete(params).await,
            "thread/fork" => self.thread_fork(params).await,
            "turn/start" => self.turn_start(params).await,
            "turn/interrupt" => self.turn_interrupt(&params).await,
            "thread/backgroundTerminals/clean"
            | "config/mcpServer/reload"
            | "config/value/write" => Ok(json!({})),
            "thread/goal/get" => Ok(json!({"goal":null})),
            "turn/steer" => Err(AppError::Conflict(
                "Claude does not support steering a turn that is already running".into(),
            )),
            _ => Err(AppError::BadRequest(format!(
                "Claude provider does not support {method}"
            ))),
        }
    }

    async fn account_read(&self) -> AppResult<Value> {
        if self.api_key.is_some() {
            return Ok(json!({"account":{"type":"apiKey","provider":"anthropic"}}));
        }
        let mut command = self.command();
        command.args(["auth", "status", "--json"]);
        let output = timeout(Duration::from_secs(10), command.output())
            .await
            .map_err(|_| AppError::Internal("Claude authentication check timed out".into()))??;
        if !output.status.success() {
            return Ok(json!({"account":null}));
        }
        let status: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        let connected = status.is_null()
            || status["loggedIn"].as_bool().unwrap_or(false)
            || status["authenticated"].as_bool().unwrap_or(false)
            || status["status"].as_str() == Some("logged_in");
        Ok(if connected {
            json!({"account":{"type":"oauth","email":status["email"],"planType":status["subscriptionType"]}})
        } else {
            json!({"account":null})
        })
    }

    async fn thread_start(&self, params: Value) -> AppResult<Value> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();
        let path = self.thread_path(&id);
        let thread = json!({
            "id":id,
            "path":path,
            "cwd":params["cwd"].as_str().unwrap_or_default(),
            "model":params["model"].as_str().unwrap_or("sonnet"),
            "preview":"",
            "name":"",
            "source":"appServer",
            "createdAt":now,
            "updatedAt":now,
            "recencyAt":now,
            "status":{"type":"idle"},
            "turns":[]
        });
        self.write_thread(&thread).await?;
        Ok(json!({"thread":thread,"model":thread["model"]}))
    }

    async fn thread_list(&self, params: &Value) -> AppResult<Value> {
        let mut threads = Vec::new();
        if let Ok(mut entries) = fs::read_dir(self.thread_dir()).await {
            while let Some(entry) = entries.next_entry().await? {
                if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                let Ok(data) = fs::read_to_string(entry.path()).await else {
                    continue;
                };
                let Ok(thread) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                if thread["archived"].as_bool().unwrap_or(false) {
                    continue;
                }
                if params["cwd"].as_str().is_some_and(|cwd| !cwd.is_empty())
                    && thread["cwd"].as_str() != params["cwd"].as_str()
                {
                    continue;
                }
                threads.push(thread);
            }
        }
        threads.sort_by_key(|thread| std::cmp::Reverse(thread["recencyAt"].as_i64().unwrap_or(0)));
        Ok(json!({"data":threads,"nextCursor":null}))
    }

    async fn thread_name(&self, params: Value) -> AppResult<Value> {
        let mut thread = self.read_thread(required(&params, "threadId")?).await?;
        thread["name"] = params["name"].clone();
        self.write_thread(&thread).await?;
        Ok(json!({"thread":thread}))
    }

    async fn thread_archive(&self, params: Value) -> AppResult<Value> {
        let mut thread = self.read_thread(required(&params, "threadId")?).await?;
        thread["archived"] = json!(true);
        self.write_thread(&thread).await?;
        Ok(json!({}))
    }

    async fn thread_delete(&self, params: Value) -> AppResult<Value> {
        let path = self.thread_path(required(&params, "threadId")?);
        if fs::remove_file(path).await.is_err() {
            return Err(AppError::NotFound("Claude conversation not found".into()));
        }
        Ok(json!({}))
    }

    async fn thread_fork(&self, params: Value) -> AppResult<Value> {
        let mut thread = self.read_thread(required(&params, "threadId")?).await?;
        let id = Uuid::new_v4().to_string();
        thread["id"] = json!(id);
        thread["path"] = json!(self.thread_path(&id));
        if params["excludeTurns"].as_bool().unwrap_or(false) {
            thread["turns"] = json!([]);
        }
        self.write_thread(&thread).await?;
        Ok(json!({"thread":thread}))
    }

    async fn turn_start(&self, params: Value) -> AppResult<Value> {
        let thread_id = required(&params, "threadId")?.to_string();
        if self.active.lock().await.contains_key(&thread_id) {
            return Err(AppError::Conflict(
                "This Claude conversation already has a running turn".into(),
            ));
        }
        let turn_id = Uuid::new_v4().to_string();
        let prompt = claude_prompt(&params);
        let mut thread = self.read_thread(&thread_id).await?;
        let now = Utc::now().timestamp_millis();
        let user_item = json!({
            "id":params["clientUserMessageId"].as_str().unwrap_or(&turn_id),
            "type":"userMessage",
            "content":params["input"],
        });
        if thread["preview"].as_str().is_none_or(str::is_empty) {
            thread["preview"] = json!(prompt.chars().take(220).collect::<String>());
        }
        thread["model"] = params["model"].clone();
        thread["status"] = json!({"type":"active"});
        thread["updatedAt"] = json!(now);
        thread["recencyAt"] = json!(now);
        thread["turns"].as_array_mut().unwrap().push(json!({
            "id":turn_id,"status":"inProgress","startedAt":now,"items":[user_item]
        }));
        self.write_thread(&thread).await?;

        let mut command = self.command();
        command
            .current_dir(thread["cwd"].as_str().unwrap_or("."))
            .args(["-p", &prompt, "--output-format", "stream-json", "--verbose"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(model) = params["model"].as_str().filter(|value| !value.is_empty()) {
            command.args(["--model", model]);
        }
        if let Some(effort) = params["effort"].as_str().filter(|value| !value.is_empty()) {
            let effort = match effort {
                "none" | "minimal" => "low",
                "extraHigh" | "extra-high" | "extra_high" => "xhigh",
                effort => effort,
            };
            command.env("CLAUDE_CODE_EFFORT_LEVEL", effort);
        }
        if let Some(session) = thread["providerSessionId"].as_str() {
            command.args(["--resume", session]);
        }
        let access = params
            .pointer("/sandboxPolicy/type")
            .and_then(Value::as_str);
        let plan = params
            .pointer("/collaborationMode/mode")
            .and_then(Value::as_str)
            == Some("plan");
        match (plan, access) {
            (true, _) | (_, Some("readOnly")) => {
                command.args(["--permission-mode", "plan"]);
            }
            (_, Some("dangerFullAccess")) => {
                command.arg("--dangerously-skip-permissions");
            }
            _ => {
                command.args(["--permission-mode", "acceptEdits"]);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|error| AppError::Internal(format!("unable to start Claude Code: {error}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Internal("Claude stdout unavailable".into()))?;
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        self.active
            .lock()
            .await
            .insert(thread_id.clone(), child.clone());

        let client = self.clone();
        let response_turn_id = turn_id.clone();
        tokio::spawn(async move {
            client
                .forward_turn(thread_id, turn_id, stdout, stderr, child)
                .await;
        });
        Ok(json!({"turn":{"id":response_turn_id,"status":"inProgress"}}))
    }

    async fn forward_turn(
        &self,
        thread_id: String,
        turn_id: String,
        stdout: tokio::process::ChildStdout,
        stderr: Option<tokio::process::ChildStderr>,
        child: Arc<Mutex<Child>>,
    ) {
        let errors = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let errors = errors.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut output = errors.lock().await;
                    if output.len() < 16_000 {
                        output.push_str(&line);
                        output.push('\n');
                    }
                }
            });
        }
        let mut lines = BufReader::new(stdout).lines();
        let mut failed = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(session) = message["session_id"].as_str() {
                let _ = self.update_session(&thread_id, session).await;
            }
            if message["type"] == "assistant" {
                self.record_assistant(&thread_id, &turn_id, &message).await;
            } else if message["type"] == "result"
                && (message["is_error"].as_bool().unwrap_or(false)
                    || message["subtype"]
                        .as_str()
                        .is_some_and(|kind| kind != "success"))
            {
                failed = true;
            }
        }
        let status = loop {
            let status = child.lock().await.try_wait();
            match status {
                Ok(Some(status)) => break status,
                Ok(None) => sleep(Duration::from_millis(50)).await,
                Err(_) => {
                    failed = true;
                    break failure_status();
                }
            }
        };
        failed |= !status.success();
        let error = errors.lock().await.trim().to_string();
        self.active.lock().await.remove(&thread_id);
        let _ = self
            .complete_turn(&thread_id, &turn_id, failed, &error)
            .await;
        if failed {
            let _ = self.notifications.send(json!({"method":"error","params":{
                "threadId":thread_id,"turnId":turn_id,
                "message":if error.is_empty() { "Claude Code turn failed" } else { &error }
            }}));
        }
        let _ = self.notifications.send(json!({"method":"turn/completed","params":{
            "threadId":thread_id,"turn":{"id":turn_id,"status":if failed {"failed"} else {"completed"},
            "error":if failed { json!(if error.is_empty() {"Claude Code turn failed"} else {&error}) } else { Value::Null }}
        }}));
    }

    async fn update_session(&self, thread_id: &str, session: &str) -> AppResult<()> {
        let mut thread = self.read_thread(thread_id).await?;
        thread["providerSessionId"] = json!(session);
        self.write_thread(&thread).await
    }

    async fn record_assistant(&self, thread_id: &str, turn_id: &str, message: &Value) {
        let Some(content) = message
            .pointer("/message/content")
            .and_then(Value::as_array)
        else {
            return;
        };
        for block in content {
            let item = match block["type"].as_str() {
                Some("text") => {
                    json!({"id":Uuid::new_v4().to_string(),"type":"agentMessage","text":block["text"],"phase":"final_answer"})
                }
                Some("tool_use") => {
                    json!({"id":block["id"],"type":"dynamicToolCall","tool":block["name"],"arguments":block["input"],"status":"completed"})
                }
                _ => continue,
            };
            if let Ok(mut thread) = self.read_thread(thread_id).await {
                if let Some(turn) = thread["turns"]
                    .as_array_mut()
                    .and_then(|turns| turns.iter_mut().find(|turn| turn["id"] == turn_id))
                {
                    turn["items"].as_array_mut().unwrap().push(item.clone());
                    let _ = self.write_thread(&thread).await;
                }
            }
            let _ = self.notifications.send(json!({"method":"item/started","params":{"threadId":thread_id,"turnId":turn_id,"item":item}}));
            if item["type"] == "agentMessage" {
                let _ = self.notifications.send(json!({"method":"item/agentMessage/delta","params":{"threadId":thread_id,"turnId":turn_id,"itemId":item["id"],"delta":item["text"],"phase":"final_answer"}}));
            }
            let _ = self.notifications.send(json!({"method":"item/completed","params":{"threadId":thread_id,"turnId":turn_id,"item":item}}));
        }
    }

    async fn complete_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        failed: bool,
        error: &str,
    ) -> AppResult<()> {
        let mut thread = self.read_thread(thread_id).await?;
        if let Some(turn) = thread["turns"]
            .as_array_mut()
            .and_then(|turns| turns.iter_mut().find(|turn| turn["id"] == turn_id))
        {
            turn["status"] = json!(if failed { "failed" } else { "completed" });
            turn["completedAt"] = json!(Utc::now().timestamp_millis());
            if failed && !error.is_empty() {
                turn["error"] = json!({"message":error});
            }
        }
        thread["status"] = json!({"type":"idle"});
        thread["updatedAt"] = json!(Utc::now().timestamp_millis());
        thread["recencyAt"] = thread["updatedAt"].clone();
        self.write_thread(&thread).await
    }

    async fn turn_interrupt(&self, params: &Value) -> AppResult<Value> {
        let id = required(params, "threadId")?;
        let child = self.active.lock().await.get(id).cloned().ok_or_else(|| {
            AppError::Conflict("This Claude conversation has no running turn".into())
        })?;
        child.lock().await.start_kill()?;
        Ok(json!({}))
    }

    pub(crate) async fn notify(&self, _method: &str, _params: Value) -> AppResult<()> {
        Ok(())
    }

    pub(crate) async fn respond(&self, _id: Value, _result: Value) -> AppResult<()> {
        Err(AppError::BadRequest(
            "Claude permission responses are not available through this transport".into(),
        ))
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.notifications.subscribe()
    }

    pub(crate) async fn shutdown(&self) {
        let children = self
            .active
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for child in children {
            let _ = child.lock().await.start_kill();
        }
    }
}

fn required<'a>(params: &'a Value, key: &str) -> AppResult<&'a str> {
    params[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required")))
}

fn claude_prompt(params: &Value) -> String {
    params["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| match item["type"].as_str() {
            Some("text") => item["text"].as_str().map(str::to_string),
            Some("localImage") => item["path"]
                .as_str()
                .map(|path| format!("Please inspect this image: {path}")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn claude_models() -> Value {
    json!({"data":[
        {"id":"sonnet","model":"sonnet","displayName":"Claude Sonnet","description":"Balanced speed and capability","isDefault":true,"inputModalities":["text","image"],"defaultReasoningEffort":"medium","supportedReasoningEfforts":[]},
        {"id":"opus","model":"opus","displayName":"Claude Opus","description":"Most capable Claude model","inputModalities":["text","image"],"defaultReasoningEffort":"high","supportedReasoningEfforts":[]},
        {"id":"haiku","model":"haiku","displayName":"Claude Haiku","description":"Fastest Claude model","inputModalities":["text","image"],"defaultReasoningEffort":"low","supportedReasoningEfforts":[]}
    ]})
}

fn resolve_claude_command() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .chain(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                .into_iter()
                .map(PathBuf::from),
        )
        .map(|directory| {
            directory.join(if cfg!(windows) {
                "claude.exe"
            } else {
                "claude"
            })
        })
        .find(|path| path.is_file())
}

pub(crate) async fn start_web_login(home: &std::path::Path) -> AppResult<()> {
    fs::create_dir_all(home).await?;
    let program = resolve_claude_command().ok_or_else(|| {
        AppError::Internal(
            "Claude Code CLI was not found. Install it before connecting a Claude account.".into(),
        )
    })?;
    let mut command = background_command(program);
    command
        .env("CLAUDE_CONFIG_DIR", home)
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .args(["auth", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| {
        AppError::Internal(format!("unable to start Claude web sign-in: {error}"))
    })?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

#[cfg(unix)]
fn failure_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(1 << 8)
}

#[cfg(windows)]
fn failure_status() -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_keeps_text_and_local_images() {
        let prompt = claude_prompt(&json!({"input":[
            {"type":"text","text":"Fix it"},
            {"type":"localImage","path":"/tmp/bug.png"}
        ]}));
        assert_eq!(prompt, "Fix it\n\nPlease inspect this image: /tmp/bug.png");
    }

    #[test]
    fn model_catalog_has_stable_cli_aliases() {
        let models = claude_models();
        assert_eq!(models["data"][0]["model"], "sonnet");
        assert!(
            models["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model["model"] == "opus")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streams_a_cli_turn_and_persists_normalized_history() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("fake-claude");
        std::fs::write(
            &program,
            r##"#!/bin/sh
printf '%s' "$ANTHROPIC_API_KEY" > "$CLAUDE_CONFIG_DIR/key-seen"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
printf '%s\n' '{"type":"assistant","session_id":"claude-session","message":{"content":[{"type":"text","text":"Claude reply"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"claude-session"}'
"##,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let home = root.path().join("home");
        let client = ClaudeClient::with_program(home.clone(), Some("sk-ant-test".into()), program)
            .await
            .unwrap();
        let started = client
            .request("thread/start", json!({"cwd":root.path(),"model":"sonnet"}))
            .await
            .unwrap();
        let thread_id = started["thread"]["id"].as_str().unwrap();
        let mut events = client.subscribe();
        client
            .request(
                "turn/start",
                json!({"threadId":thread_id,"clientUserMessageId":"message","model":"sonnet","input":[{"type":"text","text":"Hello"}],"sandboxPolicy":{"type":"readOnly"}}),
            )
            .await
            .unwrap();
        loop {
            let event = timeout(Duration::from_secs(3), events.recv())
                .await
                .unwrap()
                .unwrap();
            if event["method"] == "turn/completed" {
                break;
            }
        }
        let thread = client
            .request(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
            )
            .await
            .unwrap();
        assert_eq!(thread["thread"]["providerSessionId"], "claude-session");
        assert_eq!(
            thread["thread"]["turns"][0]["items"][1]["text"],
            "Claude reply"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("key-seen")).unwrap(),
            "sk-ant-test"
        );
    }
}

// Claude stores one JSON document per thread. Read it on the server, then walk
// backwards without cloning/rendering the full history or sending it to clients.
fn claude_item_page(thread: &Value, params: &Value) -> AppResult<Value> {
    let before = params["cursor"].as_str();
    let limit = params["limit"].as_u64().unwrap_or(50).clamp(1, 50) as usize;
    let mut found = before.is_none();
    let mut entries = Vec::new();
    for turn in thread["turns"].as_array().into_iter().flatten().rev() {
        for item in turn["items"].as_array().into_iter().flatten().rev() {
            if !found {
                if item["id"].as_str() == before {
                    found = true;
                }
                continue;
            }
            entries.push(json!({"item":item,"turnId":turn["id"],"startedAtMs":turn["startedAt"].as_i64().map(|time| if time > 10_000_000_000 { time } else { time * 1000 })}));
            if entries.len() > limit {
                break;
            }
        }
        if entries.len() > limit {
            break;
        }
    }
    if !found {
        return Err(AppError::BadRequest("Unknown history cursor".into()));
    }
    let more = entries.len() > limit;
    entries.truncate(limit);
    let next = if more {
        entries.last().map(|e| e["item"]["id"].clone())
    } else {
        None
    };
    Ok(json!({"data":entries,"nextCursor":next}))
}

#[cfg(test)]
#[test]
fn ui_history_claude_cursors_remain_stable_when_new_items_arrive() {
    let mut thread = json!({"turns":[{"id":"turn","startedAt":1700000000,"items":(0..125).map(|i|json!({"id":format!("i{i}"),"type":"agentMessage","text":format!("Reply {i}")})).collect::<Vec<_>>()}]});
    let original = thread.clone();
    let tail = claude_item_page(&thread, &json!({"limit":50})).unwrap();
    assert_eq!(tail["data"].as_array().unwrap().len(), 50);
    assert_eq!(tail["data"][0]["item"]["id"], "i124");
    assert_eq!(tail["nextCursor"], "i75");
    assert_eq!(tail["data"][0]["startedAtMs"], 1700000000000_i64);
    thread["turns"][0]["startedAt"] = json!(1700000000000_i64);
    let millis = claude_item_page(&thread, &json!({"limit":50})).unwrap();
    assert_eq!(millis["data"][0]["startedAtMs"], 1700000000000_i64);
    thread["turns"][0]["startedAt"] = original["turns"][0]["startedAt"].clone();
    assert_eq!(thread, original);
    thread["turns"][0]["items"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"arrival"}));
    let older =
        claude_item_page(&thread, &json!({"cursor":tail["nextCursor"],"limit":50})).unwrap();
    assert_eq!(older["data"][0]["item"]["id"], "i74");
    assert_eq!(older["data"][49]["item"]["id"], "i25");
    assert!(claude_item_page(&thread, &json!({"cursor":"invalid"})).is_err());
}
