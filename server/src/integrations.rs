use crate::{
    error::{AppError, AppResult},
    models::Integration,
};
use reqwest::{Client, Url};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct ImportedIssue {
    pub external_id: String,
    pub title: String,
    pub description: String,
    pub external_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum GitlabTargetKind {
    Project,
    Group,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GitlabTarget {
    kind: GitlabTargetKind,
    identifier: String,
    legacy_external_ids: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HulyTarget {
    workspace: String,
    project: String,
    legacy_external_ids: bool,
}

pub fn validate_config(provider: &str, config: &Value) -> AppResult<()> {
    match provider {
        "gitlab" => {
            let base = config
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or("https://gitlab.com");
            Url::parse(base).map_err(|_| AppError::BadRequest("GitLab URL is invalid".into()))?;
            config_string(config, "token")?;
            gitlab_targets(config)?;
        }
        "huly" => {
            let endpoint = config_string(config, "endpoint")?;
            Url::parse(endpoint)
                .map_err(|_| AppError::BadRequest("Huly connector endpoint is invalid".into()))?;
            config_string(config, "token")?;
            huly_targets(config)?;
        }
        _ => {
            return Err(AppError::BadRequest(
                "unsupported integration provider".into(),
            ));
        }
    }
    Ok(())
}

pub async fn fetch_issues(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    let mut issues = match integration.provider.as_str() {
        "gitlab" => fetch_gitlab(integration).await?,
        "huly" => fetch_huly(integration).await?,
        _ => {
            return Err(AppError::BadRequest(
                "unsupported integration provider".into(),
            ));
        }
    };
    let mut external_ids = HashSet::new();
    issues.retain(|issue| external_ids.insert(issue.external_id.clone()));
    Ok(issues)
}

fn config_string<'a>(config: &'a Value, key: &str) -> AppResult<&'a str> {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::BadRequest(format!("integration setting `{key}` is required")))
}

fn target_string<'a>(target: &'a Value, key: &str) -> AppResult<&'a str> {
    target
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .ok_or_else(|| AppError::BadRequest(format!("integration target `{key}` is required")))
}

fn target_values(config: &Value) -> AppResult<Option<&Vec<Value>>> {
    match config.get("targets") {
        Some(value) => {
            let targets = value.as_array().ok_or_else(|| {
                AppError::BadRequest("integration setting `targets` must be an array".into())
            })?;
            if targets.is_empty() {
                return Err(AppError::BadRequest(
                    "at least one integration target is required".into(),
                ));
            }
            Ok(Some(targets))
        }
        None => Ok(None),
    }
}

fn gitlab_targets(config: &Value) -> AppResult<Vec<GitlabTarget>> {
    let Some(targets) = target_values(config)? else {
        return Ok(vec![GitlabTarget {
            kind: GitlabTargetKind::Project,
            identifier: config_string(config, "project")?.trim().to_string(),
            legacy_external_ids: true,
        }]);
    };
    targets
        .iter()
        .map(|target| {
            let kind = match target_string(target, "kind")? {
                "project" | "repo" | "repository" => GitlabTargetKind::Project,
                "group" => GitlabTargetKind::Group,
                _ => {
                    return Err(AppError::BadRequest(
                        "GitLab target kind must be `project` or `group`".into(),
                    ));
                }
            };
            Ok(GitlabTarget {
                kind,
                identifier: target_string(target, "identifier")?.to_string(),
                legacy_external_ids: target
                    .get("legacyExternalIds")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn huly_targets(config: &Value) -> AppResult<Vec<HulyTarget>> {
    let Some(targets) = target_values(config)? else {
        return Ok(vec![HulyTarget {
            workspace: config_string(config, "workspace")?.trim().to_string(),
            project: config_string(config, "project")?.trim().to_string(),
            legacy_external_ids: true,
        }]);
    };
    targets
        .iter()
        .map(|target| {
            Ok(HulyTarget {
                workspace: target_string(target, "workspace")?.to_string(),
                project: target_string(target, "project")?.to_string(),
                legacy_external_ids: target
                    .get("legacyExternalIds")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn json_identifier(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

async fn fetch_gitlab(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    let base = integration
        .config
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://gitlab.com");
    let token = config_string(&integration.config, "token")?;
    let targets = gitlab_targets(&integration.config)?;
    let client = Client::new();
    let mut imported = Vec::new();

    for target in targets {
        let mut url =
            Url::parse(base).map_err(|_| AppError::BadRequest("GitLab URL is invalid".into()))?;
        let resource = match target.kind {
            GitlabTargetKind::Project => "projects",
            GitlabTargetKind::Group => "groups",
        };
        {
            let mut segments = url.path_segments_mut().map_err(|_| {
                AppError::BadRequest("GitLab URL cannot be used as a base URL".into())
            })?;
            segments
                .pop_if_empty()
                .extend(["api", "v4", resource, &target.identifier, "issues"]);
        }
        url.query_pairs_mut()
            .append_pair("state", "opened")
            .append_pair("scope", "all")
            .append_pair("per_page", "100");
        let response = client
            .get(url)
            .header("PRIVATE-TOKEN", token)
            .send()
            .await
            .map_err(|error| AppError::Internal(format!("GitLab request failed: {error}")))?;
        if !response.status().is_success() {
            return Err(AppError::BadRequest(format!(
                "GitLab returned {} for {} `{}`",
                response.status(),
                resource.trim_end_matches('s'),
                target.identifier
            )));
        }
        let issues = response
            .json::<Vec<Value>>()
            .await
            .map_err(|error| AppError::Internal(format!("invalid GitLab response: {error}")))?;
        imported.extend(issues.into_iter().filter_map(|issue| {
            let iid = issue.get("iid").and_then(json_identifier)?;
            let external_id = if !target.legacy_external_ids {
                issue
                    .get("id")
                    .and_then(json_identifier)
                    .map(|id| format!("issue:{id}"))
                    .unwrap_or_else(|| format!("{}:{}:{iid}", resource, target.identifier))
            } else {
                iid.clone()
            };
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
                external_id,
                title,
                description,
                external_url: issue
                    .get("web_url")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        }));
    }
    Ok(imported)
}

async fn fetch_huly(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    // Huly exposes issues through its official SDK. This provider calls a small Huly
    // connector endpoint so self-hosted and cloud deployments can use the same adapter.
    let endpoint = config_string(&integration.config, "endpoint")?;
    let token = config_string(&integration.config, "token")?;
    let targets = huly_targets(&integration.config)?;
    let client = Client::new();
    let mut imported = Vec::new();

    for target in targets {
        let response = client
            .get(endpoint)
            .bearer_auth(token)
            .query(&[
                ("workspace", target.workspace.as_str()),
                ("project", target.project.as_str()),
                ("state", "open"),
            ])
            .send()
            .await
            .map_err(|error| {
                AppError::Internal(format!("Huly connector request failed: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(AppError::BadRequest(format!(
                "Huly connector returned {} for project `{}` in workspace `{}`",
                response.status(),
                target.project,
                target.workspace
            )));
        }
        let value = response.json::<Value>().await.map_err(|error| {
            AppError::Internal(format!("invalid Huly connector response: {error}"))
        })?;
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
        imported.extend(issues.into_iter().filter_map(|issue| {
            let raw_external_id = issue
                .get("identifier")
                .or_else(|| issue.get("id"))
                .or_else(|| issue.get("_id"))
                .and_then(json_identifier)?;
            let external_id = if !target.legacy_external_ids {
                format!(
                    "workspace:{}:project:{}:{raw_external_id}",
                    target.workspace, target.project
                )
            } else {
                raw_external_id
            };
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
        }));
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_legacy_single_project_configs_working() {
        assert_eq!(
            gitlab_targets(&json!({"project":"group/repo"})).unwrap(),
            vec![GitlabTarget {
                kind: GitlabTargetKind::Project,
                identifier: "group/repo".into(),
                legacy_external_ids: true,
            }]
        );
        assert_eq!(
            huly_targets(&json!({"workspace":"acme","project":"BOOST"})).unwrap(),
            vec![HulyTarget {
                workspace: "acme".into(),
                project: "BOOST".into(),
                legacy_external_ids: true,
            }]
        );
    }

    #[test]
    fn accepts_multiple_gitlab_projects_and_groups() {
        assert_eq!(
            gitlab_targets(&json!({"targets":[
                {"kind":"project","identifier":"acme/api"},
                {"kind":"group","identifier":"platform"}
            ]}))
            .unwrap(),
            vec![
                GitlabTarget {
                    kind: GitlabTargetKind::Project,
                    identifier: "acme/api".into(),
                    legacy_external_ids: false,
                },
                GitlabTarget {
                    kind: GitlabTargetKind::Group,
                    identifier: "platform".into(),
                    legacy_external_ids: false,
                }
            ]
        );
    }

    #[test]
    fn gitlab_project_paths_are_encoded_as_one_api_segment() {
        let mut url = Url::parse("https://gitlab.com").unwrap();
        url.path_segments_mut().unwrap().extend([
            "api",
            "v4",
            "projects",
            "acme/platform/api",
            "issues",
        ]);
        assert_eq!(
            url.as_str(),
            "https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fapi/issues"
        );
    }

    #[test]
    fn accepts_multiple_huly_workspace_projects() {
        assert_eq!(
            huly_targets(&json!({"targets":[
                {"workspace":"acme","project":"BOOST"},
                {"workspace":"labs","project":"MOBILE"}
            ]}))
            .unwrap(),
            vec![
                HulyTarget {
                    workspace: "acme".into(),
                    project: "BOOST".into(),
                    legacy_external_ids: false,
                },
                HulyTarget {
                    workspace: "labs".into(),
                    project: "MOBILE".into(),
                    legacy_external_ids: false,
                }
            ]
        );
    }

    #[test]
    fn rejects_empty_target_lists() {
        assert!(gitlab_targets(&json!({"targets":[]})).is_err());
        assert!(huly_targets(&json!({"targets":[]})).is_err());
    }
}
