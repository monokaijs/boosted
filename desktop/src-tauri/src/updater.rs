use boosted_server::updater::{ApplicationUpdater, ServerUpdater, UpdateStatus};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tauri_plugin_updater::{Update, UpdaterExt};

type UpdateFuture<'a> = Pin<Box<dyn Future<Output = Result<UpdateStatus, String>> + Send + 'a>>;

pub struct DesktopUpdater {
    app: tauri::AppHandle,
    status: RwLock<UpdateStatus>,
    staged: Mutex<Option<(Update, Vec<u8>)>>,
}

impl DesktopUpdater {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            status: RwLock::new(UpdateStatus {
                supported: !cfg!(debug_assertions),
                current_version: env!("CARGO_PKG_VERSION").into(),
                target_version: None,
                update_available: false,
                restart_pending: false,
                reason: cfg!(debug_assertions)
                    .then(|| "Updates are disabled for development builds.".into()),
            }),
            staged: Mutex::new(None),
        }
    }

    async fn latest(&self) -> Result<Option<Update>, String> {
        let status = self.status();
        if !status.supported {
            return Err(status
                .reason
                .unwrap_or_else(|| "Updates are unavailable.".into()));
        }
        self.app
            .updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string())
    }

    fn remember(&self, update: Option<&Update>, restart_pending: bool) -> UpdateStatus {
        let mut status = self
            .status
            .write()
            .unwrap_or_else(|error| error.into_inner());
        status.target_version = update.map(|update| update.version.clone());
        status.update_available = update.is_some();
        status.restart_pending = restart_pending;
        status.reason = None;
        status.clone()
    }
}

impl ApplicationUpdater for DesktopUpdater {
    fn status(&self) -> UpdateStatus {
        self.status
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn check(&self) -> UpdateFuture<'_> {
        Box::pin(async move {
            if !self.status().supported {
                return Ok(self.status());
            }
            let update = self.latest().await?;
            Ok(self.remember(update.as_ref(), false))
        })
    }

    fn install(&self) -> UpdateFuture<'_> {
        Box::pin(async move {
            let mut update = match self.latest().await? {
                Some(update) => update,
                None => return Ok(self.remember(None, false)),
            };
            update.timeout = Some(Duration::from_secs(5 * 60));
            // download() verifies the signature before returning the package.
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|error| error.to_string())?;
            let status = self.remember(Some(&update), true);
            *self
                .staged
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some((update, bytes));
            Ok(status)
        })
    }

    fn restart(&self) -> std::io::Result<()> {
        let (update, bytes) = self
            .staged
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .ok_or_else(|| std::io::Error::other("No application update is ready."))?;
        // Windows installers exit the process themselves, so install only after the API response.
        if let Err(error) = update.install(bytes) {
            let mut status = self
                .status
                .write()
                .unwrap_or_else(|error| error.into_inner());
            status.restart_pending = false;
            status.reason = Some(error.to_string());
            return Err(std::io::Error::other(error.to_string()));
        }
        self.app.request_restart();
        Ok(())
    }
}

pub fn start_automatic_updates(updater: ServerUpdater) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            if let Err(error) = updater.install_and_restart().await {
                tracing::warn!(%error, "automatic Boosted update failed");
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

pub fn for_app(app: tauri::AppHandle) -> ServerUpdater {
    ServerUpdater::for_application(Arc::new(DesktopUpdater::new(app)))
}
