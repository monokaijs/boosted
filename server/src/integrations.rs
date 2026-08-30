use crate::{
    error::{AppError, AppResult},
    models::Integration,
};
use reqwest::{Client, Url};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct ImportedIssue {
    pub external_id: String,
    pub title: String,
    pub description: String,
    pub external_url: Option<String>,
}

pub async fn fetch_issues(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    match integration.provider.as_str() {
        "gitlab" => fetch_gitlab(integration).await,
        "huly" => fetch_huly(integration).await,
        _ => Err(AppError::BadRequest(
            "unsupported integration provider".into(),
        )),
    }
}

fn config_string<'a>(config: &'a Value, key: &str) -> AppResult<&'a str> {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest(format!("integration setting `{key}` is required")))
}

async fn fetch_gitlab(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    let base = integration
        .config
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://gitlab.com");
    let project = config_string(&integration.config, "project")?;
    let token = config_string(&integration.config, "token")?;
    let mut url =
        Url::parse(base).map_err(|_| AppError::BadRequest("GitLab URL is invalid".into()))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AppError::BadRequest("GitLab URL cannot be used as a base URL".into()))?;
        segments
            .pop_if_empty()
            .extend(["api", "v4", "projects", project, "issues"]);
    }
    url.query_pairs_mut()
        .append_pair("state", "opened")
        .append_pair("scope", "all")
        .append_pair("per_page", "100");
    let response = Client::new()
        .get(url)
        .header("PRIVATE-TOKEN", token)
        .send()
        .await
        .map_err(|error| AppError::Internal(format!("GitLab request failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "GitLab returned {}",
            response.status()
        )));
    }
    let issues = response
        .json::<Vec<Value>>()
        .await
        .map_err(|error| AppError::Internal(format!("invalid GitLab response: {error}")))?;
    Ok(issues
        .into_iter()
        .filter_map(|issue| {
            let iid = issue.get("iid")?.to_string();
            let title = issue.get("title")?.as_str()?.trim().to_string();
            let mut description = issue
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if let Some(labels) = issue.get("labels").and_then(Value::as_array) {
                let labels = labels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|label| format!("`{label}`"))
                    .collect::<Vec<_>>();
                if !labels.is_empty() {
                    description.push_str(&format!("\n\n**Labels:** {}", labels.join(" ")));
                }
            }
            if description.is_empty() {
                description = format!("Imported from GitLab issue !{iid}.");
            }
            Some(ImportedIssue {
                external_id: iid,
                title,
                description,
                external_url: issue
                    .get("web_url")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect())
}

async fn fetch_huly(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    // Huly exposes issues through its official SDK. This provider calls a small Huly
    // connector endpoint so self-hosted and cloud deployments can use the same adapter.
    let endpoint = config_string(&integration.config, "endpoint")?;
    let token = config_string(&integration.config, "token")?;
    let workspace = config_string(&integration.config, "workspace")?;
    let project = config_string(&integration.config, "project")?;
    let response = Client::new()
        .get(endpoint)
        .bearer_auth(token)
        .query(&[
            ("workspace", workspace),
            ("project", project),
            ("state", "open"),
        ])
        .send()
        .await
        .map_err(|error| AppError::Internal(format!("Huly connector request failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "Huly connector returned {}",
            response.status()
        )));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| AppError::Internal(format!("invalid Huly connector response: {error}")))?;
    let issues = value
        .as_array()
        .cloned()
        .or_else(|| value.get("issues").and_then(Value::as_array).cloned())
        .or_else(|| value.get("data").and_then(Value::as_array).cloned())
        .ok_or_else(|| {
            AppError::BadRequest(
                "Huly connector must return an issue array, or an object with `issues`/`data`"
                    .into(),
            )
        })?;
    Ok(issues
        .into_iter()
        .filter_map(|issue| {
            let external_id = issue
                .get("identifier")
                .or_else(|| issue.get("id"))
                .or_else(|| issue.get("_id"))?
                .as_str()?
                .to_string();
            let title = issue.get("title")?.as_str()?.trim().to_string();
            let description = issue
                .get("markdown")
                .or_else(|| issue.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("Imported from Huly.")
                .to_string();
            let external_url = issue
                .get("url")
                .or_else(|| issue.get("webUrl"))
                .and_then(Value::as_str)
                .map(str::to_string);
            Some(ImportedIssue {
                external_id,
                title,
                description,
                external_url,
            })
        })
        .collect())
}
