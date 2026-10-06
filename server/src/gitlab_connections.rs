use crate::{
    AppState,
    db::Database,
    error::{AppError, AppResult},
    models::AuthUser,
};
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionInput {
    name: String,
    base_url: String,
    token: String,
}

pub(crate) async fn migrate(db: &Database) -> AppResult<()> {
    let mut tx = db.pool.begin().await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS gitlab_connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, token TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)").execute(&mut *tx).await?;
    let rows = sqlx::query("SELECT id,name,config_json,created_by,created_at FROM integrations WHERE provider='gitlab'").fetch_all(&mut *tx).await?;
    for row in rows {
        let mut config: Value = serde_json::from_str(&row.get::<String, _>("config_json"))?;
        if config.get("connectionId").is_some() {
            continue;
        }
        let Some(token) = config["token"]
            .as_str()
            .filter(|token| !token.trim().is_empty())
        else {
            continue;
        };
        let base = config["baseUrl"]
            .as_str()
            .unwrap_or("https://gitlab.com")
            .trim()
            .trim_end_matches('/');
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM gitlab_connections WHERE base_url=? AND token=?")
                .bind(base)
                .bind(token.trim())
                .fetch_optional(&mut *tx)
                .await?;
        let connection_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        sqlx::query("INSERT OR IGNORE INTO gitlab_connections(id,name,base_url,token,created_by,created_at) VALUES(?,?,?,?,?,?)").bind(&connection_id).bind(row.get::<String,_>("name")).bind(base).bind(token.trim()).bind(row.get::<String,_>("created_by")).bind(row.get::<String,_>("created_at")).execute(&mut *tx).await?;
        config["connectionId"] = json!(connection_id);
        if let Some(object) = config.as_object_mut() {
            object.remove("token");
            object.remove("baseUrl");
        }
        sqlx::query("UPDATE integrations SET config_json=? WHERE id=?")
            .bind(config.to_string())
            .bind(row.get::<String, _>("id"))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn resolve(db: &Database, provider: &str, config: &Value) -> AppResult<Value> {
    let mut resolved = config.clone();
    if provider == "gitlab" {
        if let Some(id) = config["connectionId"].as_str() {
            let row = sqlx::query("SELECT base_url,token FROM gitlab_connections WHERE id=?")
                .bind(id)
                .fetch_optional(&db.pool)
                .await?
                .ok_or_else(|| AppError::NotFound("GitLab connection not found".into()))?;
            resolved["baseUrl"] = json!(row.get::<String, _>("base_url"));
            resolved["token"] = json!(row.get::<String, _>("token"));
        }
    }
    Ok(resolved)
}

pub(crate) fn project_config(provider: &str, config: &Value) -> Value {
    let mut config = config.clone();
    if provider == "gitlab" {
        if let Some(object) = config.as_object_mut() {
            object.remove("token");
            object.remove("baseUrl");
            object.remove("search");
        }
    }
    config
}

pub(crate) async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<Connection>>> {
    let rows =
        sqlx::query("SELECT id,name,base_url,token FROM gitlab_connections ORDER BY name,id")
            .fetch_all(&state.db.pool)
            .await?;
    Ok(Json(
        rows.iter()
            .map(|row| Connection {
                id: row.get("id"),
                name: row.get("name"),
                base_url: row.get("base_url"),
                token: row.get("token"),
            })
            .collect(),
    ))
}

fn validate(input: &ConnectionInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::BadRequest("connection name is required".into()));
    }
    crate::integrations::validate_gitlab_connection(
        &json!({"baseUrl":input.base_url.trim(),"token":input.token.trim()}),
    )
}

pub(crate) async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<ConnectionInput>,
) -> AppResult<(StatusCode, Json<Connection>)> {
    validate(&input)?;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO gitlab_connections(id,name,base_url,token,created_by,created_at) VALUES(?,?,?,?,?,?)").bind(&id).bind(input.name.trim()).bind(input.base_url.trim().trim_end_matches('/')).bind(input.token.trim()).bind(&user.id).bind(Utc::now().to_rfc3339()).execute(&state.db.pool).await?;
    state.emit("gitlab_connection.created", json!({"connectionId":id}));
    Ok((
        StatusCode::CREATED,
        Json(Connection {
            id,
            name: input.name.trim().into(),
            base_url: input.base_url.trim().trim_end_matches('/').into(),
            token: input.token.trim().into(),
        }),
    ))
}

pub(crate) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<ConnectionInput>,
) -> AppResult<Json<Connection>> {
    validate(&input)?;
    let result = sqlx::query("UPDATE gitlab_connections SET name=?,base_url=?,token=? WHERE id=?")
        .bind(input.name.trim())
        .bind(input.base_url.trim().trim_end_matches('/'))
        .bind(input.token.trim())
        .bind(&id)
        .execute(&state.db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("GitLab connection not found".into()));
    }
    state.emit("gitlab_connection.updated", json!({"connectionId":id}));
    Ok(Json(Connection {
        id,
        name: input.name.trim().into(),
        base_url: input.base_url.trim().trim_end_matches('/').into(),
        token: input.token.trim().into(),
    }))
}

pub(crate) async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let mut tx = state.db.pool.begin().await?;
    let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM integrations WHERE provider='gitlab' AND json_extract(config_json,'$.connectionId')=?").bind(&id).fetch_one(&mut *tx).await?;
    if used > 0 {
        return Err(AppError::Conflict(
            "Disconnect this GitLab connection from its projects before removing it".into(),
        ));
    }
    let result = sqlx::query("DELETE FROM gitlab_connections WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("GitLab connection not found".into()));
    }
    tx.commit().await?;
    state.emit("gitlab_connection.deleted", json!({"connectionId":id}));
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
#[path = "gitlab_connections_tests.rs"]
mod tests;
