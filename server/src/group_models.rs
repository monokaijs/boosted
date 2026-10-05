//! Serialized group API contracts. Persisted records use these same field names.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupMemberRole {
    pub role: GroupRole,
    pub roles: Vec<GroupRole>,
    #[serde(default)]
    pub responsibilities: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GroupRole {
    Coordinator,
    Developer,
    Reviewer,
    Researcher,
    Designer,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupSummary {
    pub id: String,
    pub name: String,
    pub member_ids: Vec<String>,
    pub member_roles: std::collections::HashMap<String, GroupMemberRole>,
    pub project_id: Option<String>,
    pub working_directory: Option<String>,
    pub stopped: bool,
    pub stop_reason: Option<String>,
    pub version: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub last_message_at: Option<String>,
    pub created_by: String,
    pub initial_git_state: Value,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupState {
    #[serde(flatten)]
    pub summary: GroupSummary,
    pub members: Vec<Value>,
    pub message_count: usize,
    pub messages: Vec<GroupMessage>,
    pub deliveries: Vec<GroupDelivery>,
    pub tasks: Vec<GroupTask>,
    pub reviews: Vec<GroupReview>,
    pub executions: Vec<Value>,
    pub receipts: Vec<Value>,
    pub requests: Vec<Value>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupMessage {
    pub id: String,
    pub group_id: String,
    pub root_id: String,
    pub sequence: i64,
    pub sender_type: String,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    pub recipient_ids: Vec<String>,
    pub kind: String,
    pub created_at: String,
    pub task_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub attachments: Option<Vec<Value>>,
    pub time_zone: Option<String>,
    #[serde(default)]
    pub attention: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupDelivery {
    pub id: String,
    pub group_id: String,
    pub root_id: String,
    pub agent_id: String,
    pub message_id: Option<String>,
    pub task_id: Option<String>,
    pub purpose: String,
    pub task_revision: Option<i64>,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub recovery: bool,
    pub event: Option<Value>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupTask {
    pub id: String,
    pub group_id: String,
    pub root_id: String,
    pub title: String,
    pub instructions: String,
    pub expected_result: String,
    pub owner_id: Option<String>,
    pub reviewer_id: Option<String>,
    pub dependency_ids: Vec<String>,
    pub working_directory: Option<String>,
    pub file_responsibilities: Vec<String>,
    pub status: String,
    pub revision: i64,
    pub result: Option<String>,
    pub verification: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub fingerprints: Value,
    #[serde(default)]
    pub recovery: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupReview {
    pub id: String,
    pub group_id: String,
    pub task_id: String,
    pub reviewer_id: String,
    pub revision: i64,
    pub decision: String,
    pub evidence: String,
    pub fingerprints: Value,
    pub created_at: String,
}
