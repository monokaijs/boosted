use crate::error::{AppError, AppResult};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{RwLock, broadcast};
use uuid::Uuid;

const BUFFER_LIMIT: usize = 1_048_576;

pub struct TerminalSession {
    pub id: String,
    output: broadcast::Sender<Vec<u8>>,
    buffer: Arc<Mutex<VecDeque<u8>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
}

impl TerminalSession {
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output.subscribe()
    }
    pub fn snapshot(&self) -> Vec<u8> {
        self.buffer
            .lock()
            .map(|buffer| buffer.iter().copied().collect())
            .unwrap_or_default()
    }
    pub fn write(&self, bytes: &[u8]) -> AppResult<()> {
        self.writer
            .lock()
            .map_err(|_| AppError::Internal("terminal writer lock poisoned".into()))?
            .write_all(bytes)
            .map_err(AppError::from)
    }
    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.master
            .lock()
            .map_err(|_| AppError::Internal("terminal resize lock poisoned".into()))?
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(AppError::internal)
    }
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<RwLock<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub async fn create(&self, cwd: &Path) -> AppResult<Arc<TerminalSession>> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(AppError::internal)?;
        let shell = if cfg!(windows) {
            std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
        };
        let mut command = CommandBuilder::new(shell);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(AppError::internal)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(AppError::internal)?;
        let writer = pair.master.take_writer().map_err(AppError::internal)?;
        let (output, _) = broadcast::channel(512);
        let buffer = Arc::new(Mutex::new(VecDeque::with_capacity(BUFFER_LIMIT)));
        let session = Arc::new(TerminalSession {
            id: Uuid::new_v4().to_string(),
            output: output.clone(),
            buffer: buffer.clone(),
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
        });
        let session_id = session.id.clone();
        let sessions = self.sessions.clone();
        let runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            read_loop(reader, output, buffer);
            let _ = child.wait();
            runtime.spawn(async move {
                sessions.write().await.remove(&session_id);
            });
        });
        self.sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());
        Ok(session)
    }

    pub async fn get(&self, id: &str) -> AppResult<Arc<TerminalSession>> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("terminal session not found".into()))
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    output: broadcast::Sender<Vec<u8>>,
    buffer: Arc<Mutex<VecDeque<u8>>>,
) {
    let mut bytes = vec![0_u8; 8192];
    while let Ok(size) = reader.read(&mut bytes) {
        if size == 0 {
            break;
        }
        let chunk = bytes[..size].to_vec();
        if let Ok(mut ring) = buffer.lock() {
            ring.extend(chunk.iter().copied());
            while ring.len() > BUFFER_LIMIT {
                ring.pop_front();
            }
        }
        let _ = output.send(chunk);
    }
}
