use crate::{
    error::{AppError, AppResult},
    git::safe_path,
    models::{FileContent, FileEntry},
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use std::{path::Path, time::UNIX_EPOCH};

pub async fn list(root: &Path, relative: &str) -> AppResult<Vec<FileEntry>> {
    let directory = if relative.is_empty() {
        root.canonicalize()?
    } else {
        safe_path(root, relative, false)?
    };
    if !directory.is_dir() {
        return Err(AppError::BadRequest("path is not a directory".into()));
    }
    let mut reader = tokio::fs::read_dir(&directory).await?;
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let metadata = tokio::fs::symlink_metadata(entry.path()).await?;
        let kind = if metadata.file_type().is_symlink() {
            "symlink"
        } else if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| {
                DateTime::<Utc>::from_timestamp(duration.as_secs() as i64, duration.subsec_nanos())
            })
            .map(|date| date.to_rfc3339());
        entries.push(FileEntry {
            name,
            path,
            kind: kind.into(),
            size: metadata.len(),
            modified_at,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "directory", a.name.to_lowercase())
            .cmp(&(b.kind != "directory", b.name.to_lowercase()))
    });
    Ok(entries)
}

pub async fn read(root: &Path, relative: &str) -> AppResult<FileContent> {
    let path = safe_path(root, relative, false)?;
    if !path.is_file() {
        return Err(AppError::BadRequest("path is not a file".into()));
    }
    let bytes = tokio::fs::read(&path).await?;
    let binary = bytes.iter().take(8192).any(|byte| *byte == 0);
    let content = if binary {
        String::new()
    } else {
        String::from_utf8(bytes.clone())
            .map_err(|_| AppError::BadRequest("file is not valid UTF-8".into()))?
    };
    Ok(FileContent {
        path: relative.into(),
        content,
        language: language(relative),
        revision: revision(&bytes),
        binary,
    })
}

pub async fn write(
    root: &Path,
    relative: &str,
    content: &str,
    expected_revision: &str,
) -> AppResult<FileContent> {
    let path = safe_path(root, relative, true)?;
    if path.exists() {
        let current = tokio::fs::read(&path).await?;
        if revision(&current) != expected_revision {
            return Err(AppError::Conflict(
                "file changed on disk; reload before saving".into(),
            ));
        }
    } else if !expected_revision.is_empty() {
        return Err(AppError::Conflict("file was removed on disk".into()));
    }
    tokio::fs::write(&path, content.as_bytes()).await?;
    read(root, relative).await
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn language(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "css" => "css",
        "scss" => "scss",
        "html" => "html",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" => "markdown",
        "sh" | "zsh" | "bash" => "shell",
        "sql" => "sql",
        "xml" => "xml",
        _ => "plaintext",
    }
    .into()
}
