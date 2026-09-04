use crate::error::{AppError, AppResult};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::sync::Mutex;

const RELEASE_API: &str = "https://api.github.com/repos/monokaijs/boosted/releases/latest";
const MANAGED_INSTALL_ENV: &str = "BOOSTED_MANAGED_INSTALL";
const CACHE_ROOT_ENV: &str = "BOOSTED_CLI_CACHE_DIR_RESOLVED";
const CACHE_ROOT_OVERRIDE_ENV: &str = "BOOSTED_CLI_CACHE_DIR";
const RESTART_DELAY_ENV: &str = "BOOSTED_SELF_RESTART_DELAY_MS";
pub const RESTART_EXIT_CODE_ENV: &str = "BOOSTED_UPDATE_EXIT_CODE";
pub const DEFAULT_RESTART_EXIT_CODE: i32 = 75;

#[derive(Clone, Debug)]
enum InstallMode {
    ManagedLauncher { cache_root: PathBuf },
    Standalone { cache_root: PathBuf },
}

impl InstallMode {
    fn cache_root(&self) -> &Path {
        match self {
            Self::ManagedLauncher { cache_root } | Self::Standalone { cache_root } => cache_root,
        }
    }
}

#[derive(Clone)]
pub struct ServerUpdater {
    mode: Option<InstallMode>,
    unsupported_reason: Option<String>,
    client: reqwest::Client,
    operation: Arc<Mutex<()>>,
    last_status: Arc<RwLock<UpdateStatus>>,
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

#[derive(Debug, Deserialize, Serialize)]
struct ActiveRelease {
    version: String,
}

pub enum RestartAction {
    ManagedLauncher(i32),
    Standalone {
        binary: PathBuf,
        arguments: Vec<OsString>,
    },
}

impl RestartAction {
    /// Replace the server after the response announcing the update reaches the browser.
    /// A successful Unix exec never returns.
    pub fn execute(self) -> std::io::Result<()> {
        match self {
            Self::ManagedLauncher(code) => std::process::exit(code),
            Self::Standalone { binary, arguments } => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt;
                    Err(Command::new(binary).args(arguments).exec())
                }
                #[cfg(windows)]
                {
                    Command::new(binary)
                        .args(arguments)
                        .env(RESTART_DELAY_ENV, "1000")
                        .spawn()?;
                    std::process::exit(0);
                }
                #[cfg(not(any(unix, windows)))]
                {
                    let _ = (binary, arguments);
                    Err(std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "self-restart is unsupported on this platform",
                    ))
                }
            }
        }
    }
}

impl ServerUpdater {
    pub fn from_env() -> Self {
        let managed = std::env::var(MANAGED_INSTALL_ENV).as_deref() == Ok("1");
        let launcher_cache_root = std::env::var_os(CACHE_ROOT_ENV).map(PathBuf::from);
        let standalone_cache_root = std::env::var_os(CACHE_ROOT_OVERRIDE_ENV)
            .map(PathBuf::from)
            .or_else(default_cache_root);
        let (mode, unsupported_reason) = installation_configuration(
            managed,
            launcher_cache_root,
            standalone_cache_root,
            self_update_build(),
            release_target_suffix().is_some(),
        );
        Self::new(mode, unsupported_reason)
    }

    pub fn disabled(reason: impl Into<String>) -> Self {
        Self::new(None, Some(reason.into()))
    }

    fn new(mode: Option<InstallMode>, unsupported_reason: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(format!("boosted-server/{}", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(5 * 60))
            .build()
            .expect("the updater HTTP client configuration is valid");
        let initial_status = base_status(mode.is_some(), unsupported_reason.clone());
        Self {
            mode,
            unsupported_reason,
            client,
            operation: Arc::new(Mutex::new(())),
            last_status: Arc::new(RwLock::new(initial_status)),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        self.last_status
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub async fn check(&self) -> AppResult<UpdateStatus> {
        let _operation = self.operation.try_lock().map_err(|_| {
            AppError::Conflict("another server update operation is already in progress".into())
        })?;
        let release = self.latest_release().await?;
        let status = self.release_status(&release, false);
        self.remember_status(&status);
        Ok(status)
    }

    pub async fn install(&self) -> AppResult<UpdateStatus> {
        let _operation = self.operation.try_lock().map_err(|_| {
            AppError::Conflict("another server update operation is already in progress".into())
        })?;
        let cache_root = self.require_cache_root()?.to_path_buf();
        let release = self.latest_release().await?;
        let mut status = self.release_status(&release, false);
        if let Some(reason) = status.reason.as_deref() {
            return Err(AppError::Internal(reason.to_owned()));
        }
        if !status.update_available {
            self.remember_status(&status);
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
        write_active_release(&cache_root, target_version).await?;

        status.restart_pending = true;
        self.remember_status(&status);
        Ok(status)
    }

    pub fn restart_action(&self) -> AppResult<RestartAction> {
        let status = self.status();
        if !status.restart_pending {
            return Err(AppError::Conflict(
                "no verified server update is ready to restart".into(),
            ));
        }
        let target_version = status
            .target_version
            .ok_or_else(|| AppError::Internal("the installed update has no version".into()))?;
        match self
            .mode
            .as_ref()
            .ok_or_else(|| AppError::BadRequest(self.unsupported_reason()))?
        {
            InstallMode::ManagedLauncher { .. } => {
                Ok(RestartAction::ManagedLauncher(restart_exit_code()))
            }
            InstallMode::Standalone { cache_root } => {
                let binary = cache_root.join(target_version).join(binary_name());
                if !binary.is_file() {
                    return Err(AppError::Internal(format!(
                        "the verified update binary is missing: {}",
                        binary.display()
                    )));
                }
                Ok(RestartAction::Standalone {
                    binary,
                    arguments: std::env::args_os().skip(1).collect(),
                })
            }
        }
    }

    fn remember_status(&self, status: &UpdateStatus) {
        *self
            .last_status
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = status.clone();
    }

    fn unsupported_reason(&self) -> String {
        self.unsupported_reason
            .clone()
            .unwrap_or_else(|| "server updates are unavailable for this installation".into())
    }

    fn require_cache_root(&self) -> AppResult<&Path> {
        self.mode
            .as_ref()
            .map(InstallMode::cache_root)
            .ok_or_else(|| AppError::BadRequest(self.unsupported_reason()))
    }

    async fn latest_release(&self) -> AppResult<GitHubRelease> {
        self.require_cache_root()?;
        let response = self
            .client
            .get(RELEASE_API)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|error| AppError::Internal(format!("update check failed: {error}")))?;
        if !response.status().is_success() {
            return Err(AppError::Internal(format!(
                "GitHub update check failed ({})",
                response.status()
            )));
        }
        response.json().await.map_err(|error| {
            AppError::Internal(format!("invalid GitHub release response: {error}"))
        })
    }

    async fn download(&self, url: &str) -> AppResult<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .header("Accept", "application/octet-stream")
            .send()
            .await
            .map_err(|error| AppError::Internal(format!("update download failed: {error}")))?;
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

pub async fn wait_for_restart_delay() {
    let delay = std::env::var(RESTART_DELAY_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value <= 30_000);
    if let Some(delay) = delay {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

/// Start a newer verified cache entry before the originally downloaded
/// standalone binary initializes the server. This makes updates persistent
/// across later launches without modifying a running executable.
pub async fn launch_cached_release() -> AppResult<Option<std::process::ExitStatus>> {
    if std::env::var(MANAGED_INSTALL_ENV).as_deref() == Ok("1") || !self_update_build() {
        return Ok(None);
    }
    let cache_root = std::env::var_os(CACHE_ROOT_OVERRIDE_ENV)
        .map(PathBuf::from)
        .or_else(default_cache_root);
    let Some(cache_root) = cache_root.filter(|path| path.is_absolute()) else {
        return Ok(None);
    };
    let Some(binary) = cached_release_binary(
        &cache_root,
        env!("CARGO_PKG_VERSION"),
        &std::env::current_exe().map_err(AppError::internal)?,
    )
    .await?
    else {
        return Ok(None);
    };
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    tracing::info!(path=%binary.display(), "launching cached Boosted update");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(AppError::internal(
            Command::new(binary).args(arguments).exec(),
        ))
    }
    #[cfg(windows)]
    {
        let status = tokio::process::Command::new(binary)
            .args(arguments)
            .status()
            .await
            .map_err(AppError::internal)?;
        Ok(Some(status))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (binary, arguments);
        Ok(None)
    }
}

pub fn restart_exit_code() -> i32 {
    std::env::var(RESTART_EXIT_CODE_ENV)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value| (1..=255).contains(value))
        .unwrap_or(DEFAULT_RESTART_EXIT_CODE)
}

fn base_status(supported: bool, reason: Option<String>) -> UpdateStatus {
    UpdateStatus {
        supported,
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        target_version: None,
        update_available: false,
        restart_pending: false,
        reason,
    }
}

fn installation_configuration(
    managed: bool,
    launcher_cache_root: Option<PathBuf>,
    standalone_cache_root: Option<PathBuf>,
    embedded_web: bool,
    supported_target: bool,
) -> (Option<InstallMode>, Option<String>) {
    if !embedded_web {
        return (
            None,
            Some("Server updates are disabled for source and development builds.".into()),
        );
    }
    if !supported_target {
        return (
            None,
            Some(format!(
                "Server updates are unsupported on {}/{}.",
                std::env::consts::OS,
                std::env::consts::ARCH
            )),
        );
    }
    if managed {
        return match launcher_cache_root {
            Some(cache_root) if cache_root.is_absolute() => {
                (Some(InstallMode::ManagedLauncher { cache_root }), None)
            }
            _ => (
                None,
                Some("The managed CLI did not provide a valid update cache path.".into()),
            ),
        };
    }
    match standalone_cache_root {
        Some(cache_root) if cache_root.is_absolute() => {
            (Some(InstallMode::Standalone { cache_root }), None)
        }
        _ => (
            None,
            Some("Boosted could not resolve a writable update cache directory.".into()),
        ),
    }
}

fn default_cache_root() -> Option<PathBuf> {
    let root = dirs_next::cache_dir()?.join("boosted-cli");
    #[cfg(windows)]
    let root = root.join("Cache");
    Some(root)
}

fn self_update_build() -> bool {
    cfg!(feature = "embedded-web") && !cfg!(debug_assertions)
}

fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "boosted-cli.exe"
    } else {
        "boosted-cli"
    }
}

fn release_target_suffix() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("windows", "x86_64") => Some("windows-x86_64.exe"),
        _ => None,
    }
}

fn release_asset(version: &str) -> AppResult<String> {
    let suffix = release_target_suffix().ok_or_else(|| {
        AppError::BadRequest(format!(
            "server updates are unsupported on {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
    })?;
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

async fn cached_release_binary(
    cache_root: &Path,
    current_version: &str,
    current_executable: &Path,
) -> AppResult<Option<PathBuf>> {
    let active_path = cache_root.join("active.json");
    let contents = match tokio::fs::read(&active_path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            tracing::warn!(%error, path=%active_path.display(), "could not read cached update marker");
            return Ok(None);
        }
    };
    let active: ActiveRelease = match serde_json::from_slice(&contents) {
        Ok(active) => active,
        Err(error) => {
            tracing::warn!(%error, path=%active_path.display(), "ignoring invalid cached update marker");
            return Ok(None);
        }
    };
    let active_version = match Version::parse(&active.version) {
        Ok(version) => version,
        Err(error) => {
            tracing::warn!(%error, version=%active.version, "ignoring invalid cached update version");
            return Ok(None);
        }
    };
    let current_version = Version::parse(current_version).map_err(AppError::internal)?;
    if active_version <= current_version {
        return Ok(None);
    }
    // Use normalized semver text, not raw JSON, as a path segment.
    let binary = cache_root
        .join(active_version.to_string())
        .join(binary_name());
    if !binary.is_file() {
        tracing::warn!(path=%binary.display(), "cached update binary is missing");
        return Ok(None);
    }
    if same_file(&binary, current_executable).await {
        return Ok(None);
    }
    Ok(Some(binary))
}

async fn same_file(left: &Path, right: &Path) -> bool {
    match (
        tokio::fs::canonicalize(left).await,
        tokio::fs::canonicalize(right).await,
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
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
    if let Err(error) = replace_file(&temporary, path).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(())
}

async fn write_active_release(cache_root: &Path, version: &str) -> AppResult<()> {
    tokio::fs::create_dir_all(cache_root).await?;
    let path = cache_root.join("active.json");
    let temporary = cache_root.join(format!(".active.{}.tmp", std::process::id()));
    let contents = serde_json::to_vec(&ActiveRelease {
        version: version.to_owned(),
    })?;
    tokio::fs::write(&temporary, contents).await?;
    if let Err(error) = replace_file(&temporary, &path).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(())
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
    fn standalone_updates_use_the_default_cache_without_npm() {
        let cache_root = std::env::temp_dir().join("boosted-standalone-test");
        let (mode, reason) =
            installation_configuration(false, None, Some(cache_root.clone()), true, true);
        assert!(reason.is_none());
        assert!(matches!(
            mode,
            Some(InstallMode::Standalone { cache_root: actual }) if actual == cache_root
        ));
    }

    #[test]
    fn managed_updates_still_require_the_launcher_cache() {
        let fallback = Some(std::env::temp_dir().join("boosted-standalone-test"));
        assert!(
            installation_configuration(true, None, fallback, true, true)
                .0
                .is_none()
        );
        assert!(
            installation_configuration(true, Some(PathBuf::from("relative")), None, true, true,)
                .0
                .is_none()
        );
    }

    #[test]
    fn source_builds_and_unknown_targets_are_not_self_updatable() {
        let root = Some(std::env::temp_dir().join("boosted"));
        assert!(
            installation_configuration(false, None, root.clone(), false, true)
                .0
                .is_none()
        );
        assert!(
            installation_configuration(false, None, root, true, false)
                .0
                .is_none()
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

    #[tokio::test]
    async fn cached_newer_release_is_reused_on_later_launches() {
        let root = tempfile::tempdir().expect("temporary cache");
        let version_dir = root.path().join("99.2.1");
        tokio::fs::create_dir_all(&version_dir).await.unwrap();
        let binary = version_dir.join(binary_name());
        tokio::fs::write(&binary, b"verified binary").await.unwrap();
        write_active_release(root.path(), "99.2.1").await.unwrap();

        assert_eq!(
            cached_release_binary(root.path(), "1.0.0", &root.path().join("original-binary"),)
                .await
                .unwrap(),
            Some(binary)
        );
        assert!(
            cached_release_binary(root.path(), "100.0.0", &root.path().join("original-binary"),)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn invalid_or_traversing_active_versions_are_ignored() {
        let root = tempfile::tempdir().expect("temporary cache");
        tokio::fs::write(
            root.path().join("active.json"),
            br#"{"version":"../../malicious"}"#,
        )
        .await
        .unwrap();

        assert!(
            cached_release_binary(root.path(), "1.0.0", &root.path().join("original-binary"),)
                .await
                .unwrap()
                .is_none()
        );
    }
}
