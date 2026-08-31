#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use boosted_server::{Config, run};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tauri::Manager;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[cfg(target_os = "macos")]
fn macos_privacy_url(permission: &str) -> Result<&'static str, String> {
    match permission {
        "screen-recording" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
        "accessibility" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
        _ => Err("unknown macOS permission".into()),
    }
}

#[cfg(target_os = "macos")]
fn enclosing_app_bundle(path: &std::path::Path) -> Option<std::path::PathBuf> {
    path.ancestors()
        .find(|candidate| {
            candidate.extension().and_then(|value| value.to_str()) == Some("app")
                && candidate.join("Contents/Info.plist").is_file()
        })
        .map(std::path::Path::to_path_buf)
}

#[cfg(target_os = "macos")]
fn boosted_app_bundle() -> Result<std::path::PathBuf, String> {
    if let Ok(executable) = std::env::current_exe()
        && let Some(bundle) = enclosing_app_bundle(&executable)
    {
        return Ok(bundle);
    }

    let mut candidates = vec![std::path::PathBuf::from("/Applications/Boosted.app")];
    if let Some(user_home) = std::env::var_os("HOME") {
        candidates.push(
            std::path::PathBuf::from(user_home)
                .join("Applications")
                .join("Boosted.app"),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.join("Contents/Info.plist").is_file())
        .ok_or_else(|| {
            "Boosted.app is not installed. Build or install the desktop app before adding it to macOS Privacy & Security.".into()
        })
}

#[cfg(target_os = "macos")]
fn open_macos_url(url: &str) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open System Settings: {error}"))
}

#[tauri::command]
fn macos_permission_app_info() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = boosted_app_bundle()?;
        return Ok(serde_json::json!({
            "appName": "Boosted",
            "appPath": bundle.to_string_lossy(),
            "runningFromBundle": std::env::current_exe()
                .ok()
                .and_then(|path| enclosing_app_bundle(&path))
                .is_some(),
        }));
    }
    #[cfg(not(target_os = "macos"))]
    Err("the macOS permission helper is only available on macOS".into())
}

#[tauri::command]
fn open_macos_privacy_settings(permission: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return open_macos_url(macos_privacy_url(&permission)?);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        Err("the macOS permission helper is only available on macOS".into())
    }
}

#[tauri::command]
fn reveal_macos_permission_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = boosted_app_bundle()?;
        return std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(bundle)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("could not show Boosted.app in Finder: {error}"));
    }
    #[cfg(not(target_os = "macos"))]
    Err("the macOS permission helper is only available on macOS".into())
}

#[tauri::command]
async fn show_macos_permission_helper(
    app: tauri::AppHandle,
    permission: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let settings_url = macos_privacy_url(&permission)?;
        boosted_app_bundle()?;
        let label = format!("permission-helper-{permission}");
        if let Some(window) = app.get_webview_window(&label) {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            return open_macos_url(settings_url);
        }

        let permission_json =
            serde_json::to_string(&permission).map_err(|error| error.to_string())?;
        tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("index.html".into()))
            .title("Boosted permissions")
            .inner_size(350.0, 166.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .decorations(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .shadow(true)
            .center()
            .initialization_script(format!(
                "window.__BOOSTED_MACOS_PERMISSION_HELPER__ = {permission_json};"
            ))
            .build()
            .map_err(|error| format!("could not create permission helper: {error}"))?;
        return open_macos_url(settings_url);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, permission);
        Err("the macOS permission helper is only available on macOS".into())
    }
}

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
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            macos_permission_app_info,
            open_macos_privacy_settings,
            reveal_macos_permission_app,
            show_macos_permission_helper,
        ])
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
