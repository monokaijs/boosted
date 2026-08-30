use crate::{
    error::{AppError, AppResult},
    models::{GitChange, GitCommit, GitStatus},
    process::background_command,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
};

async fn git(repo: &Path, args: &[&str]) -> AppResult<String> {
    let output = background_command("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| AppError::Internal(format!("unable to run Git: {error}")))?;
    if !output.status.success() {
        return Err(AppError::BadRequest(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub async fn repository_root(path: &Path) -> AppResult<PathBuf> {
    let root = git(path, &["rev-parse", "--show-toplevel"]).await?;
    PathBuf::from(root.trim())
        .canonicalize()
        .map_err(AppError::from)
}

pub async fn current_branch(path: &Path) -> AppResult<String> {
    let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .unwrap_or_else(|_| "HEAD".into());
    Ok(branch.trim().to_string())
}

pub async fn branches(repo: &Path) -> AppResult<Vec<String>> {
    let raw = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=refname",
            "refs/heads",
        ],
    )
    .await?;
    Ok(raw
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(str::to_string)
        .collect())
}

pub async fn create_worktree(
    repo: &Path,
    path: &Path,
    branch: &str,
    base_branch: &str,
) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    git(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            path.to_string_lossy().as_ref(),
            base_branch,
        ],
    )
    .await?;
    Ok(())
}

pub async fn status(repo: &Path) -> AppResult<GitStatus> {
    let raw = git(
        repo,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )
    .await?;
    let pieces = raw
        .split('\0')
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let branch_line = pieces.first().copied().unwrap_or("## HEAD");
    let branch = branch_line
        .trim_start_matches("## ")
        .split("...")
        .next()
        .unwrap_or("HEAD")
        .trim()
        .to_string();
    let ahead = parse_counter(branch_line, "ahead ");
    let behind = parse_counter(branch_line, "behind ");
    let mut counts = diff_counts(repo).await.unwrap_or_default();
    let mut changes = Vec::new();
    let mut index = 1;
    while index < pieces.len() {
        let line = pieces[index];
        index += 1;
        if line.len() < 3 {
            continue;
        }
        let mut chars = line.chars();
        let index_status = chars.next().unwrap_or(' ').to_string();
        let worktree_status = chars.next().unwrap_or(' ').to_string();
        let path = line[3..].to_string();
        if matches!(index_status.as_str(), "R" | "C")
            || matches!(worktree_status.as_str(), "R" | "C")
        {
            index += usize::from(index < pieces.len());
        }
        let (additions, deletions) = if index_status == "?" && worktree_status == "?" {
            (
                untracked_line_count(&safe_path(repo, &path, false)?)
                    .await
                    .unwrap_or(0),
                0,
            )
        } else {
            counts.remove(&path).unwrap_or((0, 0))
        };
        changes.push(GitChange {
            path,
            index_status,
            worktree_status,
            additions,
            deletions,
        });
    }
    Ok(GitStatus {
        branch,
        ahead,
        behind,
        changes,
    })
}

async fn untracked_line_count(path: &Path) -> AppResult<i64> {
    if !path.is_file() {
        return Ok(0);
    }
    let bytes = tokio::fs::read(path).await?;
    if bytes.contains(&0) {
        return Ok(0);
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as i64;
    Ok(newlines + i64::from(!bytes.is_empty() && !bytes.ends_with(b"\n")))
}

fn parse_counter(value: &str, prefix: &str) -> i64 {
    value
        .find(prefix)
        .and_then(|index| {
            value[index + prefix.len()..]
                .split(|ch: char| !ch.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

async fn diff_counts(repo: &Path) -> AppResult<HashMap<String, (i64, i64)>> {
    let mut map = HashMap::new();
    for args in [
        ["diff", "--numstat"].as_slice(),
        ["diff", "--cached", "--numstat"].as_slice(),
    ] {
        let raw = git(repo, args).await?;
        for line in raw.lines() {
            let mut values = line.splitn(3, '\t');
            let additions = values.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            let deletions = values.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            if let Some(path) = values.next() {
                let entry = map.entry(path.to_string()).or_insert((0, 0));
                entry.0 += additions;
                entry.1 += deletions;
            }
        }
    }
    Ok(map)
}

pub async fn diff(repo: &Path, path: Option<&str>, staged: bool) -> AppResult<String> {
    if !staged {
        if let Some(path) = path {
            if status(repo).await?.changes.iter().any(|change| {
                change.path == path && change.index_status == "?" && change.worktree_status == "?"
            }) {
                return untracked_diff(repo, path).await;
            }
        }
    }
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--no-ext-diff", "--"]);
    if let Some(path) = path {
        args.push(path);
    }
    git(repo, &args).await
}

async fn untracked_diff(repo: &Path, relative: &str) -> AppResult<String> {
    let path = safe_path(repo, relative, false)?;
    let bytes = tokio::fs::read(&path).await?;
    if bytes.contains(&0) {
        return Ok(format!("Binary file {relative} is untracked"));
    }
    let content = String::from_utf8_lossy(&bytes);
    let line_count = untracked_line_count(&path).await?;
    let mut output = format!(
        "diff --git a/{relative} b/{relative}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in content.split_inclusive('\n') {
        output.push('+');
        output.push_str(line);
    }
    if !content.is_empty() && !content.ends_with('\n') {
        output.push_str("\n\\ No newline at end of file\n");
    }
    Ok(output)
}

pub async fn stage(repo: &Path, paths: &[String]) -> AppResult<()> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(repo, &args).await?;
    Ok(())
}

pub async fn unstage(repo: &Path, paths: &[String]) -> AppResult<()> {
    let mut args = vec!["reset", "--quiet", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(repo, &args).await?;
    Ok(())
}

pub async fn discard(repo: &Path, paths: &[String]) -> AppResult<()> {
    let state = status(repo).await?;
    for path in paths {
        let change = state
            .changes
            .iter()
            .find(|change| &change.path == path)
            .ok_or_else(|| AppError::NotFound(format!("change not found: {path}")))?;
        let target = safe_path(repo, path, true)?;
        if change.worktree_status == "?" {
            if target.is_dir() {
                tokio::fs::remove_dir_all(&target).await?;
            } else {
                tokio::fs::remove_file(&target).await?;
            }
        } else {
            git(repo, &["restore", "--worktree", "--", path]).await?;
        }
    }
    Ok(())
}

pub async fn commit(repo: &Path, message: &str) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::BadRequest("commit message is required".into()));
    }
    git(repo, &["commit", "-m", message.trim()]).await?;
    Ok(git(repo, &["rev-parse", "HEAD"]).await?.trim().to_string())
}

pub async fn history(repo: &Path, limit: usize) -> AppResult<Vec<GitCommit>> {
    let limit = limit.clamp(1, 500).to_string();
    let raw = git(
        repo,
        &[
            "log",
            "--all",
            "--topo-order",
            &format!("-n{limit}"),
            "--date=iso-strict",
            "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%s%x1f%b%x1f%aI%x1f%D%x1e",
        ],
    )
    .await?;
    Ok(raw
        .split('\x1e')
        .filter_map(|record| {
            let values: Vec<_> = record.trim().split('\x1f').collect();
            if values.len() < 8 {
                return None;
            }
            Some(GitCommit {
                id: values[0].into(),
                parents: values[1].split_whitespace().map(str::to_string).collect(),
                author: values[2].into(),
                email: values[3].into(),
                subject: values[4].into(),
                body: values[5].trim().into(),
                authored_at: values[6].into(),
                refs: values[7]
                    .split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect())
}

pub fn safe_path(root: &Path, relative: &str, allow_missing: bool) -> AppResult<PathBuf> {
    if Path::new(relative).is_absolute() || relative.split(['/', '\\']).any(|part| part == "..") {
        return Err(AppError::BadRequest(
            "path must remain inside the task worktree".into(),
        ));
    }
    let root = root.canonicalize()?;
    let target = root.join(relative);
    let checked = if target.exists() {
        target.canonicalize()?
    } else if allow_missing {
        target
            .parent()
            .ok_or_else(|| AppError::BadRequest("invalid path".into()))?
            .canonicalize()?
            .join(
                target
                    .file_name()
                    .ok_or_else(|| AppError::BadRequest("invalid path".into()))?,
            )
    } else {
        return Err(AppError::NotFound("path not found".into()));
    };
    if !checked.starts_with(&root) {
        return Err(AppError::Forbidden);
    }
    Ok(checked)
}
