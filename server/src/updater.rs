use crate::error::{AppError, AppResult};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

const RELEASE_API: &str = "https://api.github.com/repos/monokaijs/boosted/releases/latest";
const MANAGED_INSTALL_ENV: &str = "BOOSTED_MANAGED_INSTALL";
const CACHE_ROOT_ENV: &str = "BOOSTED_CLI_CACHE_DIR_RESOLVED";
pub const RESTART_EXIT_CODE_ENV: &str = "BOOSTED_UPDATE_EXIT_CODE";
pub const DEFAULT_RESTART_EXIT_CODE: i32 = 75;

#[derive(Clone)]
pub struct ServerUpdater {
    cache_root: Option<PathBuf>,
    unsupported_reason: Option<String>,
    client: reqwest::Client,
    operation: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub supported: bool,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_version: Option<String>,
    pub update_available: bool,
    pub restart_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Serialize)]
struct ActiveRelease<'a> {
    version: &'a str,
}

impl ServerUpdater {
    pub fn from_env() -> Self {
        let managed = std::env::var(MANAGED_INSTALL_ENV).as_deref() == Ok("1");
        let cache_root = std::env::var_os(CACHE_ROOT_ENV).map(PathBuf::from);
        let (cache_root, unsupported_reason) =
            managed_configuration(managed, cache_root, cfg!(feature = "embedded-web"));
        let client = reqwest::Client::builder()
            .user_agent(format!("boosted-server/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the updater HTTP client configuration is valid");
        Self {
            cache_root,
            unsupported_reason,
            client,
            operation: Arc::new(Mutex::new(())),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        UpdateStatus {
            supported: self.cache_root.is_some(),
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            target_version: None,
            update_available: false,
            restart_pending: false,
            reason: self.unsupported_reason.clone(),
        }
    }

    pub async fn check(&self) -> AppResult<UpdateStatus> {
        let release = self.latest_release().await?;
        Ok(self.release_status(&release, false))
    }

    pub async fn install(&self) -> AppResult<UpdateStatus> {
        let _operation = self.operation.try_lock().map_err(|_| {
            AppError::Conflict("another server update is already in progress".into())
        })?;
        let cache_root = self.require_cache_root()?;
        let release = self.latest_release().await?;
        let mut status = self.release_status(&release, false);
        if !status.update_available {
            return Ok(status);
        }

        let target_version = status
            .target_version
            .as_deref()
            .ok_or_else(|| AppError::Internal("the selected release has no version".into()))?;
        let asset_name = release_asset(target_version)?;
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == asset_name)
            .ok_or_else(|| {
                AppError::Internal(format!("GitHub Release does not contain {asset_name}"))
            })?;
        let checksums = release
            .assets
            .iter()
            .find(|asset| asset.name == "SHA256SUMS.txt")
            .ok_or_else(|| {
                AppError::Internal("GitHub Release does not contain SHA256SUMS.txt".into())
            })?;
        let (contents, checksum_contents) = tokio::try_join!(
            self.download(&asset.browser_download_url),
            self.download(&checksums.browser_download_url),
        )?;
        let checksum_text = String::from_utf8(checksum_contents).map_err(AppError::internal)?;
        let expected = expected_checksum(&checksum_text, &asset_name)?;
        let actual = format!("{:x}", Sha256::digest(&contents));
        if actual != expected {
            return Err(AppError::Internal(format!(
                "checksum verification failed for {asset_name}"
            )));
        }

        let version_dir = cache_root.join(target_version);
        tokio::fs::create_dir_all(&version_dir).await?;
        let binary = version_dir.join(binary_name());
        write_binary_atomically(&binary, &contents).await?;
        write_active_release(cache_root, target_version).await?;

        status.restart_pending = true;
        Ok(status)
    }

    fn require_cache_root(&self) -> AppResult<&Path> {
        self.cache_root.as_deref().ok_or_else(|| {
            AppError::BadRequest(
                self.unsupported_reason.clone().unwrap_or_else(|| {
                    "server updates are unavailable for this installation".into()
                }),
            )
        })
    }

    async fn latest_release(&self) -> AppResult<GitHubRelease> {
        self.require_cache_root()?;
        let response = self
            .client
            .get(RELEASE_API)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(AppError::internal)?;
        if !response.status().is_success() {
            return Err(AppError::Internal(format!(
                "GitHub update check failed ({})",
                response.status()
            )));
        }
        response.json().await.map_err(AppError::internal)
    }

    async fn download(&self, url: &str) -> AppResult<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .header("Accept", "application/octet-stream")
            .send()
            .await
            .map_err(AppError::internal)?;
        if !response.status().is_success() {
            return Err(AppError::Internal(format!(
                "update download failed ({})",
                response.status()
            )));
        }
        Ok(response.bytes().await.map_err(AppError::internal)?.to_vec())
    }

    fn release_status(&self, release: &GitHubRelease, restart_pending: bool) -> UpdateStatus {
        let current = Version::parse(env!("CARGO_PKG_VERSION"));
        let target_text = release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name);
        let target = Version::parse(target_text);
        match (current, target) {
            (Ok(current), Ok(target)) => UpdateStatus {
                supported: true,
                current_version: current.to_string(),
                target_version: Some(target.to_string()),
                update_available: target > current,
                restart_pending,
                reason: None,
            },
            (_, Err(error)) => UpdateStatus {
                supported: true,
                current_version: env!("CARGO_PKG_VERSION").to_string(),
                target_version: None,
                update_available: false,
                restart_pending: false,
                reason: Some(format!("latest release has an invalid version: {error}")),
            },
            (Err(error), _) => UpdateStatus {
                supported: true,
                current_version: env!("CARGO_PKG_VERSION").to_string(),
                target_version: None,
                update_available: false,
                restart_pending: false,
                reason: Some(format!("installed version is invalid: {error}")),
            },
        }
    }
}

pub fn restart_exit_code() -> i32 {
    std::env::var(RESTART_EXIT_CODE_ENV)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| (1..=255).contains(value))
        .unwrap_or(DEFAULT_RESTART_EXIT_CODE)
}

fn managed_configuration(
    managed: bool,
    cache_root: Option<PathBuf>,
    embedded_web: bool,
) -> (Option<PathBuf>, Option<String>) {
    if !managed {
        return (
            None,
            Some("Server updates require an npm-managed boosted-cli installation.".into()),
        );
    }
    if !embedded_web {
        return (
            None,
            Some("Server updates are disabled for source and development builds.".into()),
        );
    }
    match cache_root {
        Some(path) if path.is_absolute() => (Some(path), None),
        _ => (
            None,
            Some("The managed CLI did not provide a valid update cache path.".into()),
        ),
    }
}

fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "boosted-cli.exe"
    } else {
        "boosted-cli"
    }
}

fn release_asset(version: &str) -> AppResult<String> {
    let suffix = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("windows", "x86_64") => "windows-x86_64.exe",
        (os, arch) => {
            return Err(AppError::BadRequest(format!(
                "server updates are unsupported on {os}/{arch}"
            )));
        }
    };
    Ok(format!("boosted-{version}-{suffix}"))
}

fn expected_checksum(checksums: &str, asset: &str) -> AppResult<String> {
    checksums
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let checksum = fields.next()?;
            let name = fields.next()?.trim_start_matches('*');
            (checksum.len() == 64
                && checksum.chars().all(|ch| ch.is_ascii_hexdigit())
                && name == asset)
                .then(|| checksum.to_ascii_lowercase())
        })
        .ok_or_else(|| AppError::Internal(format!("SHA256SUMS.txt does not contain {asset}")))
}

async fn write_binary_atomically(path: &Path, contents: &[u8]) -> AppResult<()> {
    let temporary = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("boosted-cli"),
        std::process::id()
    ));
    tokio::fs::write(&temporary, contents).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755)).await?;
    }
    replace_file(&temporary, path).await
}

async fn write_active_release(cache_root: &Path, version: &str) -> AppResult<()> {
    let path = cache_root.join("active.json");
    let temporary = cache_root.join(format!(".active.{}.tmp", std::process::id()));
    let contents = serde_json::to_vec(&ActiveRelease { version })?;
    tokio::fs::write(&temporary, contents).await?;
    replace_file(&temporary, &path).await
}

async fn replace_file(temporary: &Path, destination: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    if tokio::fs::try_exists(destination).await? {
        tokio::fs::remove_file(destination).await?;
    }
    tokio::fs::rename(temporary, destination).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_updates_require_an_absolute_cache_path_and_embedded_ui() {
        assert!(
            managed_configuration(true, Some(PathBuf::from("relative")), true)
                .0
                .is_none()
        );
        assert!(
            managed_configuration(true, Some(PathBuf::from("/tmp/boosted")), false)
                .0
                .is_none()
        );
        assert!(
            managed_configuration(false, Some(PathBuf::from("/tmp/boosted")), true)
                .0
                .is_none()
        );
        assert_eq!(
            managed_configuration(true, Some(PathBuf::from("/tmp/boosted")), true).0,
            Some(PathBuf::from("/tmp/boosted"))
        );
    }

    #[test]
    fn checksum_parser_requires_an_exact_release_asset() {
        let checksum = "a".repeat(64);
        let contents = format!("{checksum}  boosted-1.2.3-linux-x86_64\n");
        assert_eq!(
            expected_checksum(&contents, "boosted-1.2.3-linux-x86_64").unwrap(),
            checksum
        );
        assert!(expected_checksum(&contents, "boosted-1.2.3-darwin-x86_64").is_err());
    }
}
