use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub role: String,
    pub must_change_password: bool,
    pub disabled: bool,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    pub current_password: String,
    pub next_password: String,
}

#[derive(Debug, Deserialize)]
pub struct UserPatch {
    pub disabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    pub web_port: u16,
    pub web_ui_enabled: bool,
    pub allowed_ips: Vec<String>,
    pub updated_at: Option<String>,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            web_port: 4782,
            web_ui_enabled: true,
            allowed_ips: Vec::new(),
            updated_at: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsUpdate {
    pub web_port: u16,
    pub web_ui_enabled: bool,
    #[serde(default)]
    pub allowed_ips: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub default_branch: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreate {
    pub name: String,
    pub repo_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderBrowseEntry {
    pub name: String,
    pub path: String,
    pub is_git_repository: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderBrowseResponse {
    pub path: String,
    pub parent: Option<String>,
    pub roots: Vec<String>,
    pub entries: Vec<FolderBrowseEntry>,
    pub is_git_repository: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChat {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub cwd: String,
    pub source: String,
    pub model: Option<String>,
    pub updated_at: String,
    pub is_pinned: bool,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub kind: String,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatThread {
    pub chat: CodexChat,
    pub messages: Vec<CodexChatMessage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatCreate {
    pub cwd: String,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMessageCreate {
    pub message: String,
    pub client_message_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub access_mode: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnStart {
    pub turn_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReasoningEffortOption {
    pub id: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelOption {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<CodexReasoningEffortOption>,
    pub input_modalities: Vec<String>,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccessOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOptions {
    pub models: Vec<CodexModelOption>,
    pub access_modes: Vec<CodexAccessOption>,
    pub default_model: String,
    pub default_access_mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPlan {
    pub revision: i64,
    pub explanation: Option<String>,
    pub markdown: Option<String>,
    pub steps: Vec<PlanStep>,
    pub approved_at: Option<String>,
    pub approved_by: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub branch_name: String,
    pub worktree_path: String,
    pub base_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub access_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub additions: i64,
    pub deletions: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<TaskPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub attachments: Vec<TaskAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TaskSource>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSource {
    pub provider: String,
    pub external_id: String,
    pub external_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreate {
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub base_branch: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub access_mode: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: String,
    pub project_id: String,
    pub provider: String,
    pub name: String,
    pub config: Value,
    pub enabled: bool,
    pub sync_interval_minutes: Option<i64>,
    pub last_synced_at: Option<String>,
    pub last_sync_status: Option<String>,
    pub last_sync_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCreate {
    pub provider: String,
    pub name: String,
    pub config: Value,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub sync_interval_minutes: Option<i64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationUpdate {
    pub name: String,
    pub config: Value,
    pub enabled: bool,
    pub sync_interval_minutes: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSyncResult {
    pub imported: i64,
    pub skipped: i64,
    pub failed: i64,
    pub message: String,
}
#[derive(Debug, Deserialize)]
pub struct MessageCreate {
    pub message: String,
}
#[derive(Debug, Deserialize)]
pub struct PlanApprove {
    pub revision: i64,
}
#[derive(Debug, Deserialize)]
pub struct StatusUpdate {
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub id: i64,
    pub task_id: String,
    pub kind: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEvent {
    pub sequence: u64,
    pub topic: String,
    pub data: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub language: String,
    pub revision: String,
    pub binary: bool,
}

#[derive(Debug, Deserialize)]
pub struct FileWrite {
    pub path: String,
    pub content: String,
    pub revision: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: i64,
    pub behind: i64,
    pub changes: Vec<GitChange>,
}

#[derive(Debug, Deserialize)]
pub struct GitPaths {
    pub paths: Vec<String>,
}
#[derive(Debug, Deserialize)]
pub struct GitCommitCreate {
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub subject: String,
    pub body: String,
    pub authored_at: String,
    pub refs: Vec<String>,
}
