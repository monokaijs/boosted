use crate::{
    error::{AppError, AppResult},
    models::{
        AuthUser, Integration, Project, Task, TaskAttachment, TaskEvent, TaskPlan, TaskSource, User,
    },
};
use chrono::Utc;
use serde_json::Value;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};
use std::path::Path;

#[derive(Clone)]
pub struct Database {
    pub pool: SqlitePool,
}

impl Database {
    pub async fn connect(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let url = format!("sqlite://{}?mode=rwc", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect(&url)
            .await?;
        sqlx::query("PRAGMA journal_mode=WAL")
            .execute(&pool)
            .await?;
        sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await?;
        let db = Self { pool };
        db.migrate().await?;
        Ok(db)
    }

    async fn migrate(&self) -> AppResult<()> {
        for statement in MIGRATION
            .split(";\n")
            .filter(|part| !part.trim().is_empty())
        {
            sqlx::query(statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    pub async fn user_count(&self) -> AppResult<i64> {
        Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await?)
    }

    pub async fn user_by_username_with_hash(
        &self,
        username: &str,
    ) -> AppResult<Option<(User, String)>> {
        let row = sqlx::query("SELECT id, username, password_hash, role, must_change_password, disabled, created_at FROM users WHERE lower(username)=lower(?)").bind(username).fetch_optional(&self.pool).await?;
        Ok(row.map(|row| (user_from_row(&row), row.get("password_hash"))))
    }

    pub async fn user(&self, id: &str) -> AppResult<User> {
        let row = sqlx::query("SELECT id, username, role, must_change_password, disabled, created_at FROM users WHERE id=?").bind(id).fetch_optional(&self.pool).await?.ok_or_else(|| AppError::NotFound("user not found".into()))?;
        Ok(user_from_row(&row))
    }

    pub async fn users(&self) -> AppResult<Vec<User>> {
        let rows = sqlx::query("SELECT id, username, role, must_change_password, disabled, created_at FROM users ORDER BY created_at").fetch_all(&self.pool).await?;
        Ok(rows.iter().map(user_from_row).collect())
    }

    pub async fn auth_by_token_hash(&self, hash: &str) -> AppResult<Option<AuthUser>> {
        let row = sqlx::query("SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0").bind(hash).bind(Utc::now().to_rfc3339()).fetch_optional(&self.pool).await?;
        Ok(row.map(|row| AuthUser {
            id: row.get("id"),
            username: row.get("username"),
            role: row.get("role"),
        }))
    }

    pub async fn projects(&self) -> AppResult<Vec<Project>> {
        let rows = sqlx::query(
            "SELECT id,name,repo_path,default_branch,created_at FROM projects ORDER BY created_at",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(project_from_row).collect())
    }

    pub async fn project(&self, id: &str) -> AppResult<Project> {
        let row = sqlx::query(
            "SELECT id,name,repo_path,default_branch,created_at FROM projects WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("project not found".into()))?;
        Ok(project_from_row(&row))
    }

    pub async fn tasks(&self, project_id: Option<&str>) -> AppResult<Vec<Task>> {
        let rows = if let Some(project_id) = project_id {
            let query = TASK_SELECT.to_owned() + " WHERE t.project_id=? ORDER BY t.updated_at DESC";
            sqlx::query(&query)
                .bind(project_id)
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query(&(TASK_SELECT.to_owned() + " ORDER BY t.updated_at DESC"))
                .fetch_all(&self.pool)
                .await?
        };
        let mut tasks = Vec::with_capacity(rows.len());
        for row in rows {
            tasks.push(self.task_from_row(&row).await?);
        }
        Ok(tasks)
    }

    pub async fn task(&self, id: &str) -> AppResult<Task> {
        let row = sqlx::query(&(TASK_SELECT.to_owned() + " WHERE t.id=?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::NotFound("task not found".into()))?;
        self.task_from_row(&row).await
    }

    async fn task_from_row(&self, row: &sqlx::sqlite::SqliteRow) -> AppResult<Task> {
        let id: String = row.get("id");
        let plan_row = sqlx::query("SELECT revision,explanation,markdown,steps_json,approved_at,approved_by FROM plans WHERE task_id=? ORDER BY revision DESC LIMIT 1").bind(&id).fetch_optional(&self.pool).await?;
        let plan = plan_row.map(|plan| TaskPlan {
            revision: plan.get("revision"),
            explanation: plan.get("explanation"),
            markdown: plan.get("markdown"),
            steps: serde_json::from_str(&plan.get::<String, _>("steps_json")).unwrap_or_default(),
            approved_at: plan.get("approved_at"),
            approved_by: plan.get("approved_by"),
        });
        let attachment_rows = sqlx::query("SELECT id,name,mime_type,size FROM task_attachments WHERE task_id=? ORDER BY created_at")
            .bind(&id).fetch_all(&self.pool).await?;
        let attachments = attachment_rows
            .iter()
            .map(|row| TaskAttachment {
                id: row.get("id"),
                name: row.get("name"),
                mime_type: row.get("mime_type"),
                size: row.get("size"),
            })
            .collect();
        let source = sqlx::query(
            "SELECT provider,external_id,external_url FROM task_sources WHERE task_id=?",
        )
        .bind(&id)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| TaskSource {
            provider: row.get("provider"),
            external_id: row.get("external_id"),
            external_url: row.get("external_url"),
        });
        Ok(Task {
            id,
            project_id: row.get("project_id"),
            title: row.get("title"),
            description: row.get("description"),
            status: row.get("status"),
            branch_name: row.get("branch_name"),
            worktree_path: row.get("worktree_path"),
            base_branch: row.get("base_branch"),
            model: row.get("model"),
            reasoning_effort: row.get("reasoning_effort"),
            access_mode: row.get("access_mode"),
            provider_thread_id: row.get("provider_thread_id"),
            created_by: row.get("created_by"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            additions: row.get("additions"),
            deletions: row.get("deletions"),
            plan,
            active_turn_id: row.get("active_turn_id"),
            error: row.get("error"),
            attachments,
            source,
        })
    }

    pub async fn integrations(&self, project_id: &str) -> AppResult<Vec<Integration>> {
        let rows = sqlx::query("SELECT id,project_id,provider,name,config_json,enabled,sync_interval_minutes,last_synced_at,last_sync_status,last_sync_error,created_at,updated_at FROM integrations WHERE project_id=? ORDER BY created_at")
            .bind(project_id).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(integration_from_row).collect())
    }

    pub async fn integration(&self, id: &str) -> AppResult<Integration> {
        let row = sqlx::query("SELECT id,project_id,provider,name,config_json,enabled,sync_interval_minutes,last_synced_at,last_sync_status,last_sync_error,created_at,updated_at FROM integrations WHERE id=?")
            .bind(id).fetch_optional(&self.pool).await?.ok_or_else(|| AppError::NotFound("integration not found".into()))?;
        Ok(integration_from_row(&row))
    }

    pub async fn events(&self, task_id: &str, after: i64) -> AppResult<Vec<TaskEvent>> {
        let rows = sqlx::query("SELECT e.id,e.task_id,e.kind,e.actor_id,u.username actor_name,e.payload_json,e.created_at FROM task_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.task_id=? AND e.id>? ORDER BY e.id LIMIT 2000").bind(task_id).bind(after).fetch_all(&self.pool).await?;
        Ok(rows
            .iter()
            .map(|row| TaskEvent {
                id: row.get("id"),
                task_id: row.get("task_id"),
                kind: row.get("kind"),
                actor_id: row.get("actor_id"),
                actor_name: row.get("actor_name"),
                payload: serde_json::from_str(&row.get::<String, _>("payload_json"))
                    .unwrap_or(Value::Null),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    pub async fn add_event(
        &self,
        task_id: &str,
        kind: &str,
        actor_id: Option<&str>,
        payload: &Value,
    ) -> AppResult<i64> {
        let result = sqlx::query("INSERT INTO task_events(task_id,kind,actor_id,payload_json,created_at) VALUES(?,?,?,?,?)").bind(task_id).bind(kind).bind(actor_id).bind(payload.to_string()).bind(Utc::now().to_rfc3339()).execute(&self.pool).await?;
        Ok(result.last_insert_rowid())
    }
}

fn user_from_row(row: &sqlx::sqlite::SqliteRow) -> User {
    User {
        id: row.get("id"),
        username: row.get("username"),
        role: row.get("role"),
        must_change_password: row.get::<i64, _>("must_change_password") != 0,
        disabled: row.get::<i64, _>("disabled") != 0,
        created_at: row.get("created_at"),
    }
}
fn project_from_row(row: &sqlx::sqlite::SqliteRow) -> Project {
    Project {
        id: row.get("id"),
        name: row.get("name"),
        repo_path: row.get("repo_path"),
        default_branch: row.get("default_branch"),
        created_at: row.get("created_at"),
    }
}

fn integration_from_row(row: &sqlx::sqlite::SqliteRow) -> Integration {
    Integration {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider: row.get("provider"),
        name: row.get("name"),
        config: serde_json::from_str(&row.get::<String, _>("config_json")).unwrap_or(Value::Null),
        enabled: row.get::<i64, _>("enabled") != 0,
        sync_interval_minutes: row.get("sync_interval_minutes"),
        last_synced_at: row.get("last_synced_at"),
        last_sync_status: row.get("last_sync_status"),
        last_sync_error: row.get("last_sync_error"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

const TASK_SELECT: &str = "SELECT t.id,t.project_id,t.title,t.description,t.status,t.branch_name,t.worktree_path,t.provider_thread_id,t.created_by,t.created_at,t.updated_at,t.additions,t.deletions,t.active_turn_id,t.error,COALESCE(o.base_branch,p.default_branch) base_branch,o.model,o.reasoning_effort,COALESCE(o.access_mode,'fullAccess') access_mode FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN task_options o ON o.task_id=t.id";

const MIGRATION: &str = r#"
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), must_change_password INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE, default_branch TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, branch_name TEXT NOT NULL, worktree_path TEXT NOT NULL, provider_thread_id TEXT, active_turn_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_options(task_id TEXT PRIMARY KEY REFERENCES tasks(id), base_branch TEXT NOT NULL, model TEXT, reasoning_effort TEXT, access_mode TEXT NOT NULL CHECK(access_mode IN ('fullAccess','workspaceWrite','readOnly')));
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS plans(task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, explanation TEXT, markdown TEXT, steps_json TEXT NOT NULL, approved_at TEXT, approved_by TEXT REFERENCES users(id), PRIMARY KEY(task_id,revision));
CREATE TABLE IF NOT EXISTS task_events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, actor_id TEXT REFERENCES users(id), payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id,id);
CREATE TABLE IF NOT EXISTS pending_task_attachments(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_attachments(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id,created_at);
CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), provider TEXT NOT NULL CHECK(provider IN ('gitlab','huly')), name TEXT NOT NULL, config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sync_interval_minutes INTEGER, last_synced_at TEXT, last_sync_status TEXT, last_sync_error TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_integrations_project ON integrations(project_id,created_at);
CREATE TABLE IF NOT EXISTS task_sources(task_id TEXT PRIMARY KEY REFERENCES tasks(id), integration_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL, external_url TEXT, UNIQUE(integration_id,external_id));
CREATE TABLE IF NOT EXISTS workspace_codex_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id), instructions TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
"#;
