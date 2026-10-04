//! Durable token accounting for direct and group agent turns.
use super::*;

pub(crate) async fn migrate(db: &Database) -> AppResult<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS agent_usage_threads (thread_id TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL)")
        .execute(&db.pool).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS agent_usage_buckets (agent_id TEXT NOT NULL, start_date TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY(agent_id, start_date))")
        .execute(&db.pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS agent_usage_by_date ON agent_usage_buckets(start_date)")
        .execute(&db.pool).await?;
    Ok(())
}

pub(crate) async fn record(
    db: &Database,
    agent: &str,
    thread: &str,
    params: &Value,
) -> AppResult<()> {
    let Some(total) = params
        .pointer("/tokenUsage/total/totalTokens")
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
    else {
        return Ok(());
    };
    let bucket = Utc::now().format("%Y-%m-%dT%H:00:00Z").to_string();
    let mut tx = db.pool.begin().await?;
    // Acquire the write lock before reading so concurrent notifications cannot
    // count the same increment. Keep the high-water mark across restarts.
    sqlx::query("INSERT OR IGNORE INTO agent_usage_threads(thread_id,total_tokens) VALUES(?,0)")
        .bind(thread)
        .execute(&mut *tx)
        .await?;
    let previous: i64 =
        sqlx::query_scalar("SELECT total_tokens FROM agent_usage_threads WHERE thread_id=?")
            .bind(thread)
            .fetch_one(&mut *tx)
            .await?;
    if total > previous {
        sqlx::query("UPDATE agent_usage_threads SET total_tokens=? WHERE thread_id=?")
            .bind(total)
            .bind(thread)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO agent_usage_buckets(agent_id,start_date,tokens) VALUES(?,?,?) ON CONFLICT(agent_id,start_date) DO UPDATE SET tokens=tokens+excluded.tokens")
            .bind(agent).bind(bucket).bind(total - previous).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct UsageQuery {
    pub(crate) days: Option<i64>,
}

pub(crate) async fn read_usage(
    State(state): State<AppState>,
    Query(query): Query<UsageQuery>,
) -> AppResult<Json<Value>> {
    let days = query.days.unwrap_or(30);
    if ![7, 30, 90].contains(&days) {
        return Err(AppError::BadRequest(
            "Usage range must be 7, 30, or 90 days".into(),
        ));
    }
    // Include an extra UTC day for clients grouping the hourly buckets locally.
    let since = (Utc::now() - chrono::Duration::days(days + 1))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    let rows = sqlx::query("SELECT agent_id,start_date,tokens FROM agent_usage_buckets WHERE start_date>=? ORDER BY start_date")
        .bind(since).fetch_all(&state.db.pool).await?;
    let tracked_since: Option<String> =
        sqlx::query_scalar("SELECT MIN(start_date) FROM agent_usage_buckets")
            .fetch_one(&state.db.pool)
            .await?;
    let Json(agents) = agents::list_agents(State(state)).await;
    let series: Vec<_> = agents.iter().map(|agent| {
        let buckets: Vec<_> = rows.iter().filter(|row| row.get::<String,_>("agent_id") == agent["id"].as_str().unwrap_or_default())
            .map(|row| json!({"startDate":row.get::<String,_>("start_date"),"tokens":row.get::<i64,_>("tokens")})).collect();
        json!({"agentId":agent["id"],"name":agent["profile"]["name"],"buckets":buckets})
    }).collect();
    Ok(Json(json!({"trackedSince":tracked_since,"series":series})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn usage_counts_increments_once_and_persists_across_reconnection() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("usage.db");
        let db = Database::connect(&path).await.unwrap();
        for total in [100, 100, 70, 160] {
            record(
                &db,
                "pock",
                "thread-a",
                &json!({"tokenUsage":{"total":{"totalTokens":total}}}),
            )
            .await
            .unwrap();
        }
        record(
            &db,
            "sage",
            "thread-b",
            &json!({"tokenUsage":{"total":{"totalTokens":40}}}),
        )
        .await
        .unwrap();
        record(
            &db,
            "pock",
            "invalid",
            &json!({"tokenUsage":{"total":{"totalTokens":-1}}}),
        )
        .await
        .unwrap();
        db.pool.close().await;
        let db = Database::connect(&path).await.unwrap();
        record(
            &db,
            "pock",
            "thread-a",
            &json!({"tokenUsage":{"total":{"totalTokens":180}}}),
        )
        .await
        .unwrap();
        let rows = sqlx::query("SELECT agent_id,SUM(tokens) AS tokens FROM agent_usage_buckets GROUP BY agent_id ORDER BY agent_id")
            .fetch_all(&db.pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<String, _>("agent_id"), "pock");
        assert_eq!(rows[0].get::<i64, _>("tokens"), 180);
        assert_eq!(rows[1].get::<i64, _>("tokens"), 40);
    }
}
