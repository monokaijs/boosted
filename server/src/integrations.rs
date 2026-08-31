use crate::{
    error::{AppError, AppResult},
    models::Integration,
};
use reqwest::{
    Client, Response, Url,
    header::{HeaderMap, LINK},
};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, time::Duration};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_GITLAB_PAGES: usize = 100;
const MAX_DISCOVERY_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MAX_ISSUE_RESPONSE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ImportedIssue {
    pub external_id: String,
    pub title: String,
    pub description: String,
    pub external_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationDiscoveryResult {
    pub targets: Vec<DiscoveredIntegrationTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredIntegrationTarget {
    pub kind: String,
    pub identifier: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
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
            gitlab_connection(config)?;
            gitlab_targets(config)?;
        }
        "huly" => {
            huly_connection(config)?;
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

pub async fn discover(provider: &str, config: &Value) -> AppResult<IntegrationDiscoveryResult> {
    tokio::time::timeout(DISCOVERY_TIMEOUT, async {
        match provider {
            "gitlab" => discover_gitlab(config).await,
            "huly" => discover_huly(config).await,
            _ => Err(AppError::BadRequest(
                "unsupported integration provider".into(),
            )),
        }
    })
    .await
    .map_err(|_| AppError::BadRequest("integration discovery timed out".into()))?
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

fn integration_client() -> AppResult<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::Internal(format!("unable to create HTTP client: {error}")))
}

async fn response_json_limited(
    mut response: Response,
    limit: usize,
    context: &str,
) -> AppResult<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(AppError::BadRequest(format!(
            "{context} exceeded the {limit}-byte response limit"
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        AppError::BadRequest(format!("unable to read {context} response: {error}"))
    })? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(AppError::BadRequest(format!(
                "{context} exceeded the {limit}-byte response limit"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|error| AppError::BadRequest(format!("{context} returned invalid JSON: {error}")))
}

fn gitlab_connection<'a>(config: &'a Value) -> AppResult<(Url, &'a str)> {
    let base = config
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://gitlab.com");
    let url = Url::parse(base).map_err(|_| AppError::BadRequest("GitLab URL is invalid".into()))?;
    Ok((url, config_string(config, "token")?))
}

fn huly_connection<'a>(config: &'a Value) -> AppResult<(Url, &'a str)> {
    let endpoint = config_string(config, "endpoint")?;
    let url = Url::parse(endpoint)
        .map_err(|_| AppError::BadRequest("Huly connector endpoint is invalid".into()))?;
    Ok((url, config_string(config, "token")?))
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

fn discovery_identifier(value: &Value) -> Option<String> {
    json_identifier(value)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn first_identifier(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(discovery_identifier))
}

fn first_string(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn finish_discovery(mut targets: Vec<DiscoveredIntegrationTarget>) -> IntegrationDiscoveryResult {
    let mut seen = HashSet::new();
    targets.retain(|target| {
        seen.insert((
            target.kind.clone(),
            target.workspace.clone(),
            target.identifier.clone(),
        ))
    });
    targets.sort_by_cached_key(|target| {
        (
            if target.kind == "group" { 0 } else { 1 },
            target
                .workspace_name
                .as_deref()
                .or(target.workspace.as_deref())
                .unwrap_or("")
                .to_lowercase(),
            target
                .full_path
                .as_deref()
                .unwrap_or(&target.name)
                .to_lowercase(),
            target.name.to_lowercase(),
            target.identifier.clone(),
        )
    });
    IntegrationDiscoveryResult { targets }
}

fn gitlab_discovery_url(base: &Url, resource: &str, page: Option<&str>) -> AppResult<Url> {
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AppError::BadRequest("GitLab URL cannot be used as a base URL".into()))?;
        segments.pop_if_empty().extend(["api", "v4", resource]);
    }
    {
        let mut query = url.query_pairs_mut();
        match resource {
            "projects" => {
                query
                    .append_pair("membership", "true")
                    .append_pair("simple", "true")
                    .append_pair("archived", "false")
                    .append_pair("order_by", "path")
                    .append_pair("sort", "asc")
                    .append_pair("per_page", "100");
            }
            "groups" => {
                query
                    .append_pair("min_access_level", "10")
                    .append_pair("order_by", "path")
                    .append_pair("sort", "asc")
                    .append_pair("per_page", "100");
            }
            _ => {
                return Err(AppError::Internal(format!(
                    "unsupported GitLab discovery resource `{resource}`"
                )));
            }
        }
        if let Some(page) = page {
            query.append_pair("page", page);
        }
    }
    Ok(url)
}

fn gitlab_link_next_page(headers: &HeaderMap, current_url: &Url) -> AppResult<Option<String>> {
    for value in headers.get_all(LINK) {
        let value = value
            .to_str()
            .map_err(|_| AppError::BadRequest("GitLab returned an invalid Link header".into()))?;
        for entry in value.split(',') {
            let mut parts = entry.split(';');
            let Some(target) = parts.next().map(str::trim) else {
                continue;
            };
            let is_next = parts.any(|part| {
                let relation = part.trim().to_ascii_lowercase();
                relation == "rel=next" || relation == "rel=\"next\""
            });
            if !is_next {
                continue;
            }
            let target = target
                .strip_prefix('<')
                .and_then(|value| value.strip_suffix('>'))
                .ok_or_else(|| {
                    AppError::BadRequest("GitLab returned an invalid next-page Link".into())
                })?;
            let next_url = current_url.join(target).map_err(|_| {
                AppError::BadRequest("GitLab returned an invalid next-page URL".into())
            })?;
            if next_url.origin() != current_url.origin() || next_url.path() != current_url.path() {
                return Err(AppError::BadRequest(
                    "GitLab returned an unsafe next-page URL".into(),
                ));
            }
            return next_url
                .query_pairs()
                .find_map(|(key, value)| {
                    (key == "page" && !value.trim().is_empty()).then(|| value.into_owned())
                })
                .map(Some)
                .ok_or_else(|| {
                    AppError::BadRequest(
                        "GitLab next-page URL does not contain a page number".into(),
                    )
                });
        }
    }
    Ok(None)
}

fn gitlab_next_page(headers: &HeaderMap, current_url: &Url) -> AppResult<Option<String>> {
    if let Some(page) = gitlab_link_next_page(headers, current_url)? {
        return Ok(Some(page));
    }
    match headers.get("x-next-page") {
        Some(value) => {
            let value = value.to_str().map_err(|_| {
                AppError::BadRequest("GitLab returned an invalid X-Next-Page header".into())
            })?;
            Ok((!value.trim().is_empty()).then(|| value.trim().to_string()))
        }
        None => Ok(None),
    }
}

async fn fetch_gitlab_discovery_resource(
    client: &Client,
    base: &Url,
    token: &str,
    resource: &str,
) -> AppResult<Vec<Value>> {
    let mut items = Vec::new();
    let mut page = None;
    let mut seen_pages = HashSet::from(["1".to_string()]);
    let mut pages_read = 0;

    loop {
        let url = gitlab_discovery_url(base, resource, page.as_deref())?;
        let current_url = url.clone();
        let response = client
            .get(url)
            .header("PRIVATE-TOKEN", token)
            .send()
            .await
            .map_err(|error| {
                AppError::Internal(format!("GitLab discovery request failed: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(AppError::BadRequest(format!(
                "GitLab returned {} while discovering {resource}",
                response.status()
            )));
        }
        let next_page = gitlab_next_page(response.headers(), &current_url)?;
        let value = response_json_limited(
            response,
            MAX_DISCOVERY_RESPONSE_BYTES,
            &format!("GitLab {resource} discovery"),
        )
        .await?;
        let page_items = value.as_array().ok_or_else(|| {
            AppError::BadRequest(format!(
                "GitLab discovery response for {resource} must be an array"
            ))
        })?;
        items.extend(page_items.iter().cloned());
        pages_read += 1;

        let Some(next_page) = next_page else {
            break;
        };
        if pages_read >= MAX_GITLAB_PAGES {
            return Err(AppError::BadRequest(format!(
                "GitLab {resource} discovery exceeded the {MAX_GITLAB_PAGES}-page limit"
            )));
        }
        if !seen_pages.insert(next_page.clone()) {
            return Err(AppError::BadRequest(format!(
                "GitLab returned a repeated discovery page `{next_page}` for {resource}"
            )));
        }
        page = Some(next_page);
    }

    Ok(items)
}

fn parse_gitlab_discovery_targets(
    resource: &str,
    items: &[Value],
) -> AppResult<Vec<DiscoveredIntegrationTarget>> {
    let (kind, path_keys): (&str, &[&str]) = match resource {
        "projects" => ("project", &["path_with_namespace", "full_path"]),
        "groups" => ("group", &["full_path", "path"]),
        _ => {
            return Err(AppError::Internal(format!(
                "unsupported GitLab discovery resource `{resource}`"
            )));
        }
    };

    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let object = item.as_object().ok_or_else(|| {
                AppError::BadRequest(format!(
                    "GitLab {kind} discovery item {} must be an object",
                    index + 1
                ))
            })?;
            let identifier = first_identifier(object, &["id"]).ok_or_else(|| {
                AppError::BadRequest(format!(
                    "GitLab {kind} discovery item {} is missing an id",
                    index + 1
                ))
            })?;
            let name = first_string(object, &["name"]).ok_or_else(|| {
                AppError::BadRequest(format!(
                    "GitLab {kind} discovery item `{identifier}` is missing a name"
                ))
            })?;
            Ok(DiscoveredIntegrationTarget {
                kind: kind.into(),
                identifier,
                name,
                full_path: first_string(object, path_keys),
                workspace: None,
                workspace_name: None,
                web_url: first_string(object, &["web_url", "webUrl", "url"]),
            })
        })
        .collect()
}

async fn discover_gitlab(config: &Value) -> AppResult<IntegrationDiscoveryResult> {
    let (base, token) = gitlab_connection(config)?;
    let client = integration_client()?;
    let (projects, groups) = tokio::try_join!(
        fetch_gitlab_discovery_resource(&client, &base, token, "projects"),
        fetch_gitlab_discovery_resource(&client, &base, token, "groups"),
    )?;
    let mut targets = parse_gitlab_discovery_targets("projects", &projects)?;
    targets.extend(parse_gitlab_discovery_targets("groups", &groups)?);
    Ok(finish_discovery(targets))
}

fn parse_huly_workspaces(workspaces: &[Value]) -> AppResult<Vec<DiscoveredIntegrationTarget>> {
    let mut targets = Vec::new();
    for (workspace_index, workspace) in workspaces.iter().enumerate() {
        let object = workspace.as_object().ok_or_else(|| {
            AppError::BadRequest(format!(
                "Huly discovery workspace {} must be an object",
                workspace_index + 1
            ))
        })?;
        let workspace_id =
            first_identifier(object, &["id", "_id", "identifier", "slug", "workspace"])
                .ok_or_else(|| {
                    AppError::BadRequest(format!(
                        "Huly discovery workspace {} is missing an id",
                        workspace_index + 1
                    ))
                })?;
        let workspace_name = first_string(object, &["name", "workspaceName", "title"])
            .unwrap_or_else(|| workspace_id.clone());
        let projects = object
            .get("projects")
            .ok_or_else(|| {
                AppError::BadRequest(format!(
                    "Huly discovery workspace `{workspace_id}` is missing its projects array"
                ))
            })?
            .as_array()
            .ok_or_else(|| {
                AppError::BadRequest(format!(
                    "Huly discovery projects for workspace `{workspace_id}` must be an array"
                ))
            })?;
        for (project_index, project) in projects.iter().enumerate() {
            let project = project.as_object().ok_or_else(|| {
                AppError::BadRequest(format!(
                    "Huly discovery project {} in workspace `{workspace_id}` must be an object",
                    project_index + 1
                ))
            })?;
            let identifier = first_identifier(project, &["id", "_id", "identifier", "project"])
                .ok_or_else(|| {
                    AppError::BadRequest(format!(
                        "Huly discovery project {} in workspace `{workspace_id}` is missing an id",
                        project_index + 1
                    ))
                })?;
            let name =
                first_string(project, &["name", "title"]).unwrap_or_else(|| identifier.clone());
            targets.push(DiscoveredIntegrationTarget {
                kind: "project".into(),
                identifier,
                name,
                full_path: first_string(project, &["fullPath", "full_path", "path"]),
                workspace: Some(workspace_id.clone()),
                workspace_name: Some(workspace_name.clone()),
                web_url: first_string(project, &["url", "webUrl", "web_url"]),
            });
        }
    }
    Ok(targets)
}

fn parse_flat_huly_target(value: &Value, index: usize) -> AppResult<DiscoveredIntegrationTarget> {
    let object = value.as_object().ok_or_else(|| {
        AppError::BadRequest(format!(
            "Huly discovery target {} must be an object",
            index + 1
        ))
    })?;

    let (workspace, nested_workspace_name) = match object.get("workspace") {
        Some(Value::Object(workspace)) => (
            first_identifier(workspace, &["id", "_id", "identifier", "slug", "workspace"]),
            first_string(workspace, &["name", "title"]),
        ),
        Some(workspace) => (discovery_identifier(workspace), None),
        None => (
            first_identifier(object, &["workspaceId", "workspace_id"]),
            None,
        ),
    };
    let workspace = workspace.ok_or_else(|| {
        AppError::BadRequest(format!(
            "Huly discovery target {} is missing a workspace id",
            index + 1
        ))
    })?;
    let workspace_name = first_string(object, &["workspaceName", "workspace_name"])
        .or(nested_workspace_name)
        .unwrap_or_else(|| workspace.clone());

    let (identifier, nested_project_name, nested_full_path, nested_web_url) =
        match object.get("project") {
            Some(Value::Object(project)) => (
                first_identifier(project, &["id", "_id", "identifier", "project"]),
                first_string(project, &["name", "title"]),
                first_string(project, &["fullPath", "full_path", "path"]),
                first_string(project, &["url", "webUrl", "web_url"]),
            ),
            Some(project) => (discovery_identifier(project), None, None, None),
            None => (
                first_identifier(
                    object,
                    &["projectId", "project_id", "id", "_id", "identifier"],
                ),
                None,
                None,
                None,
            ),
        };
    let identifier = identifier.ok_or_else(|| {
        AppError::BadRequest(format!(
            "Huly discovery target {} is missing a project id",
            index + 1
        ))
    })?;
    let name = first_string(object, &["name", "projectName", "project_name", "title"])
        .or(nested_project_name)
        .unwrap_or_else(|| identifier.clone());

    Ok(DiscoveredIntegrationTarget {
        kind: "project".into(),
        identifier,
        name,
        full_path: first_string(object, &["fullPath", "full_path", "path"]).or(nested_full_path),
        workspace: Some(workspace),
        workspace_name: Some(workspace_name),
        web_url: first_string(object, &["url", "webUrl", "web_url"]).or(nested_web_url),
    })
}

fn parse_huly_discovery_targets(value: &Value) -> AppResult<Vec<DiscoveredIntegrationTarget>> {
    if let Some(object) = value.as_object() {
        if let Some(workspaces) = object.get("workspaces") {
            let workspaces = workspaces.as_array().ok_or_else(|| {
                AppError::BadRequest(
                    "Huly discovery response field `workspaces` must be an array".into(),
                )
            })?;
            return parse_huly_workspaces(workspaces);
        }
        if let Some(targets) = object.get("targets") {
            let targets = targets.as_array().ok_or_else(|| {
                AppError::BadRequest(
                    "Huly discovery response field `targets` must be an array".into(),
                )
            })?;
            return targets
                .iter()
                .enumerate()
                .map(|(index, target)| parse_flat_huly_target(target, index))
                .collect();
        }
        if let Some(data) = object.get("data") {
            return parse_huly_discovery_targets(data);
        }
    } else if let Some(targets) = value.as_array() {
        return targets
            .iter()
            .enumerate()
            .map(|(index, target)| parse_flat_huly_target(target, index))
            .collect();
    }

    Err(AppError::BadRequest(
        "Huly discovery response must contain a `workspaces` or `targets` array".into(),
    ))
}

async fn discover_huly(config: &Value) -> AppResult<IntegrationDiscoveryResult> {
    let (endpoint, token) = huly_connection(config)?;
    let response = integration_client()?
        .get(endpoint)
        .bearer_auth(token)
        .query(&[("action", "discover")])
        .send()
        .await
        .map_err(|error| {
            AppError::Internal(format!("Huly connector discovery request failed: {error}"))
        })?;
    if !response.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "Huly connector returned {} while discovering workspaces and projects",
            response.status()
        )));
    }
    let value = response_json_limited(
        response,
        MAX_DISCOVERY_RESPONSE_BYTES,
        "Huly connector discovery",
    )
    .await?;
    Ok(finish_discovery(parse_huly_discovery_targets(&value)?))
}

fn gitlab_issues_url(
    base: &Url,
    resource: &str,
    identifier: &str,
    page: Option<&str>,
) -> AppResult<Url> {
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AppError::BadRequest("GitLab URL cannot be used as a base URL".into()))?;
        segments
            .pop_if_empty()
            .extend(["api", "v4", resource, identifier, "issues"]);
    }
    let mut query = url.query_pairs_mut();
    query
        .append_pair("state", "opened")
        .append_pair("scope", "all")
        .append_pair("per_page", "100");
    if let Some(page) = page {
        query.append_pair("page", page);
    }
    drop(query);
    Ok(url)
}

fn parse_gitlab_issue(
    issue: Value,
    target: &GitlabTarget,
    resource: &str,
) -> Option<ImportedIssue> {
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
}

async fn fetch_gitlab(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    let (base, token) = gitlab_connection(&integration.config)?;
    let targets = gitlab_targets(&integration.config)?;
    let client = integration_client()?;
    let mut imported = Vec::new();

    for target in targets {
        let resource = match &target.kind {
            GitlabTargetKind::Project => "projects",
            GitlabTargetKind::Group => "groups",
        };
        let mut page = None;
        let mut seen_pages = HashSet::from(["1".to_string()]);
        let mut pages_read = 0;
        loop {
            let url = gitlab_issues_url(&base, resource, &target.identifier, page.as_deref())?;
            let current_url = url.clone();
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
            let next_page = gitlab_next_page(response.headers(), &current_url)?;
            let value = response_json_limited(
                response,
                MAX_ISSUE_RESPONSE_BYTES,
                &format!("GitLab issues for {resource} `{}`", target.identifier),
            )
            .await?;
            let issues = value.as_array().ok_or_else(|| {
                AppError::BadRequest(format!(
                    "GitLab issues response for {resource} `{}` must be an array",
                    target.identifier
                ))
            })?;
            imported.extend(
                issues
                    .iter()
                    .cloned()
                    .filter_map(|issue| parse_gitlab_issue(issue, &target, resource)),
            );
            pages_read += 1;

            let Some(next_page) = next_page else {
                break;
            };
            if pages_read >= MAX_GITLAB_PAGES {
                return Err(AppError::BadRequest(format!(
                    "GitLab issues for {resource} `{}` exceeded the {MAX_GITLAB_PAGES}-page limit",
                    target.identifier
                )));
            }
            if !seen_pages.insert(next_page.clone()) {
                return Err(AppError::BadRequest(format!(
                    "GitLab returned a repeated issue page `{next_page}` for {resource} `{}`",
                    target.identifier
                )));
            }
            page = Some(next_page);
        }
    }
    Ok(imported)
}

async fn fetch_huly(integration: &Integration) -> AppResult<Vec<ImportedIssue>> {
    // Huly exposes issues through its official SDK. This provider calls a small Huly
    // connector endpoint so self-hosted and cloud deployments can use the same adapter.
    let endpoint = config_string(&integration.config, "endpoint")?;
    let token = config_string(&integration.config, "token")?;
    let targets = huly_targets(&integration.config)?;
    let client = integration_client()?;
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
        let value = response_json_limited(
            response,
            MAX_ISSUE_RESPONSE_BYTES,
            &format!(
                "Huly issues for project `{}` in workspace `{}`",
                target.project, target.workspace
            ),
        )
        .await?;
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
    use axum::{
        Json, Router,
        extract::Query,
        http::{HeaderMap as AxumHeaderMap, StatusCode, header::AUTHORIZATION},
        response::IntoResponse,
        routing::get,
    };
    use serde_json::json;
    use std::collections::HashMap;

    async fn mock_gitlab_projects(
        headers: AxumHeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> axum::response::Response {
        if headers
            .get("private-token")
            .and_then(|value| value.to_str().ok())
            != Some("gitlab-token")
            || query.get("membership").map(String::as_str) != Some("true")
            || query.get("archived").map(String::as_str) != Some("false")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let page = query.get("page").map(String::as_str).unwrap_or("1");
        let mut response = match page {
            "1" => Json(json!([{"id":1,"name":"One","path_with_namespace":"acme/one"}]))
                .into_response(),
            "2" => Json(json!([{"id":2,"name":"Two","path_with_namespace":"acme/two"}]))
                .into_response(),
            _ => return StatusCode::BAD_REQUEST.into_response(),
        };
        if page == "1" {
            response.headers_mut().insert(
                LINK,
                axum::http::HeaderValue::from_static(
                    "</api/v4/projects?membership=true&simple=true&archived=false&order_by=path&sort=asc&per_page=100&page=2>; rel=\"next\"",
                ),
            );
        }
        response
    }

    async fn mock_gitlab_groups(
        headers: AxumHeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> axum::response::Response {
        if headers
            .get("private-token")
            .and_then(|value| value.to_str().ok())
            != Some("gitlab-token")
            || query.get("min_access_level").map(String::as_str) != Some("10")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Json(json!([{"id":7,"name":"Acme","full_path":"acme"}])).into_response()
    }

    async fn mock_huly_discovery(
        headers: AxumHeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> axum::response::Response {
        if headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            != Some("Bearer huly-token")
            || query.get("action").map(String::as_str) != Some("discover")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Json(json!({
            "workspaces": [{
                "id": "acme",
                "name": "Acme",
                "projects": [{"id":"BOOST","name":"Boosted"}]
            }]
        }))
        .into_response()
    }

    async fn mock_gitlab_group_issues(
        headers: AxumHeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> axum::response::Response {
        if headers
            .get("private-token")
            .and_then(|value| value.to_str().ok())
            != Some("gitlab-token")
            || query.get("state").map(String::as_str) != Some("opened")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let page = query.get("page").map(String::as_str).unwrap_or("1");
        let mut response =
            match page {
                "1" => Json(json!([{"id":101,"iid":1,"title":"First","description":""}]))
                    .into_response(),
                "2" => Json(json!([{"id":102,"iid":2,"title":"Second","description":""}]))
                    .into_response(),
                _ => return StatusCode::BAD_REQUEST.into_response(),
            };
        if page == "1" {
            response.headers_mut().insert(
                LINK,
                axum::http::HeaderValue::from_static(
                    "</api/v4/groups/7/issues?state=opened&scope=all&per_page=100&page=2>; rel=\"next\"",
                ),
            );
        }
        response
    }

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

    #[test]
    fn builds_gitlab_discovery_urls_for_projects_and_groups() {
        let base = Url::parse("https://gitlab.example/gitlab/?old=query#fragment").unwrap();
        assert_eq!(
            gitlab_discovery_url(&base, "projects", None)
                .unwrap()
                .as_str(),
            "https://gitlab.example/gitlab/api/v4/projects?membership=true&simple=true&archived=false&order_by=path&sort=asc&per_page=100"
        );
        assert_eq!(
            gitlab_discovery_url(&base, "groups", Some("3"))
                .unwrap()
                .as_str(),
            "https://gitlab.example/gitlab/api/v4/groups?min_access_level=10&order_by=path&sort=asc&per_page=100&page=3"
        );
    }

    #[tokio::test]
    async fn discovers_gitlab_pages_and_huly_targets_over_the_connector_contract() {
        let app = Router::new()
            .route("/api/v4/projects", get(mock_gitlab_projects))
            .route("/api/v4/groups", get(mock_gitlab_groups))
            .route("/api/v4/groups/7/issues", get(mock_gitlab_group_issues))
            .route("/huly", get(mock_huly_discovery));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let gitlab = discover(
            "gitlab",
            &json!({"baseUrl":format!("http://{address}"),"token":"gitlab-token"}),
        )
        .await
        .unwrap();
        assert_eq!(gitlab.targets.len(), 3);
        assert_eq!(gitlab.targets[0].identifier, "7");
        assert_eq!(gitlab.targets[1].identifier, "1");
        assert_eq!(gitlab.targets[2].identifier, "2");

        let huly = discover(
            "huly",
            &json!({"endpoint":format!("http://{address}/huly"),"token":"huly-token"}),
        )
        .await
        .unwrap();
        assert_eq!(huly.targets.len(), 1);
        assert_eq!(huly.targets[0].workspace.as_deref(), Some("acme"));
        assert_eq!(huly.targets[0].identifier, "BOOST");

        let integration = Integration {
            id: "integration".into(),
            project_id: "project".into(),
            provider: "gitlab".into(),
            name: "GitLab".into(),
            config: json!({
                "baseUrl":format!("http://{address}"),
                "token":"gitlab-token",
                "targets":[{"kind":"group","identifier":"7"}]
            }),
            enabled: true,
            sync_interval_minutes: None,
            last_synced_at: None,
            last_sync_status: None,
            last_sync_error: None,
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        let issues = fetch_issues(&integration).await.unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].external_id, "issue:101");
        assert_eq!(issues[1].external_id, "issue:102");

        server.abort();
    }

    #[test]
    fn follows_safe_gitlab_link_pagination_with_x_header_fallback() {
        let current = Url::parse(
            "https://gitlab.example/api/v4/projects?membership=true&per_page=100&page=1",
        )
        .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            LINK,
            reqwest::header::HeaderValue::from_static(
                "<https://gitlab.example/api/v4/projects?membership=true&per_page=100&page=2>; rel=\"next\", <https://gitlab.example/api/v4/projects?page=5>; rel=\"last\"",
            ),
        );
        headers.insert(
            "x-next-page",
            reqwest::header::HeaderValue::from_static("9"),
        );
        assert_eq!(
            gitlab_next_page(&headers, &current).unwrap().as_deref(),
            Some("2")
        );

        headers.remove(LINK);
        assert_eq!(
            gitlab_next_page(&headers, &current).unwrap().as_deref(),
            Some("9")
        );

        headers.insert(
            LINK,
            reqwest::header::HeaderValue::from_static(
                "<https://attacker.example/api/v4/projects?page=2>; rel=\"next\"",
            ),
        );
        assert!(gitlab_next_page(&headers, &current).is_err());
    }

    #[test]
    fn builds_paginated_gitlab_issue_urls() {
        let base = Url::parse("https://gitlab.example/root/").unwrap();
        assert_eq!(
            gitlab_issues_url(&base, "groups", "42", Some("3"))
                .unwrap()
                .as_str(),
            "https://gitlab.example/root/api/v4/groups/42/issues?state=opened&scope=all&per_page=100&page=3"
        );
    }

    #[test]
    fn normalizes_deduplicates_and_sorts_gitlab_discovery_targets() {
        let mut targets = parse_gitlab_discovery_targets(
            "projects",
            &[
                json!({"id":22,"name":"Web","path_with_namespace":"acme/web","web_url":"https://gitlab.example/acme/web"}),
                json!({"id":11,"name":"API","path_with_namespace":"acme/api"}),
                json!({"id":11,"name":"API duplicate","path_with_namespace":"acme/api"}),
            ],
        )
        .unwrap();
        targets.extend(
            parse_gitlab_discovery_targets(
                "groups",
                &[json!({"id":7,"name":"Acme","full_path":"acme","web_url":"https://gitlab.example/groups/acme"})],
            )
            .unwrap(),
        );

        let result = finish_discovery(targets);

        assert_eq!(result.targets.len(), 3);
        assert_eq!(result.targets[0].kind, "group");
        assert_eq!(result.targets[0].identifier, "7");
        assert_eq!(result.targets[1].identifier, "11");
        assert_eq!(result.targets[1].full_path.as_deref(), Some("acme/api"));
        assert_eq!(result.targets[2].identifier, "22");
    }

    #[test]
    fn parses_nested_huly_discovery_payloads() {
        let result = finish_discovery(
            parse_huly_discovery_targets(&json!({
                "workspaces": [
                    {
                        "id": "labs",
                        "name": "Labs",
                        "projects": [{"id":"mobile","name":"Mobile","url":"https://huly.example/labs/mobile"}]
                    },
                    {
                        "id": 42,
                        "name": "Acme",
                        "projects": [{"id":17,"name":"Boosted","fullPath":"Acme / Boosted"}]
                    }
                ]
            }))
            .unwrap(),
        );

        assert_eq!(result.targets.len(), 2);
        assert_eq!(result.targets[0].identifier, "17");
        assert_eq!(result.targets[0].workspace.as_deref(), Some("42"));
        assert_eq!(result.targets[0].workspace_name.as_deref(), Some("Acme"));
        assert_eq!(
            result.targets[0].full_path.as_deref(),
            Some("Acme / Boosted")
        );
        assert_eq!(result.targets[1].identifier, "mobile");
        assert_eq!(
            result.targets[1].web_url.as_deref(),
            Some("https://huly.example/labs/mobile")
        );
    }

    #[test]
    fn accepts_huly_workspace_and_project_aliases_without_display_names() {
        let result = finish_discovery(
            parse_huly_discovery_targets(&json!({
                "workspaces": [{
                    "workspace": "acme",
                    "projects": [{"project":"BOOST"}]
                }]
            }))
            .unwrap(),
        );

        assert_eq!(result.targets.len(), 1);
        assert_eq!(result.targets[0].workspace.as_deref(), Some("acme"));
        assert_eq!(result.targets[0].workspace_name.as_deref(), Some("acme"));
        assert_eq!(result.targets[0].identifier, "BOOST");
        assert_eq!(result.targets[0].name, "BOOST");
    }

    #[test]
    fn parses_wrapped_flat_huly_discovery_payloads() {
        let result = finish_discovery(
            parse_huly_discovery_targets(&json!({
                "data": {
                    "targets": [
                        {"workspace":"labs","workspaceName":"Labs","project":"mobile","name":"Mobile"},
                        {
                            "workspace":{"id":"acme","name":"Acme"},
                            "project":{"id":"boost","name":"Boosted","webUrl":"https://huly.example/acme/boost"}
                        }
                    ]
                }
            }))
            .unwrap(),
        );

        assert_eq!(result.targets.len(), 2);
        assert_eq!(result.targets[0].identifier, "boost");
        assert_eq!(result.targets[0].workspace.as_deref(), Some("acme"));
        assert_eq!(result.targets[0].name, "Boosted");
        assert_eq!(result.targets[1].identifier, "mobile");
    }

    #[test]
    fn accepts_empty_huly_discovery_arrays_and_rejects_malformed_payloads() {
        assert!(
            parse_huly_discovery_targets(&json!({"workspaces":[]}))
                .unwrap()
                .is_empty()
        );
        assert!(
            parse_huly_discovery_targets(&json!({"data":{"targets":[]}}))
                .unwrap()
                .is_empty()
        );
        let error = parse_huly_discovery_targets(&json!({"data":{"unexpected":[]}}))
            .unwrap_err()
            .to_string();
        assert!(error.contains("workspaces"));
        assert!(error.contains("targets"));
        assert!(parse_huly_discovery_targets(&json!({"workspaces":{}})).is_err());
    }

    #[test]
    fn serializes_optional_discovery_metadata_as_camel_case() {
        let value = serde_json::to_value(DiscoveredIntegrationTarget {
            kind: "project".into(),
            identifier: "17".into(),
            name: "Boosted".into(),
            full_path: Some("Acme / Boosted".into()),
            workspace: Some("42".into()),
            workspace_name: Some("Acme".into()),
            web_url: None,
        })
        .unwrap();

        assert_eq!(value["fullPath"], "Acme / Boosted");
        assert_eq!(value["workspaceName"], "Acme");
        assert!(value.get("full_path").is_none());
        assert!(value.get("webUrl").is_none());
    }
}
