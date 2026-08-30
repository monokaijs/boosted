#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use boosted_server::{Config, run};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let mut config = Config::from_env();
            config.local_bind = Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4782));
            config.data_dir = data_dir;
            config.web_dir = std::path::PathBuf::from("web/dist");
            tauri::async_runtime::spawn(async move {
                if let Err(error) = run(config).await {
                    tracing::warn!(%error, "local Boosted service did not start; the desktop will attach to an existing service if available");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Boosted desktop");
}
