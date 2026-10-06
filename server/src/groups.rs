//! Durable peer conversations. Application state mutations are serialized; turns never hold the gate.
use super::*;
use std::time::Duration;
use group_models::{GroupDelivery, GroupMessage, GroupReview, GroupState, GroupSummary, GroupTask};
use providers::{document, text};
use sha2::{Digest, Sha256};
use tokio::sync::{watch, Mutex};

#[derive(Clone, Default)]
pub(crate) struct GroupManager {
    pub(crate) gate: Arc<Mutex<()>>,
    active: Arc<Mutex<HashMap<String, (GroupContext, watch::Sender<bool>)>>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupContext {
    pub group_id: String,
    pub agent_id: String,
    pub root_id: String,
    pub delivery_id: String,
    pub task_id: Option<String>,
    pub execution_id: String,
    pub purpose: String,
}
tokio::task_local! { pub(crate) static CONTEXT: GroupContext; }
pub(crate) fn context() -> Option<GroupContext> {
    CONTEXT.try_with(Clone::clone).ok()
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn uuid() -> String {
    Uuid::new_v4().to_string()
}
fn id(v: &Value) -> &str {
    v["id"].as_str().unwrap_or_default()
}
fn string(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_owned()
}
fn ids(v: &Value, key: &str) -> AppResult<Vec<String>> {
    let items = v[key]
        .as_array()
        .ok_or_else(|| AppError::BadRequest(format!("{key} must be an array")))?;
    let result: Vec<String> = items
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| AppError::BadRequest(format!("Invalid {key}")))
        })
        .collect::<AppResult<_>>()?;
    if result.iter().collect::<HashSet<_>>().len() != result.len() {
        return Err(AppError::BadRequest(format!("Duplicate {key}")));
    }
    Ok(result)
}
fn terminal(task: &Value) -> bool {
    matches!(task["status"].as_str(), Some("completed" | "cancelled"))
}

fn has_role(member: &Value, role: &str) -> bool {
    member["roles"]
        .as_array()
        .map_or(member["role"] == role, |roles| {
            roles.iter().any(|value| value == role)
        })
}

fn normalized_member(member: &Value) -> AppResult<Value> {
    let roles: Vec<group_models::GroupRole> = if let Some(roles) = member.get("roles") {
        serde_json::from_value(roles.clone())
            .map_err(|_| AppError::BadRequest("Invalid group roles".into()))?
    } else {
        vec![serde_json::from_value(member["role"].clone())
            .map_err(|_| AppError::BadRequest("Invalid group role".into()))?]
    };
    if roles.is_empty() || roles.iter().collect::<HashSet<_>>().len() != roles.len() {
        return Err(AppError::BadRequest(
            "Choose at least one role without duplicates for every participant".into(),
        ));
    }
    let role = if roles.contains(&group_models::GroupRole::Coordinator) {
        group_models::GroupRole::Coordinator
    } else {
        roles[0].clone()
    };
    let responsibilities = match member.get("responsibilities") {
        Some(Value::String(value)) if value.chars().count() <= 4000 => value.clone(),
        None => String::new(),
        _ => {
            return Err(AppError::BadRequest(
                "Responsibilities must be text of at most 4000 characters".into(),
            ))
        }
    };
    Ok(serde_json::to_value(group_models::GroupMemberRole {
        role,
        roles,
        responsibilities,
    })?)
}

// Older groups and changed rosters get stable defaults, preserving surviving roles.
fn default_roles(roster: &[String], previous: &Value) -> Value {
    let mut roles = serde_json::Map::new();
    for (position, agent) in roster.iter().enumerate() {
        let role = previous.get(agent).cloned().unwrap_or_else(|| {
            json!({"role":match position {
                2 => "reviewer",
                3 => "researcher",
                4 => "designer",
                _ => "developer",
            },"responsibilities":""})
        });
        roles.insert(
            agent.clone(),
            normalized_member(&role).expect("Saved group roles are validated"),
        );
    }
    if !roles.values().any(|r| has_role(r, "coordinator")) {
        if let Some(first) = roster.first() {
            roles.get_mut(first).unwrap()["role"] = json!("coordinator");
            if previous.get(first).is_some() {
                roles.get_mut(first).unwrap()["roles"]
                    .as_array_mut()
                    .unwrap()
                    .insert(0, json!("coordinator"));
            } else {
                roles.get_mut(first).unwrap()["roles"] = json!(["coordinator"]);
            }
        }
    }
    Value::Object(roles)
}

fn validate_roles(roster: &[String], roles: &Value) -> AppResult<Value> {
    let map = roles
        .as_object()
        .ok_or_else(|| AppError::BadRequest("memberRoles must be an object".into()))?;
    if map.len() != roster.len() || map.keys().any(|agent| !roster.contains(agent)) {
        return Err(AppError::BadRequest(
            "Assign a role to every participant and only participants".into(),
        ));
    }
    let mut coordinators = 0;
    let mut normalized = serde_json::Map::new();
    for (agent, role) in map {
        let parsed = normalized_member(role)?;
        coordinators += usize::from(has_role(&parsed, "coordinator"));
        normalized.insert(agent.clone(), parsed);
    }
    if coordinators != 1 {
        return Err(AppError::BadRequest("Choose exactly one leader".into()));
    }
    Ok(Value::Object(normalized))
}

fn planning_agent(group: &Value, _root: &Value) -> String {
    let roster = group["memberIds"].as_array().unwrap();
    let coordinator = roster
        .iter()
        .filter_map(Value::as_str)
        .find(|agent| has_role(&group["memberRoles"][*agent], "coordinator"))
        .unwrap();
    coordinator.to_owned()
}

async fn group_leader(state: &AppState, group: &str) -> AppResult<String> {
    let mut meta = get(&state.db, "groups", group).await?;
    let roster = members(&state.db, group).await?;
    meta["memberRoles"] = default_roles(&roster, &meta["memberRoles"]);
    meta["memberIds"] = json!(roster);
    Ok(planning_agent(&meta, &Value::Null))
}

pub(crate) async fn migrate(db: &Database) -> AppResult<()> {
    for table in [
        "groups",
        "group_messages",
        "group_tasks",
        "group_reviews",
        "group_executions",
        "group_receipts",
        "group_operations",
        "group_requests",
    ] {
        sqlx::query(&format!("CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, data TEXT NOT NULL)")).execute(&db.pool).await?;
        sqlx::query(&format!(
            "CREATE INDEX IF NOT EXISTS {table}_group ON {table}(group_id)"
        ))
        .execute(&db.pool)
        .await?;
    }
    sqlx::query("CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL, agent_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(group_id,agent_id))").execute(&db.pool).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS group_deliveries (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)").execute(&db.pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS group_deliveries_pending ON group_deliveries(status,agent_id,created_at)").execute(&db.pool).await?;
    // Never automatically repeat execution after a restart.
    sqlx::query("UPDATE groups SET data=json_set(data,'$.stopped',json('true'),'$.stopReason','restart') WHERE group_id IN (SELECT group_id FROM group_deliveries WHERE status IN ('queued','processing') UNION SELECT group_id FROM group_tasks WHERE json_extract(data,'$.status') IN ('queued','running','interrupted','awaiting_review') UNION SELECT group_id FROM group_executions WHERE json_extract(data,'$.status') IN ('running','waiting'))").execute(&db.pool).await?;
    sqlx::query("UPDATE group_deliveries SET status='queued',data=json_set(data,'$.status','queued','$.recovery',json('true')) WHERE status='processing'").execute(&db.pool).await?;
    sqlx::query("UPDATE group_tasks SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status') IN ('running','waiting')").execute(&db.pool).await?;
    sqlx::query("UPDATE group_executions SET data=json_set(data,'$.status','interrupted','$.activity',NULL) WHERE json_extract(data,'$.status') IN ('running','waiting')").execute(&db.pool).await?;
    sqlx::query("UPDATE group_receipts SET data=json_set(data,'$.status','failed','$.result',?) WHERE json_extract(data,'$.status')='running'").bind(json!({"resultUnknown":true,"error":"Server restarted; inspect live state before retrying"}).to_string()).execute(&db.pool).await?;
    // Provider queues/failover also obey the group's durable stop flag.
    sqlx::query("UPDATE feature_documents SET content_json=json_set(content_json,'$.dispatchPaused',json('true')) WHERE namespace='provider-chats' AND json_extract(content_json,'$.groupId') IN (SELECT id FROM groups WHERE json_extract(data,'$.stopped')=1)").execute(&db.pool).await?;
    Ok(())
}
async fn get(db: &Database, table: &str, record: &str) -> AppResult<Value> {
    let data: Option<String> = sqlx::query_scalar(&format!("SELECT data FROM {table} WHERE id=?"))
        .bind(record)
        .fetch_optional(&db.pool)
        .await?;
    serde_json::from_str(&data.ok_or_else(|| AppError::NotFound("Group record not found".into()))?)
        .map_err(Into::into)
}
async fn all(db: &Database, table: &str, group: &str) -> AppResult<Vec<Value>> {
    let data: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT data FROM {table} WHERE group_id=? ORDER BY rowid"
    ))
    .bind(group)
    .fetch_all(&db.pool)
    .await?;
    data.iter()
        .map(|v| serde_json::from_str(v).map_err(Into::into))
        .collect()
}
async fn put(db: &Database, table: &str, group: &str, value: &Value) -> AppResult<()> {
    sqlx::query(&format!("INSERT INTO {table}(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data"))
        .bind(id(value)).bind(group).bind(value.to_string()).execute(&db.pool).await?;
    Ok(())
}
async fn members(db: &Database, group: &str) -> AppResult<Vec<String>> {
    Ok(
        sqlx::query_scalar("SELECT agent_id FROM group_members WHERE group_id=? ORDER BY position")
            .bind(group)
            .fetch_all(&db.pool)
            .await?,
    )
}
async fn touch(state: &AppState, group: &str, topic: &str) -> AppResult<()> {
    sqlx::query("UPDATE groups SET data=json_set(data,'$.updatedAt',?,'$.version',COALESCE(json_extract(data,'$.version'),0)+1) WHERE id=?").bind(now()).bind(group).execute(&state.db.pool).await?;
    state.emit(topic, json!({"groupId":group}));
    Ok(())
}
async fn checked_task(state: &AppState, group: &str, task: &str) -> AppResult<Value> {
    let value = get(&state.db, "group_tasks", task).await?;
    if value["groupId"] != group {
        return Err(AppError::NotFound(
            "Assignment not found in this group".into(),
        ));
    }
    Ok(value)
}
async fn validate_members(state: &AppState, list: &[String]) -> AppResult<()> {
    if list.len() < 2 {
        return Err(AppError::BadRequest("Choose at least two agents".into()));
    }
    for agent in list {
        state.agents.get(agent).await?;
    }
    Ok(())
}
pub(crate) async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<GroupSummary>>> {
    let data: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM groups ORDER BY json_extract(data,'$.updatedAt') DESC",
    )
    .fetch_all(&state.db.pool)
    .await?;
    let mut groups: Vec<Value> = data
        .iter()
        .map(|v| serde_json::from_str(v))
        .collect::<Result<_, _>>()?;
    for group in &mut groups {
        let last_message: Option<String> = sqlx::query_scalar(
            "SELECT json_extract(data,'$.createdAt') FROM group_messages WHERE group_id=? AND json_extract(data,'$.senderType')='agent' AND trim(COALESCE(json_extract(data,'$.content'),''))!='' ORDER BY CAST(json_extract(data,'$.sequence') AS INTEGER) DESC LIMIT 1",
        )
        .bind(id(group))
        .fetch_optional(&state.db.pool)
        .await?;
        group["lastMessageAt"] = json!(last_message);
        group["memberIds"] = json!(members(&state.db, id(group)).await?);
        let roster: Vec<String> = serde_json::from_value(group["memberIds"].clone())?;
        group["memberRoles"] = default_roles(&roster, &group["memberRoles"]);
    }
    Ok(Json(
        groups
            .into_iter()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()?,
    ))
}
// Assigning a group project changes defaults for future tasks only; saved task directories remain intact.
async fn apply_group_project(
    state: &AppState,
    meta: &mut Value,
    input: &Value,
) -> AppResult<Option<String>> {
    let Some(value) = input.get("projectId") else {
        return Ok(None);
    };
    if value.is_null() {
        meta["projectId"] = Value::Null;
        meta["workingDirectory"] = Value::Null;
        meta["initialGitState"] = Value::Null;
        return Ok(Some("Group project unassigned.".into()));
    }
    let project_id = value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| {
        AppError::BadRequest("projectId must be an existing project ID or null".into())
    })?;
    let project = state.db.project(project_id).await?;
    if meta["projectId"] != project.id {
        meta["initialGitState"] = git::status(Path::new(&project.repo_path))
            .await
            .map(|status| json!(status))
            .unwrap_or(Value::Null);
    }
    meta["projectId"] = json!(project.id);
    meta["workingDirectory"] = json!(project.repo_path);
    Ok(Some(format!("Group project: {}.", project.name)))
}
pub(crate) async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<Value>,
) -> AppResult<(StatusCode, Json<GroupState>)> {
    let name = text(&input, "name", 120)?;
    let roster = ids(&input, "memberIds")?;
    validate_members(&state, &roster).await?;
    let roles = input
        .get("memberRoles")
        .cloned()
        .unwrap_or_else(|| default_roles(&roster, &Value::Null));
    let roles = validate_roles(&roster, &roles)?;
    let project = match input["projectId"].as_str() {
        Some(p) => Some(state.db.project(p).await?),
        None => None,
    };
    let initial = if let Some(p) = &project {
        git::status(Path::new(&p.repo_path))
            .await
            .map(|v| json!(v))
            .unwrap_or(json!(null))
    } else {
        Value::Null
    };
    let group_id = uuid();
    let group = json!({"id":group_id,"name":name,"memberRoles":roles,"projectId":project.as_ref().map(|p|&p.id),"workingDirectory":project.as_ref().map(|p|&p.repo_path),"initialGitState":initial,"createdBy":user.id,"stopped":false,"stopReason":null,"createdAt":now(),"updatedAt":now(),"version":1});
    let _gate = state.groups.gate.lock().await;
    let mut tx = state.db.pool.begin().await?;
    sqlx::query("INSERT INTO groups(id,group_id,data) VALUES(?,?,?)")
        .bind(&group_id)
        .bind(&group_id)
        .bind(group.to_string())
        .execute(&mut *tx)
        .await?;
    for (position, agent) in roster.iter().enumerate() {
        sqlx::query("INSERT INTO group_members VALUES(?,?,?)")
            .bind(&group_id)
            .bind(agent)
            .bind(position as i64)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    state.emit("group.updated", json!({"groupId":group_id}));
    Ok((
        StatusCode::CREATED,
        Json(serde_json::from_value(snapshot(&state, &group_id).await?)?),
    ))
}
pub(crate) async fn snapshot(state: &AppState, group: &str) -> AppResult<Value> {
    let mut value = get(&state.db, "groups", group).await?;
    let roster = members(&state.db, group).await?;
    value["memberRoles"] = default_roles(&roster, &value["memberRoles"]);
    let mut profiles = Vec::new();
    for agent in &roster {
        let a = state.agents.get(agent).await?;
        profiles.push(json!({"id":agent,"profile":a["profile"],"accountId":a["accountId"]}));
    }
    value["memberIds"] = json!(roster);
    value["members"] = json!(profiles);
    let messages = all(&state.db, "group_messages", group).await?;
    value["messageCount"] = json!(messages.len());
    value["messages"] = json!(messages
        .into_iter()
        .rev()
        .take(120)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>());
    for (key, table) in [
        ("tasks", "group_tasks"),
        ("reviews", "group_reviews"),
        ("executions", "group_executions"),
        ("receipts", "group_receipts"),
        ("requests", "group_requests"),
    ] {
        value[key] = json!(all(&state.db, table, group).await?);
    }
    let deliveries: Vec<String>=sqlx::query_scalar("SELECT data FROM group_deliveries WHERE group_id=? AND status IN ('queued','processing') ORDER BY created_at").bind(group).fetch_all(&state.db.pool).await?;
    value["deliveries"] = json!(deliveries
        .iter()
        .map(|v| serde_json::from_str::<GroupDelivery>(v))
        .collect::<Result<Vec<_>, _>>()?);
    let _: Vec<GroupTask> = serde_json::from_value(value["tasks"].clone())?;
    let _: Vec<GroupReview> = serde_json::from_value(value["reviews"].clone())?;
    Ok(value)
}
pub(crate) async fn read(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
) -> AppResult<Json<GroupState>> {
    let _gate = state.groups.gate.lock().await;
    Ok(Json(serde_json::from_value(
        snapshot(&state, &group).await?,
    )?))
}

async fn persist_membership(
    state: &AppState,
    group: &str,
    meta: &Value,
    roster: &[String],
    announcement: Option<Value>,
    actor_execution: Option<&str>,
) -> AppResult<()> {
    validate_members(state, roster).await?;
    for task in all(&state.db, "group_tasks", group).await? {
        if !terminal(&task)
            && ["ownerId", "reviewerId"].iter().any(|field| {
                task[*field]
                    .as_str()
                    .is_some_and(|agent| !roster.iter().any(|id| id == agent))
            })
        {
            return Err(AppError::Conflict(
                "An agent owns unfinished work or a pending review".into(),
            ));
        }
    }
    if state.groups.active.lock().await.values().any(|(c, _)| {
        c.group_id == group
            && !roster.contains(&c.agent_id)
            && actor_execution != Some(c.execution_id.as_str())
    }) {
        return Err(AppError::Conflict(
            "Wait for the agent's current turn to finish before removing it".into(),
        ));
    }
    let old_leader = group_leader(state, group).await?;
    let mut view = meta.clone();
    view["memberIds"] = json!(roster);
    let new_leader = planning_agent(&view, &Value::Null);
    let queued: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM group_deliveries WHERE group_id=? AND status='queued'",
    )
    .bind(group)
    .fetch_all(&state.db.pool)
    .await?;
    let mut tx = state.db.pool.begin().await?;
    sqlx::query("UPDATE groups SET data=? WHERE id=?")
        .bind(meta.to_string())
        .bind(group)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM group_members WHERE group_id=?")
        .bind(group)
        .execute(&mut *tx)
        .await?;
    for (position, agent) in roster.iter().enumerate() {
        sqlx::query("INSERT INTO group_members VALUES(?,?,?)")
            .bind(group)
            .bind(agent)
            .bind(position as i64)
            .execute(&mut *tx)
            .await?;
    }
    for data in queued {
        let mut delivery: Value = serde_json::from_str(&data)?;
        let mut leader_message = None;
        if old_leader != new_leader && delivery["agentId"] == old_leader {
            if let Some(message) = delivery["messageId"].as_str() {
                let mut message = get(&state.db, "group_messages", message).await?;
                if message["toLeader"] == true {
                    message["recipientIds"] = json!([new_leader]);
                    leader_message = Some(message);
                }
            }
        }
        if old_leader != new_leader
            && delivery["agentId"] == old_leader
            && (delivery["event"]["type"] == "task_update" || leader_message.is_some())
        {
            delivery["agentId"] = json!(new_leader);
        } else if !roster.contains(&string(&delivery, "agentId")) {
            delivery["status"] = json!("cancelled");
        }
        sqlx::query("UPDATE group_deliveries SET agent_id=?,status=?,data=? WHERE id=?")
            .bind(string(&delivery, "agentId"))
            .bind(string(&delivery, "status"))
            .bind(delivery.to_string())
            .bind(id(&delivery))
            .execute(&mut *tx)
            .await?;
        if let Some(message) = leader_message {
            sqlx::query("UPDATE group_messages SET data=? WHERE id=?")
                .bind(message.to_string())
                .bind(id(&message))
                .execute(&mut *tx)
                .await?;
        }
    }
    if let Some(mut announcement) = announcement {
        let sequence:i64=sqlx::query_scalar("SELECT COALESCE(MAX(CAST(json_extract(data,'$.sequence') AS INTEGER)),0)+1 FROM group_messages WHERE group_id=?").bind(group).fetch_one(&mut *tx).await?;
        announcement["sequence"] = json!(sequence);
        sqlx::query("INSERT INTO group_messages VALUES(?,?,?)")
            .bind(id(&announcement))
            .bind(group)
            .bind(announcement.to_string())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    // Removed participants retain their private agent data and completed group history.
    Ok(())
}
pub(crate) async fn update(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    let mut current = get(&state.db, "groups", &group).await?;
    if current["stopped"] != true
        || state
            .groups
            .active
            .lock()
            .await
            .values()
            .any(|(c, _)| c.group_id == group)
    {
        return Err(AppError::Conflict(
            "Stop the group and wait for its turns to finish before editing it".into(),
        ));
    }
    if input.get("name").is_some() {
        current["name"] = json!(text(&input, "name", 120)?);
    }
    let roster = if input.get("memberIds").is_some() {
        ids(&input, "memberIds")?
    } else {
        members(&state.db, &group).await?
    };
    let roles = input
        .get("memberRoles")
        .cloned()
        .unwrap_or_else(|| default_roles(&roster, &current["memberRoles"]));
    current["memberRoles"] = validate_roles(&roster, &roles)?;
    apply_group_project(&state, &mut current, &input).await?;
    persist_membership(&state, &group, &current, &roster, None, None).await?;
    touch(&state, &group, "group.updated").await?;
    Ok(Json(snapshot(&state, &group).await?))
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageQuery {
    after: Option<i64>,
    before: Option<i64>,
}
pub(crate) async fn messages(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Query(q): Query<MessageQuery>,
) -> AppResult<Json<Vec<GroupMessage>>> {
    get(&state.db, "groups", &group).await?;
    let mut rows = all(&state.db, "group_messages", &group).await?;
    rows.retain(|v| {
        q.after
            .is_none_or(|n| v["sequence"].as_i64().unwrap_or(0) > n)
            && q.before
                .is_none_or(|n| v["sequence"].as_i64().unwrap_or(0) < n)
    });
    if q.before.is_some() {
        rows = rows
            .into_iter()
            .rev()
            .take(120)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
    } else {
        rows.truncate(120);
    }
    Ok(Json(
        rows.into_iter()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()?,
    ))
}
pub(crate) async fn send(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    get(&state.db, "groups", &group).await?;
    agents::validate_attachments(input.get("attachments"))?;
    let content = text(&input, "content", 32_000)?;
    let client = text(&input, "clientMessageId", 200)?;
    let roster = members(&state.db, &group).await?;
    let recipients = if input.get("recipientIds").is_some() {
        ids(&input, "recipientIds")?
    } else {
        Vec::new()
    };
    if recipients.iter().any(|a| !roster.contains(a)) {
        return Err(AppError::BadRequest(
            "Mention an agent in this group".into(),
        ));
    }
    let message_id = format!("{group}:{}:{client}", user.id);
    if let Ok(existing) = get(&state.db, "group_messages", &message_id).await {
        return Ok(Json(existing));
    }
    let target = if recipients.is_empty() {
        vec![group_leader(&state, &group).await?]
    } else {
        recipients
    };
    let message = json!({"id":message_id,"groupId":group,"rootId":message_id,"senderType":"user","senderId":user.id,"senderName":user.username,"content":content,"toLeader":input["recipientIds"].as_array().is_none_or(|ids|ids.is_empty()),"recipientIds":target,"kind":"message","createdAt":now(),"attachments":input["attachments"],"timeZone":input["timeZone"].as_str().unwrap_or("UTC")});
    let saved = append_message(&state, message, &target, "message", None).await?;
    let request = json!({"id":message_id,"groupId":group,"turnCount":0,"limited":false,"completed":false,"createdAt":now()});
    put(&state.db, "group_requests", &group, &request).await?;
    Ok(Json(saved))
}
async fn append_message(
    state: &AppState,
    mut message: Value,
    recipients: &[String],
    purpose: &str,
    task: Option<&str>,
) -> AppResult<Value> {
    let group = string(&message, "groupId");
    let mut tx = state.db.pool.begin().await?;
    let seq:i64=sqlx::query_scalar("SELECT COALESCE(MAX(CAST(json_extract(data,'$.sequence') AS INTEGER)),0)+1 FROM group_messages WHERE group_id=?").bind(&group).fetch_one(&mut *tx).await?;
    message["sequence"] = json!(seq);
    sqlx::query("INSERT INTO group_messages VALUES(?,?,?)")
        .bind(id(&message))
        .bind(&group)
        .bind(message.to_string())
        .execute(&mut *tx)
        .await?;
    for agent in recipients {
        let delivery = json!({"id":format!("{}:{agent}:{purpose}",id(&message)),"groupId":group,"agentId":agent,"rootId":message["rootId"],"messageId":message["id"],"taskId":task,"purpose":purpose,"status":"queued","createdAt":now(),"recovery":false});
        insert_delivery(&mut tx, &delivery).await?;
    }
    if message["senderType"] == "user" {
        let request = json!({"id":message["rootId"],"groupId":group,"turnCount":0,"limited":false,"completed":false,"createdAt":now()});
        sqlx::query("INSERT OR IGNORE INTO group_requests VALUES(?,?,?)")
            .bind(id(&request))
            .bind(&group)
            .bind(request.to_string())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    touch(state, &group, "group.message").await?;
    if message["attention"] == true {
        state.emit("group.attention", message.clone());
    }
    Ok(message)
}
async fn insert_delivery(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, v: &Value) -> AppResult<()> {
    sqlx::query("INSERT OR IGNORE INTO group_deliveries VALUES(?,?,?,?,?,?)")
        .bind(id(v))
        .bind(string(v, "groupId"))
        .bind(string(v, "agentId"))
        .bind(string(v, "status"))
        .bind(string(v, "createdAt"))
        .bind(v.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn enqueue(
    state: &AppState,
    group: &str,
    root: &str,
    agent: &str,
    purpose: &str,
    task: &Value,
) -> AppResult<()> {
    let delivery = json!({"id":format!("{}:{}:{purpose}:{}",id(task),task["revision"],agent),"groupId":group,"rootId":root,"agentId":agent,"taskId":task["id"],"purpose":purpose,"taskRevision":task["revision"],"status":"queued","createdAt":now(),"recovery":false});
    let mut tx = state.db.pool.begin().await?;
    insert_delivery(&mut tx, &delivery).await?;
    tx.commit().await?;
    Ok(())
}
pub(crate) async fn tasks(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
) -> AppResult<Json<Vec<Value>>> {
    get(&state.db, "groups", &group).await?;
    Ok(Json(all(&state.db, "group_tasks", &group).await?))
}
async fn ensure_assignment_directory(state: &AppState, task: &mut Value) -> AppResult<()> {
    if task["workingDirectory"].is_null() {
        if let Some(owner) = task["ownerId"].as_str() {
            let runtime = state
                .providers
                .home
                .parent()
                .unwrap_or(&state.providers.home)
                .join("assistant-runtime")
                .join(owner);
            tokio::fs::create_dir_all(&runtime).await?;
            task["workingDirectory"] = json!(runtime.to_string_lossy());
        }
    }
    Ok(())
}
async fn create_assignment(
    state: &AppState,
    group: &str,
    root: &str,
    input: &Value,
) -> AppResult<Value> {
    validate_task_input(state, group, input).await?;
    let meta = get(&state.db, "groups", group).await?;
    let title = text(input, "title", 200)?;
    let instructions = text(input, "instructions", 32_000)?;
    let expected = text(input, "expectedResult", 4000)?;
    for existing in all(&state.db, "group_tasks", group).await? {
        if existing["rootId"] == root
            && string(&existing, "title").to_lowercase() == title.to_lowercase()
        {
            return Ok(existing);
        }
    }
    let dependencies = if input.get("dependencyIds").is_some() {
        ids(input, "dependencyIds")?
    } else {
        vec![]
    };
    for dep in &dependencies {
        checked_task(state, group, dep).await?;
    }
    let task_id = uuid();
    let roster = members(&state.db, group).await?;
    let owner = input["ownerId"].as_str();
    if owner.is_some_and(|a| !roster.iter().any(|b| b == a)) {
        return Err(AppError::BadRequest("Owner must be a participant".into()));
    }
    let directory = input["workingDirectory"]
        .as_str()
        .or(meta["workingDirectory"].as_str())
        .map(str::to_owned);
    if let Some(path) = &directory {
        if !Path::new(path).is_absolute() || !Path::new(path).is_dir() {
            return Err(AppError::BadRequest(
                "Working directory must be an existing absolute directory".into(),
            ));
        }
    }
    let paths = if input.get("fileResponsibilities").is_some() {
        ids(input, "fileResponsibilities")?
    } else {
        vec![]
    };
    validate_paths(&paths)?;
    let mut task = json!({"id":task_id,"groupId":group,"rootId":root,"title":title,"instructions":instructions,"expectedResult":expected,"ownerId":owner,"reviewerId":null,"dependencyIds":dependencies,"workingDirectory":directory,"fileResponsibilities":paths,"status":"queued","revision":1,"result":null,"verification":null,"error":null,"createdAt":now(),"updatedAt":now(),"fingerprints":{}});
    ensure_assignment_directory(state, &mut task).await?;
    put(&state.db, "group_tasks", group, &task).await?;
    sqlx::query(
        "UPDATE group_requests SET data=json_set(data,'$.completed',json('false')) WHERE id=?",
    )
    .bind(root)
    .execute(&state.db.pool)
    .await?;
    if let Some(owner) = owner {
        enqueue(state, group, root, owner, "execute", &task).await?;
    }
    touch(state, group, "group.task").await?;
    Ok(task)
}
pub(crate) async fn create_task(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Extension(user): Extension<AuthUser>,
    Json(mut input): Json<Value>,
) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    validate_task_input(&state, &group, &input).await?;
    let root = if let Some(root) = input["rootId"].as_str() {
        let m = get(&state.db, "group_messages", root).await?;
        if m["groupId"] != group || m["senderType"] != "user" {
            return Err(AppError::BadRequest(
                "Select a human request in this group".into(),
            ));
        }
        root.to_owned()
    } else {
        let root = uuid();
        let target = vec![group_leader(&state, &group).await?];
        let message = json!({"id":root,"groupId":group,"rootId":root,"senderType":"user","senderId":user.id,"senderName":user.username,"content":input["instructions"],"kind":"message","recipientIds":target,"createdAt":now()});
        append_message(&state, message, &target, "message", None).await?;
        put(&state.db,"group_requests",&group,&json!({"id":root,"groupId":group,"turnCount":0,"limited":false,"completed":false,"createdAt":now()})).await?;
        root
    };
    input["rootId"] = json!(root);
    Ok(Json(
        create_assignment(&state, &group, &root, &input).await?,
    ))
}
fn validate_paths(paths: &[String]) -> AppResult<()> {
    if paths.iter().any(|p| {
        p.is_empty()
            || Path::new(p).is_absolute()
            || Path::new(p)
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
    }) {
        return Err(AppError::BadRequest(
            "File responsibilities must be relative paths inside the working directory".into(),
        ));
    }
    Ok(())
}
async fn fingerprints(task: &Value) -> AppResult<Value> {
    let mut hashes = serde_json::Map::new();
    if let Some(directory) = task["workingDirectory"].as_str() {
        let root = tokio::fs::canonicalize(directory).await?;
        for path in task["fileResponsibilities"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let full = root.join(path);
            if let Ok(resolved) = tokio::fs::canonicalize(&full).await {
                if !resolved.starts_with(&root) {
                    return Err(AppError::BadRequest(
                        "Responsibility resolves outside the working directory".into(),
                    ));
                }
            }
            // Directories represent ownership of their complete subtree.
            let mut pending = vec![full];
            while let Some(file) = pending.pop() {
                if file.is_symlink() {
                    hashes.insert(
                        file.strip_prefix(&root)
                            .unwrap()
                            .to_string_lossy()
                            .to_string(),
                        json!(format!(
                            "symlink:{}",
                            tokio::fs::read_link(&file).await?.to_string_lossy()
                        )),
                    );
                    continue;
                }
                match tokio::fs::metadata(&file).await {
                    Ok(m) if m.is_dir() => {
                        let mut dir = tokio::fs::read_dir(&file).await?;
                        while let Some(entry) = dir.next_entry().await? {
                            if !matches!(
                                entry.file_name().to_str(),
                                Some(".git" | "node_modules" | "target")
                            ) {
                                pending.push(entry.path());
                            }
                        }
                    }
                    Ok(m) if m.is_file() => {
                        let bytes = tokio::fs::read(&file).await?;
                        hashes.insert(
                            file.strip_prefix(&root)
                                .unwrap()
                                .to_string_lossy()
                                .to_string(),
                            json!(format!("{:x}", Sha256::digest(bytes))),
                        );
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        hashes.insert(
                            file.strip_prefix(&root)
                                .unwrap()
                                .to_string_lossy()
                                .to_string(),
                            json!("missing"),
                        );
                    }
                    Err(e) => return Err(e.into()),
                    _ => {}
                }
            }
        }
    }
    Ok(Value::Object(hashes))
}
async fn save_task(state: &AppState, group: &str, task: &mut Value) -> AppResult<()> {
    task["updatedAt"] = json!(now());
    let leader = group_leader(state, group).await?;
    let mut tx = state.db.pool.begin().await?;
    if !terminal(task) {
        sqlx::query(
            "UPDATE group_requests SET data=json_set(data,'$.completed',json('false')) WHERE id=?",
        )
        .bind(string(task, "rootId"))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT INTO group_tasks(id,group_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .bind(id(task)).bind(group).bind(task.to_string()).execute(&mut *tx).await?;
    if matches!(
        task["status"].as_str(),
        Some("awaiting_review" | "completed" | "blocked" | "failed" | "cancelled")
    ) {
        // Durable management turns let the leader report results and handle blockers.
        // They carry no assignment ownership and survive restart without replaying work.
        let delivery = json!({"id":format!("{}:{}:{}:{:x}:leader:{leader}",id(task),task["revision"],string(task,"status"),Sha256::digest(task["error"].to_string().as_bytes())),"groupId":group,"rootId":task["rootId"],"agentId":leader,"purpose":"message","status":"queued","createdAt":now(),"recovery":false,"event":{"type":"task_update","taskId":task["id"],"revision":task["revision"],"status":task["status"]}});
        insert_delivery(&mut tx, &delivery).await?;
    }
    tx.commit().await?;
    touch(state, group, "group.task").await
}
async fn schedule_review(state: &AppState, group: &str, task: &mut Value) -> AppResult<()> {
    let roster = members(&state.db, group).await?;
    let meta = get(&state.db, "groups", group).await?;
    let roles = default_roles(&roster, &meta["memberRoles"]);
    let mut candidates = Vec::new();
    for (position, peer) in roster.iter().enumerate() {
        if task["ownerId"] == peer.as_str() {
            continue;
        }
        let load:i64=sqlx::query_scalar("SELECT COUNT(*) FROM group_deliveries WHERE agent_id=? AND status IN ('queued','processing')").bind(peer).fetch_one(&state.db.pool).await?;
        candidates.push((
            !has_role(&roles[peer], "reviewer"),
            load,
            position,
            peer.clone(),
        ));
    }
    candidates.sort();
    let reviewer = candidates
        .first()
        .ok_or_else(|| AppError::Conflict("A different peer is required for review".into()))?
        .3
        .clone();
    task["reviewerId"] = json!(reviewer);
    task["status"] = json!("awaiting_review");
    enqueue(
        state,
        group,
        &string(task, "rootId"),
        &reviewer,
        "review",
        task,
    )
    .await?;
    save_task(state, group, task).await
}
async fn submit(state: &AppState, c: &GroupContext, input: &Value) -> AppResult<Value> {
    let task_id = c
        .task_id
        .as_deref()
        .ok_or_else(|| AppError::Conflict("Submit from an assignment execution".into()))?;
    let mut task = checked_task(state, &c.group_id, task_id).await?;
    if task["ownerId"] != c.agent_id || c.purpose != "execute" || task["status"] != "running" {
        return Err(AppError::Conflict(
            "Only the running assignment owner can submit".into(),
        ));
    }
    let pending:i64=sqlx::query_scalar("SELECT COUNT(*) FROM group_executions WHERE group_id=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.status')='waiting'").bind(&c.group_id).bind(task_id).fetch_one(&state.db.pool).await?;
    if pending > 0 {
        return Err(AppError::Conflict(
            "Inspect the child run outcome before submitting".into(),
        ));
    }
    task["result"] = json!(text(input, "result", 32_000)?);
    task["verification"] = json!(text(input, "verification", 16_000)?);
    if input.get("fileResponsibilities").is_some() {
        let paths = ids(input, "fileResponsibilities")?;
        validate_paths(&paths)?;
        task["fileResponsibilities"] = json!(paths);
    }
    // Include tracked/untracked modifications so omitted paths cannot produce an empty coding review.
    if let Some(directory) = task["workingDirectory"].as_str() {
        if let Ok(changes) = git::status(Path::new(directory)).await {
            let mut paths: Vec<String> = task["fileResponsibilities"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            for change in changes.changes {
                if !paths.contains(&change.path) {
                    paths.push(change.path);
                }
            }
            task["fileResponsibilities"] = json!(paths);
        }
    }
    task["revision"] = json!(task["revision"].as_i64().unwrap_or(1) + 1);
    task["fingerprints"] = fingerprints(&task).await?;
    schedule_review(state, &c.group_id, &mut task).await?;
    Ok(task)
}
async fn block_task(state: &AppState, c: &GroupContext, input: &Value) -> AppResult<Value> {
    let task_id = c
        .task_id
        .as_deref()
        .ok_or_else(|| AppError::Conflict("Use an assignment execution turn".into()))?;
    let mut task = checked_task(state, &c.group_id, task_id).await?;
    if c.purpose != "execute" || task["ownerId"] != c.agent_id || task["status"] != "running" {
        return Err(AppError::Conflict(
            "Only the executing owner can block this assignment".into(),
        ));
    }
    task["status"] = json!("blocked");
    task["error"] = json!(text(input, "reason", 4000)?);
    task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
    save_task(state, &c.group_id, &mut task).await?;
    Ok(task)
}

async fn review_task(
    state: &AppState,
    group: &str,
    task_id: &str,
    reviewer: &str,
    input: &Value,
) -> AppResult<Value> {
    let mut task = checked_task(state, group, task_id).await?;
    if task["status"] != "awaiting_review"
        || task["reviewerId"] != reviewer
        || task["ownerId"] == reviewer
    {
        return Err(AppError::Conflict(
            "Only the assigned other peer can review this task".into(),
        ));
    }
    if input["revision"] != task["revision"] {
        return Err(AppError::Conflict(
            "Assignment changed; review the current revision".into(),
        ));
    }
    let observed = fingerprints(&task).await?;
    if observed != task["fingerprints"] {
        task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
        task["fingerprints"] = observed;
        schedule_review(state, group, &mut task).await?;
        return Err(AppError::Conflict(
            "Files changed during review; review the new snapshot".into(),
        ));
    }
    let decision = text(input, "decision", 32)?;
    if decision != "approve" && decision != "request_changes" {
        return Err(AppError::BadRequest(
            "Choose approve or request_changes".into(),
        ));
    }
    let evidence = text(input, "evidence", 16_000)?;
    let record = json!({"id":uuid(),"groupId":group,"taskId":task_id,"reviewerId":reviewer,"revision":task["revision"],"decision":decision,"evidence":evidence,"fingerprints":observed,"createdAt":now()});
    put(&state.db, "group_reviews", group, &record).await?;
    task["status"] = json!(if decision == "approve" {
        "completed"
    } else {
        "queued"
    });
    task["error"] = if decision == "approve" {
        Value::Null
    } else {
        json!(evidence)
    };
    task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
    if decision == "request_changes" {
        enqueue(
            state,
            group,
            &string(&task, "rootId"),
            &string(&task, "ownerId"),
            "execute",
            &task,
        )
        .await?;
    }
    save_task(state, group, &mut task).await?;
    state.emit("group.review", json!({"groupId":group,"taskId":task_id}));
    Ok(task)
}
pub(crate) async fn review(
    State(state): State<AppState>,
    AxumPath((group, task_id)): AxumPath<(String, String)>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    if input.get("decision").is_some() || input.get("reviewerId").is_some() {
        return Err(AppError::Conflict(
            "Only the assigned peer can submit a review decision during its turn".into(),
        ));
    }
    let _gate = state.groups.gate.lock().await;
    let mut task = checked_task(&state, &group, &task_id).await?;
    if task["status"] != "awaiting_review" || task["revision"] != input["revision"] {
        return Err(AppError::Conflict(
            "Request review of the current awaiting-review revision".into(),
        ));
    }
    if state
        .groups
        .active
        .lock()
        .await
        .values()
        .any(|(c, _)| c.task_id.as_deref() == Some(&task_id))
    {
        return Err(AppError::Conflict("Review is already active".into()));
    }
    task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
    task["error"] = Value::Null;
    task["fingerprints"] = fingerprints(&task).await?;
    schedule_review(&state, &group, &mut task).await?;
    Ok(Json(task))
}
pub(crate) async fn patch_task(
    State(state): State<AppState>,
    AxumPath((group, task_id)): AxumPath<(String, String)>,
    Json(input): Json<Value>,
) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    let meta = get(&state.db, "groups", &group).await?;
    let mut task = checked_task(&state, &group, &task_id).await?;
    let allowed = [
        "title",
        "instructions",
        "expectedResult",
        "ownerId",
        "dependencyIds",
        "workingDirectory",
        "fileResponsibilities",
    ];
    if input
        .as_object()
        .is_none_or(|fields| fields.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        return Err(AppError::BadRequest("Unexpected assignment field".into()));
    }
    if terminal(&task) {
        return Err(AppError::Conflict(
            "Completed or cancelled assignments cannot be edited".into(),
        ));
    }
    if meta["stopped"] != true
        || matches!(task["status"].as_str(), Some("running" | "awaiting_review"))
    {
        return Err(AppError::Conflict(
            "Stop execution before changing an assignment".into(),
        ));
    }
    for field in ["title", "instructions", "expectedResult"] {
        if input.get(field).is_some() {
            task[field] = json!(text(
                &input,
                field,
                if field == "title" { 200 } else { 32_000 }
            )?);
        }
    }
    if input.get("ownerId").is_some() {
        let owner = text(&input, "ownerId", 200)?;
        if !members(&state.db, &group).await?.contains(&owner) {
            return Err(AppError::BadRequest("Owner must be a participant".into()));
        }
        task["ownerId"] = json!(owner);
    }
    if input.get("dependencyIds").is_some() {
        let deps = ids(&input, "dependencyIds")?;
        let tasks = all(&state.db, "group_tasks", &group).await?;
        let mut pending = deps.clone();
        let mut visited = HashSet::new();
        while let Some(dep) = pending.pop() {
            if dep == task_id {
                return Err(AppError::BadRequest(
                    "Assignment dependencies contain a cycle".into(),
                ));
            }
            if !visited.insert(dep.clone()) {
                continue;
            }
            let other = tasks
                .iter()
                .find(|t| id(t) == dep)
                .ok_or_else(|| AppError::BadRequest("Dependency is not in this group".into()))?;
            pending.extend(ids(other, "dependencyIds")?);
        }
        task["dependencyIds"] = json!(deps);
    }
    if input.get("workingDirectory").is_some() {
        let directory = text(&input, "workingDirectory", 4000)?;
        if !Path::new(&directory).is_absolute() || !Path::new(&directory).is_dir() {
            return Err(AppError::BadRequest(
                "Working directory must be an existing absolute directory".into(),
            ));
        }
        task["workingDirectory"] = json!(directory);
    }
    if input.get("fileResponsibilities").is_some() {
        let paths = ids(&input, "fileResponsibilities")?;
        validate_paths(&paths)?;
        task["fileResponsibilities"] = json!(paths);
    }
    ensure_assignment_directory(&state, &mut task).await?;
    task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
    sqlx::query("UPDATE group_deliveries SET status='cancelled',data=json_set(data,'$.status','cancelled') WHERE group_id=? AND json_extract(data,'$.taskId')=? AND status='queued'").bind(&group).bind(&task_id).execute(&state.db.pool).await?;
    if task["status"] == "queued" {
        if let Some(owner) = task["ownerId"].as_str() {
            enqueue(
                &state,
                &group,
                &string(&task, "rootId"),
                owner,
                "execute",
                &task,
            )
            .await?;
        }
    }
    save_task(&state, &group, &mut task).await?;
    Ok(Json(task))
}
pub(crate) async fn cancel_task(
    State(state): State<AppState>,
    AxumPath((group, task_id)): AxumPath<(String, String)>,
) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    let mut task = checked_task(&state, &group, &task_id).await?;
    task["status"] = json!("cancelled");
    task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
    sqlx::query("UPDATE group_deliveries SET status='cancelled',data=json_set(data,'$.status','cancelled') WHERE group_id=? AND json_extract(data,'$.taskId')=? AND status='queued'").bind(&group).bind(&task_id).execute(&state.db.pool).await?;
    for (c, signal) in state.groups.active.lock().await.values() {
        if c.group_id == group && c.task_id.as_deref() == Some(&task_id) {
            let _ = signal.send(true);
        }
    }
    save_task(&state, &group, &mut task).await?;
    drop(_gate);
    stop_children(&state, &group, Some(&task_id)).await?;
    Ok(Json(task))
}
pub(crate) async fn retry_task(
    State(state): State<AppState>,
    AxumPath((group, task_id)): AxumPath<(String, String)>,
) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    let mut task = checked_task(&state, &group, &task_id).await?;
    if !matches!(
        task["status"].as_str(),
        Some("failed" | "blocked" | "interrupted" | "cancelled" | "awaiting_review")
    ) {
        return Err(AppError::Conflict(
            "Retry only unfinished failed, blocked, interrupted or cancelled work".into(),
        ));
    }
    if state
        .groups
        .active
        .lock()
        .await
        .values()
        .any(|(c, _)| c.task_id.as_deref() == Some(&task_id))
    {
        return Err(AppError::Conflict("Wait for the execution to stop".into()));
    }
    if task["status"] == "awaiting_review" {
        task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
        task["error"] = Value::Null;
        task["fingerprints"] = fingerprints(&task).await?;
        schedule_review(&state, &group, &mut task).await?;
        return Ok(Json(task));
    }
    task["status"] = json!("queued");
    task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
    task["error"] = Value::Null;
    if let Some(owner) = task["ownerId"].as_str() {
        enqueue(
            &state,
            &group,
            &string(&task, "rootId"),
            owner,
            "execute",
            &task,
        )
        .await?;
    }
    save_task(&state, &group, &mut task).await?;
    Ok(Json(task))
}
pub(crate) async fn stop(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
) -> AppResult<Json<Value>> {
    halt(&state, &group).await?;
    Ok(Json(snapshot(&state, &group).await?))
}
async fn halt(state: &AppState, group: &str) -> AppResult<()> {
    {
        let _gate = state.groups.gate.lock().await;
        let mut meta = get(&state.db, "groups", group).await?;
        meta["stopped"] = json!(true);
        meta["stopReason"] = json!("user");
        put(&state.db, "groups", group, &meta).await?;
        for (c, signal) in state.groups.active.lock().await.values() {
            if c.group_id == group {
                let _ = signal.send(true);
            }
        }
        touch(state, group, "group.updated").await?;
    }
    stop_children(state, group, None).await?;
    Ok(())
}
pub(crate) async fn delete(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
) -> AppResult<Json<Value>> {
    halt(&state, &group).await?;
    // Never remove records while a turn can still write them. Stop has already
    // paused child dispatch; the gate protects the final idle check and removal.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let gate = state.groups.gate.lock().await;
        let meta = get(&state.db, "groups", &group).await?;
        if meta["stopped"] != true {
            return Err(AppError::Conflict(
                "Group was resumed. Stop it and retry deletion".into(),
            ));
        }
        let active = state
            .groups
            .active
            .lock()
            .await
            .values()
            .any(|(c, _)| c.group_id == group);
        let chats = providers::documents(&state.db, "provider-chats").await?;
        let coding = state.active_codex_turns.read().await;
        let child_active = chats
            .iter()
            .any(|chat| chat["groupId"] == group && coding.contains_key(id(chat)));
        drop(coding);
        if !active && !child_active {
            let mut tx = state.db.pool.begin().await?;
            for table in [
                "group_messages",
                "group_tasks",
                "group_reviews",
                "group_executions",
                "group_receipts",
                "group_operations",
                "group_requests",
                "group_members",
                "group_deliveries",
                "group_usage_buckets",
                "groups",
            ] {
                sqlx::query(&format!("DELETE FROM {table} WHERE group_id=?"))
                    .bind(&group)
                    .execute(&mut *tx)
                    .await?;
            }
            // Retain coding conversations and files, but detach their ownership.
            sqlx::query("UPDATE feature_documents SET content_json=json_remove(content_json,'$.groupId','$.groupTaskId','$.groupRootId','$.groupAgentId') WHERE namespace='provider-chats' AND json_extract(content_json,'$.groupId')=?")
                .bind(&group).execute(&mut *tx).await?;
            tx.commit().await?;
            state.emit("group.deleted", json!({"groupId":group}));
            state.emit("provider-chats.updated", json!({"groupId":group}));
            return Ok(Json(json!({"deleted":true,"groupId":group})));
        }
        drop(gate);
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::Conflict(
                "Group is stopping. Wait for active runs to finish and retry deletion".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn stop_children(state: &AppState, group: &str, task: Option<&str>) -> AppResult<()> {
    {
        let _gate = state.groups.gate.lock().await;
        for mut execution in all(&state.db, "group_executions", group).await? {
            if execution["status"] == "waiting" && task.is_none_or(|t| execution["taskId"] == t) {
                execution["status"] = json!("interrupted");
                execution["activity"] = Value::Null;
                put(&state.db, "group_executions", group, &execution).await?;
                if let Some(t) = execution["taskId"].as_str() {
                    let mut assignment = checked_task(state, group, t).await?;
                    if assignment["status"] == "running" {
                        assignment["status"] = json!("interrupted");
                        save_task(state, group, &mut assignment).await?;
                    }
                }
            }
        }
    }
    for chat in providers::documents(&state.db, "provider-chats").await? {
        if chat["groupId"] == group && task.is_none_or(|t| chat["groupTaskId"] == t) {
            agents::stop_chat(state, &string(&chat, "id")).await?;
        }
    }
    Ok(())
}
pub(crate) async fn resume(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    let was_stopped = get(&state.db, "groups", &group).await?["stopped"] == true;
    if was_stopped
        && state
            .groups
            .active
            .lock()
            .await
            .values()
            .any(|(c, _)| c.group_id == group)
    {
        return Err(AppError::Conflict(
            "Wait for interrupted turns to finish".into(),
        ));
    }
    for chat in providers::documents(&state.db, "provider-chats").await? {
        if was_stopped
            && chat["groupId"] == group
            && state
                .active_codex_turns
                .read()
                .await
                .contains_key(id(&chat))
        {
            return Err(AppError::Conflict(
                "Wait for the group's coding runs to stop".into(),
            ));
        }
    }
    let mut meta = get(&state.db, "groups", &group).await?;
    meta["stopped"] = json!(false);
    meta["stopReason"] = Value::Null;
    put(&state.db, "groups", &group, &meta).await?;
    for mut request in all(&state.db, "group_requests", &group).await? {
        if request["limited"] == true {
            request["limited"] = json!(false);
            request["turnCount"] = json!(0);
            put(&state.db, "group_requests", &group, &request).await?;
        }
    }
    for mut task in all(&state.db, "group_tasks", &group).await? {
        if task["status"] == "interrupted" {
            sqlx::query("UPDATE group_deliveries SET status='cancelled',data=json_set(data,'$.status','cancelled') WHERE group_id=? AND json_extract(data,'$.taskId')=? AND status='queued'").bind(&group).bind(id(&task)).execute(&state.db.pool).await?;
            task["status"] = json!("queued");
            task["recovery"] = json!(true);
            task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
            if let Some(owner) = task["ownerId"].as_str() {
                enqueue(
                    &state,
                    &group,
                    &string(&task, "rootId"),
                    owner,
                    "execute",
                    &task,
                )
                .await?;
            }
            save_task(&state, &group, &mut task).await?;
        }
    }
    for mut task in all(&state.db, "group_tasks", &group).await? {
        let purpose = match task["status"].as_str() {
            Some("queued") if task["ownerId"].is_string() => "execute",
            Some("awaiting_review") => "review",
            _ => continue,
        };
        let recipient = string(
            &task,
            if purpose == "review" {
                "reviewerId"
            } else {
                "ownerId"
            },
        );
        let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM group_deliveries WHERE group_id=? AND json_extract(data,'$.taskId')=? AND agent_id=? AND json_extract(data,'$.purpose')=? AND status IN ('queued','processing')")
            .bind(&group).bind(id(&task)).bind(&recipient).bind(purpose).fetch_one(&state.db.pool).await?;
        if pending == 0 {
            task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
            task["recovery"] = json!(true);
            if purpose == "review" {
                schedule_review(&state, &group, &mut task).await?;
            } else {
                enqueue(
                    &state,
                    &group,
                    &string(&task, "rootId"),
                    &recipient,
                    purpose,
                    &task,
                )
                .await?;
                save_task(&state, &group, &mut task).await?;
            }
        }
    }
    touch(&state, &group, "group.updated").await?;
    Ok(Json(snapshot(&state, &group).await?))
}

pub(crate) async fn pending(state: &AppState, agent: &str) -> AppResult<bool> {
    let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM group_deliveries d JOIN groups g ON g.id=d.group_id WHERE d.agent_id=? AND d.status='queued' AND json_extract(g.data,'$.stopped')=0").bind(agent).fetch_one(&state.db.pool).await?;
    Ok(count > 0)
}
pub(crate) async fn tick(state: &AppState) -> AppResult<()> {
    let _gate = state.groups.gate.lock().await;
    // Wake owners with exact child outcomes, never direct-message follow-ups.
    for mut execution in sqlx::query_scalar::<_, String>(
        "SELECT data FROM group_executions WHERE json_extract(data,'$.status')='waiting'",
    )
    .fetch_all(&state.db.pool)
    .await?
    .into_iter()
    .map(|v| serde_json::from_str::<Value>(&v))
    .collect::<Result<Vec<_>, _>>()?
    {
        let group = string(&execution, "groupId");
        if get(&state.db, "groups", &group).await?["stopped"] == true {
            continue;
        }
        let run_id = string(&execution, "childRunId");
        let chat_id = string(&execution, "chatId");
        if document(&state.db, "run-outcomes", &run_id).await.is_err()
            && !state.active_codex_turns.read().await.contains_key(&chat_id)
        {
            if let Ok(client) = providers::client_for_thread(state, &chat_id).await {
                if let Ok(Ok(result)) = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    client.request(
                        "thread/read",
                        json!({"threadId":chat_id,"includeTurns":true}),
                    ),
                )
                .await
                {
                    if let Some(turn) = result
                        .pointer("/thread/turns")
                        .and_then(Value::as_array)
                        .and_then(|turns| turns.iter().find(|t| t["id"] == run_id))
                    {
                        if matches!(
                            turn["status"].as_str(),
                            Some("completed" | "failed" | "interrupted")
                        ) {
                            agents::record_outcome(state, &chat_id, &run_id, &json!({"turn":turn}))
                                .await?;
                        }
                    }
                }
            }
        }
        if let Ok(outcome) = document(&state.db, "run-outcomes", &run_id).await {
            execution["status"] = json!("completed");
            execution["outcome"] = outcome;
            put(&state.db, "group_executions", &group, &execution).await?;
            let task_id = string(&execution, "taskId");
            let mut task = checked_task(state, &group, &task_id).await?;
            if !terminal(&task) {
                task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
                task["status"] = json!("queued");
                enqueue(
                    state,
                    &group,
                    &string(&task, "rootId"),
                    &string(&task, "ownerId"),
                    "execute",
                    &task,
                )
                .await?;
                save_task(state, &group, &mut task).await?;
            }
        }
    }
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM group_deliveries WHERE status='queued' ORDER BY created_at,rowid",
    )
    .fetch_all(&state.db.pool)
    .await?;
    for data in rows {
        let mut delivery: Value = serde_json::from_str(&data)?;
        let group = string(&delivery, "groupId");
        let meta = get(&state.db, "groups", &group).await?;
        if meta["stopped"] == true {
            continue;
        }
        let agent = string(&delivery, "agentId");
        if !members(&state.db, &group).await?.contains(&agent) {
            continue;
        }
        if let Some(task_id) = delivery["taskId"].as_str() {
            let task = checked_task(state, &group, task_id).await?;
            if terminal(&task) || matches!(task["status"].as_str(), Some("failed" | "blocked")) {
                set_delivery(state, &mut delivery, "cancelled").await?;
                continue;
            }
            if delivery["purpose"] == "review"
                && (task["status"] != "awaiting_review"
                    || task["reviewerId"] != agent
                    || delivery
                        .get("taskRevision")
                        .is_some_and(|r| r != &task["revision"]))
            {
                set_delivery(state, &mut delivery, "cancelled").await?;
                continue;
            }
            if delivery["purpose"] == "execute" {
                if task["status"] == "awaiting_review" {
                    set_delivery(state, &mut delivery, "cancelled").await?;
                    continue;
                }
                let mut ready = true;
                for dep in ids(&task, "dependencyIds")? {
                    if checked_task(state, &group, &dep).await?["status"] != "completed" {
                        ready = false;
                    }
                }
                if !ready {
                    continue;
                }
            }
        }
        let active_count = state
            .groups
            .active
            .lock()
            .await
            .values()
            .filter(|(c, _)| c.group_id == group)
            .count();
        let waiting_count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM group_executions WHERE group_id=? AND json_extract(data,'$.status')='waiting'").bind(&group).fetch_one(&state.db.pool).await?;
        if active_count + waiting_count as usize >= 4 {
            continue;
        }
        let root = string(&delivery, "rootId");
        let mut request = get(&state.db, "group_requests", &root).await?;
        if request["limited"] == true {
            continue;
        }
        if request["turnCount"].as_u64().unwrap_or(0) >= 32 {
            request["limited"] = json!(true);
            put(&state.db, "group_requests", &group, &request).await?;
            touch(state, &group, "group.updated").await?;
            continue;
        }
        let Some((signal, receiver)) = state.agents.reserve_group(&agent).await? else {
            continue;
        };
        let c = GroupContext {
            group_id: group.clone(),
            agent_id: agent.clone(),
            root_id: root,
            delivery_id: string(&delivery, "id"),
            task_id: delivery["taskId"].as_str().map(str::to_owned),
            execution_id: uuid(),
            purpose: string(&delivery, "purpose"),
        };
        request["turnCount"] = json!(request["turnCount"].as_u64().unwrap_or(0) + 1);
        put(&state.db, "group_requests", &group, &request).await?;
        set_delivery(state, &mut delivery, "processing").await?;
        if c.purpose == "execute" {
            let mut task = checked_task(state, &group, c.task_id.as_deref().unwrap()).await?;
            task["status"] = json!("running");
            save_task(state, &group, &mut task).await?;
        }
        put(&state.db,"group_executions",&group,&json!({"id":c.execution_id,"groupId":group,"agentId":agent,"taskId":c.task_id,"rootId":c.root_id,"deliveryId":c.delivery_id,"purpose":c.purpose,"status":"running","activity":"thinking","createdAt":now()})).await?;
        state
            .groups
            .active
            .lock()
            .await
            .insert(c.execution_id.clone(), (c.clone(), signal));
        let cloned = state.clone();
        tokio::spawn(async move {
            let result = CONTEXT
                .scope(c.clone(), run_delivery(&cloned, &c, &delivery, receiver))
                .await;
            if let Err(e) = finish(&cloned, &c, &delivery, result).await {
                tracing::error!(error=%e,"Unable to finish group execution");
            }
            let _ = set_agent_running(&cloned, &c.agent_id, None).await;
            cloned.groups.active.lock().await.remove(&c.execution_id);
            cloned.agents.release_group(&c.agent_id).await;
        });
        touch(state, &group, "group.activity").await?;
    }
    check_completion(state).await?;
    Ok(())
}
async fn set_delivery(state: &AppState, v: &mut Value, status: &str) -> AppResult<()> {
    v["status"] = json!(status);
    sqlx::query("UPDATE group_deliveries SET status=?,data=? WHERE id=?")
        .bind(status)
        .bind(v.to_string())
        .bind(id(v))
        .execute(&state.db.pool)
        .await?;
    Ok(())
}
async fn run_delivery(
    state: &AppState,
    c: &GroupContext,
    delivery: &Value,
    mut cancel: watch::Receiver<bool>,
) -> AppResult<()> {
    set_agent_running(state, &c.agent_id, Some(c)).await?;
    let view = snapshot(state, &c.group_id).await?;
    let agent = state.agents.get(&c.agent_id).await?;
    let root = get(&state.db, "group_messages", &c.root_id).await?;
    let task = match &c.task_id {
        Some(t) => checked_task(state, &c.group_id, t).await?,
        None => Value::Null,
    };
    let message = match delivery["messageId"].as_str() {
        Some(m) => get(&state.db, "group_messages", m).await?,
        None if delivery["event"]["type"] == "task_update" => {
            let updated = checked_task(
                state,
                &c.group_id,
                delivery["event"]["taskId"].as_str().unwrap(),
            )
            .await?;
            json!({"id":c.delivery_id,"senderType":"system","kind":"task_update","content":format!("Assignment update. Inspect current group progress, manage blockers or report the verified outcome to the human: {updated}")})
        }
        None => json!({"id":c.delivery_id,"content":format!("{} assignment: {}",c.purpose,task)}),
    };
    if c.purpose == "message"
        && c.task_id.is_none()
        && planning_agent(&view, &root) == c.agent_id
    {
        if let Some(recipient) = greeting_recipient(&view, &message, &c.agent_id) {
            if *cancel.borrow() {
                return Err(AppError::Conflict("Group stopped".into()));
            }
            execute_tool(
                state,
                c,
                "forward_group_message",
                &json!({"sourceMessageId":message["id"],"recipientIds":[recipient]}),
                "route-greeting",
                &[message],
            )
            .await?;
            return Ok(());
        }
    }
    let mut snapshot = agent.clone();
    snapshot["messages"] = view["messages"].clone();
    snapshot["followUps"] = json!([]);
    snapshot["groupContext"] = json!({"memberRole":view["memberRoles"][&c.agent_id],"leaderId":planning_agent(&view,&root),"planningAgentId":planning_agent(&view,&root),"group":view,"currentDelivery":delivery,"assignment":task,"originalUserRequest":root,"execution":c});
    snapshot["timeZone"] = root["timeZone"].clone();
    let mut message = message;
    if c.task_id.is_some() {
        message["attachments"] = root["attachments"].clone();
    }
    snapshot["groupContext"] = model_context(snapshot["groupContext"].clone());
    let current = vec![message];
    let mut excluded = HashSet::new();
    let mut account = agents::choose_account(state, agent["accountId"].as_str(), &excluded).await?;
    loop {
        agents::set_group_account(state, &c.agent_id, &account).await?;
        let result = agents::run_turn(
            state,
            &c.agent_id,
            &snapshot,
            &current,
            &[],
            &account,
            &mut cancel,
        )
        .await;
        if !*cancel.borrow()
            && result
                .as_ref()
                .err()
                .is_some_and(|e| agents::quota_error(&e.to_string()))
        {
            excluded.insert(account.clone());
            if let Ok(next) = agents::choose_account(state, None, &excluded).await {
                account = next;
                continue;
            }
        }
        return result;
    }
}

fn greeting_recipient(view: &Value, message: &Value, leader: &str) -> Option<String> {
    if message["senderType"] != "user" {
        return None;
    }
    let content = normalized_greeting_text(message["content"].as_str()?);
    let addressee = [
        "good afternoon",
        "good morning",
        "good evening",
        "xin chào",
        "xin chao",
        "hello",
        "chào",
        "chao",
        "hey",
        "hi",
    ]
    .into_iter()
    .find_map(|greeting| {
        let rest = content.strip_prefix(greeting)?;
        if !rest.starts_with(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ':' | '!')) {
            return None;
        }
        Some(
            rest.trim_start_matches(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ':' | '!'))
                .trim_start_matches('@'),
        )
    })?;
    let matches: Vec<_> = view["members"]
        .as_array()?
        .iter()
        .filter(|member| {
            member["profile"]["name"]
                .as_str()
                .is_some_and(|name| normalized_greeting_text(name) == addressee)
        })
        .collect();
    if matches.len() != 1 || matches[0]["id"] == leader {
        return None;
    }
    // An explicit nickname may collide with a roster name. Defer to conversation
    // in that case rather than overriding a human's established form of address.
    if view["messages"]
        .as_array()?
        .iter()
        .take_while(|previous| previous["id"] != message["id"])
        .any(|previous| {
            if previous["senderType"] != "user"
                || !previous["recipientIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == leader))
            {
                return false;
            }
            let previous =
                normalized_greeting_text(previous["content"].as_str().unwrap_or_default());
            previous.contains(addressee)
                && [
                    "call you",
                    "call u ",
                    "nickname",
                    "name you",
                    "named you",
                    "your name",
                    "you are my",
                    "gọi bạn",
                    "gọi em",
                    "gọi mày",
                    "biệt danh",
                    "đặt tên",
                    "tên bạn",
                    "tên em",
                ]
                .iter()
                .any(|marker| previous.contains(marker))
        })
    {
        return None;
    }
    Some(string(matches[0], "id"))
}

fn normalized_greeting_text(text: &str) -> String {
    text.trim()
        .trim_end_matches(|ch: char| matches!(ch, '.' | ',' | '!' | '?' | '…'))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

async fn finish(
    state: &AppState,
    c: &GroupContext,
    delivery: &Value,
    result: AppResult<()>,
) -> AppResult<()> {
    let _gate = state.groups.gate.lock().await;
    let meta = get(&state.db, "groups", &c.group_id).await?;
    let stopped = meta["stopped"] == true;
    let mut d = delivery.clone();
    set_delivery(
        state,
        &mut d,
        if stopped && c.task_id.is_none() {
            "queued"
        } else if result.is_ok() {
            "handled"
        } else {
            "failed"
        },
    )
    .await?;
    let mut e = get(&state.db, "group_executions", &c.execution_id).await?;
    if e["status"] != "waiting" {
        e["status"] = json!(if stopped {
            "interrupted"
        } else if result.is_ok() {
            "completed"
        } else {
            "failed"
        });
    }
    e["activity"] = Value::Null;
    e["finishedAt"] = json!(now());
    e["error"] = result
        .as_ref()
        .err()
        .map(|e| json!(e.to_string()))
        .unwrap_or(Value::Null);
    put(&state.db, "group_executions", &c.group_id, &e).await?;
    for mut receipt in all(&state.db, "group_receipts", &c.group_id).await? {
        if receipt["executionId"] == c.execution_id && receipt["status"] == "running" {
            receipt["status"] = json!("failed");
            receipt["result"]=json!(json!({"resultUnknown":true,"error":"Turn ended before the action result was saved"}).to_string());
            put(&state.db, "group_receipts", &c.group_id, &receipt).await?;
        }
    }
    if let Some(task_id) = &c.task_id {
        let mut task = checked_task(state, &c.group_id, task_id).await?;
        if task["status"] == "running" && e["status"] != "waiting" {
            task["status"] = json!(if stopped {
                "interrupted"
            } else if result
                .as_ref()
                .err()
                .is_some_and(|e| agents::quota_error(&e.to_string()))
            {
                "blocked"
            } else {
                "failed"
            });
            task["error"] = json!(result
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_else(|| {
                    "Owner ended its turn without submitting a result and verification".into()
                }));
            save_task(state, &c.group_id, &mut task).await?;
        } else if c.purpose == "review" && task["status"] == "awaiting_review" && !stopped {
            // A silent reviewer must not leave a permanently unserviceable assignment.
            task["error"] = json!(result
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_else(|| "Reviewer ended without a decision; retry review".into()));
            save_task(state, &c.group_id, &mut task).await?;
        }
    }
    touch(state, &c.group_id, "group.activity").await?;
    Ok(())
}
async fn check_completion(state: &AppState) -> AppResult<()> {
    let requests:Vec<String>=sqlx::query_scalar("SELECT data FROM group_requests WHERE json_extract(data,'$.completed')=0 AND json_extract(data,'$.limited')=0").fetch_all(&state.db.pool).await?;
    for data in requests {
        let mut request: Value = serde_json::from_str(&data)?;
        let group = string(&request, "groupId");
        if get(&state.db, "groups", &group).await?["stopped"] == true {
            continue;
        }
        let root = string(&request, "id");
        let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM group_deliveries WHERE group_id=? AND json_extract(data,'$.rootId')=? AND (status IN ('queued','processing') OR (status='failed' AND json_extract(data,'$.taskId') IS NULL))").bind(&group).bind(&root).fetch_one(&state.db.pool).await?;
        if count > 0 {
            continue;
        }
        let tasks: Vec<Value> = all(&state.db, "group_tasks", &group)
            .await?
            .into_iter()
            .filter(|t| t["rootId"] == root)
            .collect();
        if tasks.iter().any(|t| !terminal(t)) {
            continue;
        }
        let mut stale = false;
        for mut task in tasks {
            if task["status"] == "completed" && fingerprints(&task).await? != task["fingerprints"] {
                task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
                task["fingerprints"] = fingerprints(&task).await?;
                schedule_review(state, &group, &mut task).await?;
                stale = true;
            }
        }
        if !stale {
            request["completed"] = json!(true);
            put(&state.db, "group_requests", &group, &request).await?;
            touch(state, &group, "group.updated").await?;
        }
    }
    Ok(())
}
pub(crate) async fn activity(
    state: &AppState,
    c: &GroupContext,
    activity: Option<&str>,
) -> AppResult<()> {
    let _gate = state.groups.gate.lock().await;
    let mut e = get(&state.db, "group_executions", &c.execution_id).await?;
    if e["activity"] == json!(activity) {
        return Ok(());
    }
    e["activity"] = json!(activity);
    put(&state.db, "group_executions", &c.group_id, &e).await?;
    touch(state, &c.group_id, "group.activity").await?;
    Ok(())
}
pub(crate) async fn receipt(state: &AppState, c: &GroupContext, action: Value) -> AppResult<()> {
    let _gate = state.groups.gate.lock().await;
    receipt_locked(state, c, action).await
}
async fn receipt_locked(state: &AppState, c: &GroupContext, mut action: Value) -> AppResult<()> {
    if action["tool"] == "fileChange" {
        if let Some(task_id) = &c.task_id {
            let mut task = checked_task(state, &c.group_id, task_id).await?;
            let mut paths = ids(&task, "fileResponsibilities")?;
            for change in action
                .pointer("/arguments/changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(path) = change["path"].as_str() {
                    let relative = if let Some(root) = task["workingDirectory"].as_str() {
                        Path::new(path)
                            .strip_prefix(root)
                            .unwrap_or(Path::new(path))
                            .to_string_lossy()
                            .to_string()
                    } else {
                        path.to_owned()
                    };
                    if validate_paths(&[relative.clone()]).is_ok() && !paths.contains(&relative) {
                        paths.push(relative);
                    }
                }
            }
            task["fileResponsibilities"] = json!(paths);
            put(&state.db, "group_tasks", &c.group_id, &task).await?;
        }
    }
    action["groupId"] = json!(c.group_id);
    action["taskId"] = json!(c.task_id);
    action["agentId"] = json!(c.agent_id);
    action["executionId"] = json!(c.execution_id);
    if let Ok(previous) = get(&state.db, "group_receipts", id(&action)).await {
        if previous["status"] != "running" && action["status"] == "running" {
            return Ok(());
        }
    }
    put(&state.db, "group_receipts", &c.group_id, &action).await?;
    touch(state, &c.group_id, "group.action").await?;
    Ok(())
}
async fn reply_target(state: &AppState, c: &GroupContext) -> AppResult<String> {
    let delivery: Option<String> =
        sqlx::query_scalar("SELECT data FROM group_deliveries WHERE id=? AND group_id=?")
            .bind(&c.delivery_id)
            .bind(&c.group_id)
            .fetch_optional(&state.db.pool)
            .await?;
    if let Some(delivery) = delivery {
        let delivery: Value = serde_json::from_str(&delivery)?;
        if let Some(message) = delivery["messageId"].as_str() {
            return Ok(message.to_owned());
        }
    }
    Ok(c.root_id.clone())
}

async fn reply_recipients(state: &AppState, c: &GroupContext) -> AppResult<Vec<String>> {
    let leader = group_leader(state, &c.group_id).await?;
    if c.agent_id != leader {
        let parent = reply_target(state, c).await?;
        if let Ok(message) = get(&state.db, "group_messages", &parent).await {
            if message["senderType"] == "agent"
                && (message["senderId"] == leader || message["leaderRequest"] == true)
            {
                return Ok(vec![leader]);
            }
        }
    }
    Ok(vec![])
}

pub(crate) async fn reply(state: &AppState, c: &GroupContext, content: &str) -> AppResult<Value> {
    let _gate = state.groups.gate.lock().await;
    if get(&state.db, "groups", &c.group_id).await?["stopped"] == true {
        return Err(AppError::Conflict("Group is stopped".into()));
    }
    let profile = state.agents.get(&c.agent_id).await?;
    let recipients = reply_recipients(state, c).await?;
    let message = json!({"id":uuid(),"groupId":c.group_id,"rootId":c.root_id,"senderType":"agent","senderId":c.agent_id,"senderName":profile["profile"]["name"],"content":content,"toLeader":!recipients.is_empty(),"recipientIds":recipients,"kind":"message","createdAt":now(),"taskId":c.task_id,"inReplyTo":reply_target(state,c).await?,"attention":false});
    append_message(state, message, &recipients, "message", None).await
}

// Called under the group gate. Reuse the human message rather than creating a peer
// request, so the recipient replies to the human without waking the leader again.
async fn forward_message(
    state: &AppState,
    c: &GroupContext,
    args: &Value,
    current: &[Value],
) -> AppResult<Value> {
    if c.purpose != "message"
        || c.task_id.is_some()
        || group_leader(state, &c.group_id).await? != c.agent_id
    {
        return Err(AppError::Conflict(
            "Only the leader may forward a current human message".into(),
        ));
    }
    let source = text(args, "sourceMessageId", 400)?;
    if !current
        .iter()
        .any(|message| message["id"] == source && message["senderType"] == "user")
        || reply_target(state, c).await? != source
    {
        return Err(AppError::Conflict(
            "Forward only the current delivered human message".into(),
        ));
    }
    let message = get(&state.db, "group_messages", &source).await?;
    if message["groupId"] != c.group_id
        || message["rootId"] != c.root_id
        || message["senderType"] != "user"
        || !ids(&message, "recipientIds")?.contains(&c.agent_id)
    {
        return Err(AppError::BadRequest(
            "Forward a human message delivered to the leader in this group".into(),
        ));
    }
    let recipients = ids(args, "recipientIds")?;
    let roster = members(&state.db, &c.group_id).await?;
    if recipients.is_empty()
        || recipients
            .iter()
            .any(|agent| agent == &c.agent_id || !roster.contains(agent))
    {
        return Err(AppError::BadRequest(
            "Choose other participants in this group".into(),
        ));
    }
    let mut tx = state.db.pool.begin().await?;
    let mut delivery_ids = Vec::new();
    for agent in &recipients {
        let delivery_id = format!("{source}:{agent}:message");
        let delivery = json!({"id":delivery_id,"groupId":c.group_id,"agentId":agent,
            "rootId":c.root_id,"messageId":source,"taskId":null,"purpose":"message",
            "status":"queued","createdAt":now(),"recovery":false,
            "event":{"type":"forwarded_message","forwardedBy":c.agent_id}});
        // The usual delivery ID also prevents duplicate replies to a participant
        // already addressed by the human or reached by an earlier routing attempt.
        insert_delivery(&mut tx, &delivery).await?;
        delivery_ids.push(delivery_id);
    }
    tx.commit().await?;
    touch(state, &c.group_id, "group.activity").await?;
    Ok(
        json!({"sourceMessageId":source,"recipientIds":recipients,"deliveryIds":delivery_ids,
        "instructions":"The original human message has been queued for these recipients. End this turn silently; do not post an acknowledgement or speak for them."}),
    )
}

pub(crate) fn tools(base: Value, purpose: &str) -> Value {
    let mut specs: Vec<Value> = base
        .as_array()
        .unwrap()
        .iter()
        .filter(|tool| {
            let name = tool["name"].as_str().unwrap_or_default();
            matches!(
                name,
                "send_agent_message"
                    | "select_agent_model"
                    | "get_profile"
                    | "list_workspaces"
                    | "list_chats"
                    | "read_chat"
                    | "read_run"
                    | "list_accounts"
                    | "list_models"
            ) || purpose == "execute"
                && matches!(
                    name,
                    "create_chat"
                        | "send_message"
                        | "watch_chat"
                        | "computer_status"
                        | "computer_screenshot"
                        | "computer_action"
                )
        })
        .cloned()
        .map(|mut tool| {
            if tool["name"] == "send_agent_message" {
                tool["description"] = json!("Post one public group reply. Specialist replies to a leader request wake the current leader; leader replies do not wake specialists. Use request_group_peers to ask for a response; do not post the same message twice.");
            }
            tool
        })
        .collect();
    for (name, description, properties, required) in [
        (
            "block_group_task",
            "Mark your executing assignment blocked with an honest prerequisite or recovery error. The user can retry it.",
            json!({"reason":{"type":"string"}}),
            json!(["reason"]),
        ),
        (
            "read_group_context",
            "Read current shared context, assignments, reviews and receipts.",
            json!({}),
            json!([]),
        ),
        (
            "send_group_message",
            "Post one public message. A specialist reply to a leader request wakes the current leader. Other public replies do not wake participants. To ask for a response, use request_group_peers once. attention=true only when human input is needed.",
            json!({"content":{"type":"string"},"attention":{"type":"boolean"}}),
            json!(["content"]),
        ),
        (
            "forward_group_message",
            "The leader may quietly deliver the current human message to its intended group participants. Use when the human clearly addresses another member, including a greeting. Resolve exact IDs from the roster and distinguish established nicknames for yourself from another intended recipient. Preserve the original human message and attachments; this posts no new chat bubble. After success, end silently and let the recipients reply. Do not use for peer messages, old messages, ambiguous names or new task assignments.",
            json!({"sourceMessageId":{"type":"string"},"recipientIds":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string"}}}),
            json!(["sourceMessageId", "recipientIds"]),
        ),
        (
            "request_group_peers",
            "Post a public message and wake the named peers within the originating human request. Send the actual question or request once; do not also post it with another message tool. Content is visible to the human and every peer, not a private prompt or stage direction.",
            json!({"content":{"type":"string","description":"The actual public message addressed to the peer, in your own voice. Do not include instructions about how to phrase their reply."},"recipientIds":{"type":"array","items":{"type":"string"}}}),
            json!(["content", "recipientIds"]),
        ),
        (
            "list_group_agents",
            "List existing agents by ID and name so the leader can resolve a human request to add participants. Contains no private direct-chat history. Ask the human when names are ambiguous.",
            json!({}),
            json!([]),
        ),
        (
            "manage_group",
            "The current leader may apply group settings, role or participant changes explicitly requested in the current human message. sourceMessageId must identify that delivered human message. memberIds is the complete new roster (at least two existing agents); omitted means unchanged. memberRoles is a patch keyed by participant ID; roles replaces that agent's role list and responsibilities is optional. An agent can hold several roles. Exactly one agent must have coordinator (leader), including during handoff. Other roles can be shared. Do not remove owners of unfinished tasks, pending reviewers or agents currently working. Existing task ownership is preserved. projectId assigns an existing registered project, null unassigns it, and omission leaves it unchanged. Use list_workspaces to resolve project names; ask when ambiguous. Project changes apply only to future assignments and preserve existing task directories. name renames the group. Updates are declared publicly in chat automatically; do not repeat them. Use list_group_agents to resolve names; never invent an agent ID.",
            json!({"sourceMessageId":{"type":"string"},"projectId":{"type":["string","null"]},"name":{"type":"string"},"memberIds":{"type":"array","items":{"type":"string"}},"memberRoles":{"type":"object","additionalProperties":{"type":"object","properties":{"roles":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","enum":["coordinator","developer","reviewer","researcher","designer"]}},"responsibilities":{"type":"string"}},"required":["roles"],"additionalProperties":false}}}),
            json!(["sourceMessageId"]),
        ),
        (
            "create_group_task",
            "Only the group leader may create assignments. For a human project-work request in a message turn, inspect existing tasks and memberRoles, then assign one distinct task to a specific owner. Creation automatically queues a separate execution turn with coding-chat tools; those tools are intentionally absent from message turns. Dependencies must be existing tasks.",
            json!({"title":{"type":"string"},"instructions":{"type":"string"},"expectedResult":{"type":"string"},"ownerId":{"type":"string"},"dependencyIds":{"type":"array","items":{"type":"string"}},"workingDirectory":{"type":"string"},"fileResponsibilities":{"type":"array","items":{"type":"string"}}}),
            json!(["title", "instructions", "expectedResult", "ownerId"]),
        ),
        (
            "claim_group_task",
            "Atomically claim an available assignment; execution is queued as a separate turn.",
            json!({"taskId":{"type":"string"}}),
            json!(["taskId"]),
        ),
        (
            "submit_group_result",
            "Submit the current assignment with verification for mandatory review by another peer.",
            json!({"result":{"type":"string"},"verification":{"type":"string"},"fileResponsibilities":{"type":"array","items":{"type":"string"}}}),
            json!(["result", "verification"]),
        ),
        (
            "review_group_task",
            "Review your assigned task at the exact revision. decision is approve or request_changes. Evidence is mandatory.",
            json!({"revision":{"type":"integer"},"decision":{"type":"string"},"evidence":{"type":"string"}}),
            json!(["revision", "decision", "evidence"]),
        ),
    ] {
        let available = match name {
            "block_group_task" | "submit_group_result" => purpose == "execute",
            "review_group_task" => purpose == "review",
            _ => true,
        };
        if !available {
            continue;
        }
        specs.push(json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}));
    }
    json!(specs)
}
pub(crate) async fn execute_tool(
    state: &AppState,
    c: &GroupContext,
    name: &str,
    args: &Value,
    call: &str,
    current: &[Value],
) -> AppResult<Value> {
    let specs = tools(
        serde_json::from_str(include_str!("agent-tools.json"))?,
        &c.purpose,
    );
    let spec = specs
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .ok_or_else(|| AppError::BadRequest("Tool unavailable in this group turn".into()))?;
    let fields = args
        .as_object()
        .ok_or_else(|| AppError::BadRequest("Tool arguments must be an object".into()))?;
    let props = spec["inputSchema"]["properties"].as_object().unwrap();
    if fields.keys().any(|k| !props.contains_key(k))
        || spec["inputSchema"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|k| !fields.contains_key(k.as_str().unwrap()))
    {
        return Err(AppError::BadRequest("Invalid tool arguments".into()));
    }
    let mutation = matches!(
        name,
        "create_group_task"
            | "manage_group"
            | "claim_group_task"
            | "request_group_peers"
            | "forward_group_message"
            | "send_group_message"
            | "send_agent_message"
            | "create_chat"
            | "send_message"
    );
    let op_id = if mutation {
        format!(
            "{}:{}:{name}:{:x}",
            c.root_id,
            c.agent_id,
            Sha256::digest(args.to_string().as_bytes())
        )
    } else {
        format!("{}:{call}", c.execution_id)
    };
    let fresh_read = matches!(
        name,
        "read_group_context"
            | "list_group_agents"
            | "read_chat"
            | "read_run"
            | "list_chats"
            | "list_accounts"
            | "list_models"
            | "list_workspaces"
    );
    {
        let _gate = state.groups.gate.lock().await;
        let meta = get(&state.db, "groups", &c.group_id).await?;
        if meta["stopped"] == true {
            return Err(AppError::Conflict("Group is stopped".into()));
        }
        if let Some(task) = &c.task_id {
            if checked_task(state, &c.group_id, task).await?["status"] == "cancelled" {
                return Err(AppError::Conflict("Assignment is cancelled".into()));
            }
        }
        if !fresh_read {
            if let Ok(op) = get(&state.db, "group_operations", &op_id).await {
                if op["status"] == "completed" {
                    return Ok(op["result"].clone());
                }
                if op["status"] == "running" {
                    return Err(AppError::Conflict(
                        "Previous action result is unknown; inspect live state before retrying"
                            .into(),
                    ));
                }
            }
        }
        put(&state.db,"group_operations",&c.group_id,&json!({"id":op_id,"groupId":c.group_id,"status":"running","tool":name,"arguments":args})).await?;
    }
    receipt(
        state,
        c,
        json!({"id":op_id,"tool":name,"arguments":args,"status":"running"}),
    )
    .await?;
    // Group mutations use the same gate as scheduling and Stop. Native tool futures do not hold it.
    let result = execute_action(state, c, name, args, current).await;
    let _gate = state.groups.gate.lock().await;
    put(&state.db,"group_operations",&c.group_id,&json!({"id":op_id,"groupId":c.group_id,"status":if result.is_ok(){"completed"}else{"failed"},"result":result.as_ref().ok().map(|v|if fresh_read{json!({"read":true})}else{computer::receipt_result(v)}),"error":result.as_ref().err().map(ToString::to_string)})).await?;
    let saved = json!({"id":op_id,"tool":name,"arguments":args,"status":if result.is_ok(){"completed"}else{"failed"},"result":match &result{Ok(v)=>if fresh_read{json!({"read":true}).to_string()}else{computer::receipt_result(v).to_string().chars().take(24_000).collect()},Err(e)=>json!({"error":e.to_string()}).to_string()},"chatId":result.as_ref().ok().and_then(|v|v["chatId"].as_str())});
    receipt_locked(state, c, saved).await?;
    result
}
async fn execute_action(
    state: &AppState,
    c: &GroupContext,
    name: &str,
    args: &Value,
    current: &[Value],
) -> AppResult<Value> {
    if matches!(
        name,
        "read_group_context"
            | "manage_group"
            | "list_group_agents"
            | "create_group_task"
            | "claim_group_task"
            | "submit_group_result"
            | "review_group_task"
            | "block_group_task"
            | "request_group_peers"
            | "forward_group_message"
            | "send_group_message"
    ) {
        let _gate = state.groups.gate.lock().await;
        if get(&state.db, "groups", &c.group_id).await?["stopped"] == true {
            Err(AppError::Conflict("Group is stopped".into()))
        } else {
            match name {
                "forward_group_message" => forward_message(state, c, args, current).await,
                "list_group_agents" => {
                    let agents = agents::list_agents(State(state.clone())).await.0;
                    Ok(json!(agents
                        .into_iter()
                        .map(|agent| json!({"id":agent["id"],"name":agent["profile"]["name"]}))
                        .collect::<Vec<_>>()))
                }
                "read_group_context" => {
                    let mut view = snapshot(state, &c.group_id).await?;
                    let root = get(&state.db, "group_messages", &c.root_id).await?;
                    view["memberRole"] = view["memberRoles"][&c.agent_id].clone();
                    view["planningAgentId"] = json!(planning_agent(&view, &root));
                    view["leaderId"] = view["planningAgentId"].clone();
                    Ok(model_context(view))
                }
                "manage_group" => {
                    if c.purpose != "message"
                        || group_leader(state, &c.group_id).await? != c.agent_id
                    {
                        return Err(AppError::Conflict(
                            "Only the leader can apply human-requested group changes".into(),
                        ));
                    }
                    let source = text(args, "sourceMessageId", 200)?;
                    if !current
                        .iter()
                        .any(|message| message["id"] == source && message["senderType"] == "user")
                    {
                        return Err(AppError::Conflict(
                            "Use the current human message as the group change source".into(),
                        ));
                    }
                    let message = get(&state.db, "group_messages", &source).await?;
                    if message["groupId"] != c.group_id
                        || message["rootId"] != c.root_id
                        || message["senderType"] != "user"
                    {
                        return Err(AppError::BadRequest(
                            "Group changes must come from the human in this group".into(),
                        ));
                    }
                    let roster = if args.get("memberIds").is_some() {
                        ids(args, "memberIds")?
                    } else {
                        members(&state.db, &c.group_id).await?
                    };
                    validate_members(state, &roster).await?;
                    let mut meta = get(&state.db, "groups", &c.group_id).await?;
                    let mut roles = default_roles(&roster, &meta["memberRoles"]);
                    if let Some(patch) = args.get("memberRoles") {
                        let patch = patch.as_object().ok_or_else(|| {
                            AppError::BadRequest("Invalid role declaration".into())
                        })?;
                        // An explicit successor takes precedence over a default promotion
                        // when the old leader is removed in this same declaration.
                        if patch.values().any(|member| has_role(member, "coordinator")) {
                            for agent in &roster {
                                if has_role(&roles[agent], "coordinator")
                                    && !has_role(&meta["memberRoles"][agent], "coordinator")
                                {
                                    let remaining: Vec<Value> = roles[agent]["roles"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .filter(|role| *role != "coordinator")
                                        .cloned()
                                        .collect();
                                    roles[agent]["roles"] = if remaining.is_empty() {
                                        json!(["developer"])
                                    } else {
                                        json!(remaining)
                                    };
                                }
                            }
                        }
                        for (agent, fields) in patch {
                            if !roster.contains(agent) {
                                return Err(AppError::BadRequest(
                                    "Declare roles only for group participants".into(),
                                ));
                            }
                            let fields = fields.as_object().ok_or_else(|| {
                                AppError::BadRequest("Invalid role declaration".into())
                            })?;
                            // A supplied role list replaces roles while preserving unspecified responsibilities.
                            if fields.contains_key("roles") {
                                roles[agent]["roles"] = fields["roles"].clone();
                            } else if let Some(role) = fields.get("role") {
                                roles[agent]["roles"] = json!([role]);
                            }
                            if let Some(scope) = fields.get("responsibilities") {
                                roles[agent]["responsibilities"] = scope.clone();
                            }
                        }
                    } else if args.get("memberIds").is_none()
                        && args.get("projectId").is_none()
                        && args.get("name").is_none()
                    {
                        return Err(AppError::BadRequest(
                            "Provide a project, name, role or participant change".into(),
                        ));
                    }
                    meta["memberRoles"] = validate_roles(&roster, &roles)?;
                    let mut lines = Vec::new();
                    if args.get("name").is_some() {
                        meta["name"] = json!(text(args, "name", 120)?);
                        lines.push(format!("Group name: {}.", string(&meta, "name")));
                    }
                    if let Some(declaration) = apply_group_project(state, &mut meta, args).await? {
                        lines.push(declaration);
                    }
                    let roster_changed =
                        args.get("memberIds").is_some() || args.get("memberRoles").is_some();
                    if roster_changed {
                        lines.push("Group roles:".to_owned());
                    }
                    for agent in roster.iter().filter(|_| roster_changed) {
                        let profile = state.agents.get(agent).await?;
                        let role = &meta["memberRoles"][agent];
                        let labels: Vec<&str> = role["roles"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|role| {
                                if role == "coordinator" {
                                    "leader"
                                } else {
                                    role.as_str().unwrap()
                                }
                            })
                            .collect();
                        let scope = role["responsibilities"].as_str().unwrap_or_default();
                        lines.push(format!(
                            "- {} — {}{}",
                            string(&profile["profile"], "name"),
                            labels.join(", "),
                            if scope.is_empty() {
                                String::new()
                            } else {
                                format!(": {scope}")
                            }
                        ));
                    }
                    let profile = state.agents.get(&c.agent_id).await?;
                    let announcement = json!({"id":uuid(),"groupId":c.group_id,"rootId":c.root_id,"senderType":"agent","senderId":c.agent_id,"senderName":profile["profile"]["name"],"content":lines.join("\n"),"recipientIds":[],"kind":if roster_changed {"roles"} else {"message"},"createdAt":now(),"inReplyTo":source});
                    persist_membership(
                        state,
                        &c.group_id,
                        &meta,
                        &roster,
                        Some(announcement.clone()),
                        Some(&c.execution_id),
                    )
                    .await?;
                    touch(state, &c.group_id, "group.updated").await?;
                    Ok(
                        json!({"memberIds":roster,"memberRoles":meta["memberRoles"],"projectId":meta["projectId"],"workingDirectory":meta["workingDirectory"],"name":meta["name"],"declaration":get(&state.db,"group_messages",id(&announcement)).await?}),
                    )
                }
                "create_group_task" => {
                    let view = snapshot(state, &c.group_id).await?;
                    let root = get(&state.db, "group_messages", &c.root_id).await?;
                    if planning_agent(&view, &root) != c.agent_id {
                        Err(AppError::Conflict("Only the group leader may create assignments; contribute within your role or ask the leader for a task".into()))
                    } else {
                        text(args, "ownerId", 200)?;
                        create_assignment(state, &c.group_id, &c.root_id, args).await
                    }
                }
                "claim_group_task" => {
                    let mut task =
                        checked_task(state, &c.group_id, &text(args, "taskId", 200)?).await?;
                    if task["ownerId"].is_null() && task["status"] == "queued" {
                        task["ownerId"] = json!(c.agent_id);
                        task["revision"] = json!(task["revision"].as_i64().unwrap() + 1);
                        ensure_assignment_directory(state, &mut task).await?;
                        enqueue(
                            state,
                            &c.group_id,
                            &string(&task, "rootId"),
                            &c.agent_id,
                            "execute",
                            &task,
                        )
                        .await?;
                        save_task(state, &c.group_id, &mut task).await?;
                        Ok(task)
                    } else {
                        Err(AppError::Conflict(
                            "Assignment is already owned or not available".into(),
                        ))
                    }
                }
                "submit_group_result" => submit(state, c, args).await,
                "block_group_task" => block_task(state, c, args).await,
                "review_group_task" => {
                    if c.purpose != "review" {
                        Err(AppError::Conflict("Use the assigned review turn".into()))
                    } else {
                        review_task(
                            state,
                            &c.group_id,
                            c.task_id.as_deref().unwrap(),
                            &c.agent_id,
                            args,
                        )
                        .await
                    }
                }
                "send_group_message" | "request_group_peers" => {
                    let content = text(args, "content", 8000)?;
                    let recipients = if name == "request_group_peers" {
                        ids(args, "recipientIds")?
                    } else {
                        reply_recipients(state, c).await?
                    };
                    let roster = members(&state.db, &c.group_id).await?;
                    if name == "request_group_peers"
                        && (recipients.is_empty()
                            || recipients
                                .iter()
                                .any(|a| a == &c.agent_id || !roster.contains(a)))
                    {
                        Err(AppError::BadRequest(
                            "Choose other group participants".into(),
                        ))
                    } else {
                        let a = state.agents.get(&c.agent_id).await?;
                        let leader_request = name == "request_group_peers"
                            && group_leader(state, &c.group_id).await? == c.agent_id;
                        let message = json!({"id":uuid(),"groupId":c.group_id,"rootId":c.root_id,"senderType":"agent","senderId":c.agent_id,"senderName":a["profile"]["name"],"content":content,"toLeader":name=="send_group_message" && !recipients.is_empty(),"leaderRequest":leader_request,"recipientIds":recipients,"kind":if name=="request_group_peers"{"request"}else{"message"},"createdAt":now(),"taskId":c.task_id,"inReplyTo":reply_target(state,c).await?,"attention":args["attention"]==true});
                        append_message(state, message, &recipients, "message", None).await
                    }
                }
                _ => Err(AppError::BadRequest("Unknown group tool".into())),
            }
        }
    } else {
        if name == "create_chat" {
            if c.task_id.is_none() {
                return Err(AppError::Conflict(
                    "Create coding runs only from an assignment".into(),
                ));
            }
            if args["watch"] == false || args["startRun"] == false {
                return Err(AppError::BadRequest(
                    "Group coding chats must start a watched run".into(),
                ));
            }
            let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM group_executions WHERE group_id=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.status')='waiting'").bind(&c.group_id).bind(c.task_id.as_deref()).fetch_one(&state.db.pool).await?;
            if count > 0 {
                return Err(AppError::Conflict(
                    "Wait for the existing child run outcome".into(),
                ));
            }
        }
        if matches!(name, "send_message" | "watch_chat") {
            let chat = document(&state.db, "provider-chats", &text(args, "chatId", 200)?).await?;
            if chat["groupId"] != c.group_id || chat["groupTaskId"] != json!(c.task_id) {
                return Err(AppError::Conflict(
                    "Only operate coding runs owned by this assignment".into(),
                ));
            }
            if name == "send_message"
                && (args["watch"] == false
                    || state
                        .active_codex_turns
                        .read()
                        .await
                        .contains_key(id(&chat)))
            {
                return Err(AppError::Conflict(
                    "Wait for the owned run before sending another watched instruction".into(),
                ));
            }
        }
        agents::tool_action(state, &c.agent_id, name, args, current).await
    }
}

pub(crate) async fn attach_chat(state: &AppState, chat: &mut Value) -> AppResult<()> {
    if let Some(c) = context() {
        chat["groupId"] = json!(c.group_id);
        chat["groupTaskId"] = json!(c.task_id);
        chat["groupRootId"] = json!(c.root_id);
        chat["groupAgentId"] = json!(c.agent_id);
        // Metadata is persisted by the caller before the first real run.
        if get(&state.db, "groups", &c.group_id).await?["stopped"] == true {
            return Err(AppError::Conflict("Group stopped before dispatch".into()));
        }
    }
    Ok(())
}
pub(crate) async fn watch_child(state: &AppState, followup: &Value) -> AppResult<Value> {
    let c = context().ok_or_else(|| AppError::Internal("Missing group context".into()))?;
    let mut execution = get(&state.db, "group_executions", &c.execution_id).await?;
    execution["status"] = json!("waiting");
    execution["childRunId"] = followup["runId"].clone();
    execution["chatId"] = followup["chatId"].clone();
    put(&state.db, "group_executions", &c.group_id, &execution).await?;
    Ok(
        json!({"id":c.execution_id,"followUpId":c.execution_id,"groupId":c.group_id,"runId":followup["runId"]}),
    )
}

pub(crate) async fn agent_active(state: &AppState, agent: &str) -> bool {
    state
        .groups
        .active
        .lock()
        .await
        .values()
        .any(|(c, _)| c.agent_id == agent)
}
pub(crate) async fn set_agent_running(
    state: &AppState,
    agent: &str,
    c: Option<&GroupContext>,
) -> AppResult<()> {
    agents::set_group_status(state, agent, c).await
}

pub(crate) async fn dispatch_guard(
    state: &AppState,
    chat_id: &str,
) -> AppResult<Option<tokio::sync::OwnedMutexGuard<()>>> {
    let Ok(chat) = document(&state.db, "provider-chats", chat_id).await else {
        return Ok(None);
    };
    if let Some(group) = chat["groupId"].as_str() {
        let guard = state.groups.gate.clone().lock_owned().await;
        if get(&state.db, "groups", group).await?["stopped"] == true {
            return Err(AppError::Conflict(
                "Group is stopped; resume it before dispatch".into(),
            ));
        }
        return Ok(Some(guard));
    }
    Ok(None)
}

pub(crate) async fn record_child_event(
    state: &AppState,
    chat_id: &str,
    run_id: &str,
    method: &str,
    params: &Value,
) -> AppResult<()> {
    if method == "thread/tokenUsage/updated" {
        if let Ok(chat) = document(&state.db, "provider-chats", chat_id).await {
            if let Some(group) = chat["groupId"].as_str() {
                let mut agent = chat["groupAgentId"].as_str().or_else(|| chat["managedByAgentId"].as_str()).map(str::to_owned);
                if agent.is_none() {
                    if let Some(task) = chat["groupTaskId"].as_str() {
                        if let Ok(task) = get(&state.db, "group_tasks", task).await {
                            agent = task["ownerId"].as_str().map(str::to_owned);
                        }
                    }
                }
                agent_usage::record_scoped(
                    &state.db,
                    agent.as_deref().unwrap_or("coding"),
                    chat_id,
                    params,
                    Some(group),
                    false,
                )
                .await?;
            }
        }
        return Ok(());
    }
    if !matches!(method, "item/started" | "item/completed") {
        return Ok(());
    }
    let Ok(chat) = document(&state.db, "provider-chats", chat_id).await else {
        return Ok(());
    };
    let Some(group) = chat["groupId"].as_str() else {
        return Ok(());
    };
    let item = &params["item"];
    let Some(kind) = item["type"].as_str().filter(|k| {
        matches!(
            *k,
            "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "imageView"
        )
    }) else {
        return Ok(());
    };
    let executions = all(&state.db, "group_executions", group).await?;
    let Some(execution) = executions.iter().rev().find(|e| {
        e["childRunId"] == run_id
            || (e["taskId"] == chat["groupTaskId"] && e["status"] == "running")
    }) else {
        return Ok(());
    };
    let c = GroupContext {
        group_id: group.into(),
        agent_id: string(execution, "agentId"),
        root_id: string(execution, "rootId"),
        delivery_id: string(execution, "deliveryId"),
        task_id: execution["taskId"].as_str().map(str::to_owned),
        execution_id: string(execution, "id"),
        purpose: "execute".into(),
    };
    let failed = matches!(
        item["status"].as_str(),
        Some("failed" | "declined" | "interrupted")
    ) || item["exitCode"].as_i64().is_some_and(|v| v != 0)
        || item.get("error").is_some_and(|e| !e.is_null());
    let mut arguments = item.clone();
    if let Some(fields) = arguments.as_object_mut() {
        for key in ["aggregatedOutput", "stdout", "stderr", "output", "result"] {
            fields.remove(key);
        }
    }
    receipt(state,&c,json!({"id":format!("{chat_id}:{run_id}:{}",item["id"].as_str().unwrap_or("activity")),"chatId":chat_id,"tool":kind,"arguments":arguments,"status":if method=="item/started"{"running"}else if failed{"failed"}else{"completed"},"result":if method=="item/completed"{Some(item.to_string().chars().take(24_000).collect::<String>())}else{None}})).await
}

#[cfg(test)]
#[path = "groups_tests.rs"]
mod tests;

fn model_context(mut value: Value) -> Value {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(fields) => {
                fields.remove("dataUrl");
                if let Some(Value::String(result)) = fields.get_mut("result") {
                    *result = result.chars().take(2000).collect();
                }
                for value in fields.values_mut() {
                    strip(value);
                }
            }
            Value::Array(values) => {
                for value in values {
                    strip(value);
                }
            }
            _ => {}
        }
    }
    strip(&mut value);
    value
}

async fn validate_task_input(state: &AppState, group: &str, input: &Value) -> AppResult<()> {
    let meta = get(&state.db, "groups", group).await?;
    text(input, "title", 200)?;
    text(input, "instructions", 32_000)?;
    text(input, "expectedResult", 4000)?;
    if let Some(owner) = input["ownerId"].as_str() {
        if !members(&state.db, group).await?.iter().any(|a| a == owner) {
            return Err(AppError::BadRequest("Owner must be a participant".into()));
        }
    }
    if input.get("dependencyIds").is_some() {
        for dependency in ids(input, "dependencyIds")? {
            checked_task(state, group, &dependency).await?;
        }
    }
    if input.get("fileResponsibilities").is_some() {
        validate_paths(&ids(input, "fileResponsibilities")?)?;
    }
    if let Some(directory) = input["workingDirectory"]
        .as_str()
        .or(meta["workingDirectory"].as_str())
    {
        if !Path::new(directory).is_absolute() || !Path::new(directory).is_dir() {
            return Err(AppError::BadRequest(
                "Working directory must be an existing absolute directory".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) async fn checkbox(State(state): State<AppState>, AxumPath(group): AxumPath<String>, Json(input): Json<markdown_checkboxes::CheckboxEdit>) -> AppResult<Json<Value>> {
    let _gate = state.groups.gate.lock().await;
    let meta = get(&state.db, "groups", &group).await?;
    if state.groups.active.lock().await.values().any(|(c, _)| c.group_id == group) {
        return Err(AppError::Conflict("Wait for group turns to finish before editing Markdown".into()));
    }
    let record_id = input.record_id.as_deref().ok_or_else(|| AppError::BadRequest("Record ID required".into()))?;
    let (table, field) = match input.target.as_str() {
        "message" => ("group_messages", "content"),
        "instructions" => ("group_tasks", "instructions"),
        "result" => ("group_tasks", "result"),
        _ => return Err(AppError::BadRequest("Invalid Markdown target".into())),
    };
    let mut record = get(&state.db, table, record_id).await?;
    if record["groupId"] != group { return Err(AppError::NotFound("Record not found in group".into())); }
    if field == "instructions" && (meta["stopped"] != true || terminal(&record) || matches!(record["status"].as_str(), Some("running" | "awaiting_review"))) {
        return Err(AppError::Conflict("This assignment is read-only. Stop execution before editing.".into()));
    }
    record[field] = json!(input.apply(record[field].as_str().unwrap_or_default())?);
    if table == "group_tasks" { record["updatedAt"] = json!(now()); }
    put(&state.db, table, &group, &record).await?;
    touch(&state, &group, "group.updated").await?;
    Ok(Json(record))
}
