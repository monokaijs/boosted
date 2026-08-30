#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use boosted_server::{Config, run};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tauri::Manager;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("tray-show", "Show Boosted")
        .separator()
        .text("tray-quit", "Quit Boosted")
        .build()?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Boosted")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            setup_tray(app)?;

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
        .on_window_event(|window, event| {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    tracing::warn!(%error, "main window could not be hidden to the system tray");
                }
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let _ = (window, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running Boosted desktop");
}
