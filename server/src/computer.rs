//! Native host desktop tools shared by all persistent agents.
use crate::error::{AppError, AppResult};
use base64::{Engine, engine::general_purpose::STANDARD};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::{DynamicImage, ImageFormat, RgbaImage, imageops::FilterType};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Cursor,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const SCREEN_MAX_SIZE: u32 = 1600;
const SCREEN_MAX_AGE: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Display {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    primary: bool,
}

impl Display {
    fn from_monitor(monitor: &xcap::Monitor) -> AppResult<Self> {
        Ok(Self {
            id: monitor.id().map_err(desktop_error)?,
            x: monitor.x().map_err(desktop_error)?,
            y: monitor.y().map_err(desktop_error)?,
            width: monitor.width().map_err(desktop_error)?,
            height: monitor.height().map_err(desktop_error)?,
            primary: monitor.is_primary().map_err(desktop_error)?,
        })
    }

    fn metadata(&self) -> Value {
        json!({"id":self.id,"x":self.x,"y":self.y,"width":self.width,
            "height":self.height,"primary":self.primary})
    }
}

struct Snapshot {
    id: String,
    revision: u64,
    captured: Instant,
    display: Display,
    image_width: u32,
    image_height: u32,
}

impl Snapshot {
    fn point(&self, args: &Value, x: &str, y: &str) -> AppResult<(i32, i32)> {
        let x = integer(args, x, 0, i64::from(self.image_width) - 1)?;
        let y = integer(args, y, 0, i64::from(self.image_height) - 1)?;
        // xcap exposes macOS points and Windows/X11 desktop pixels. Map using
        // the actual captured image size rather than a guessed DPI factor.
        let mapped_x = i64::from(self.display.x)
            + x * i64::from(self.display.width) / i64::from(self.image_width);
        let mapped_y = i64::from(self.display.y)
            + y * i64::from(self.display.height) / i64::from(self.image_height);
        Ok((
            i32::try_from(mapped_x).map_err(AppError::internal)?,
            i32::try_from(mapped_y).map_err(AppError::internal)?,
        ))
    }
}

#[derive(Debug)]
enum Input {
    Move((i32, i32)),
    Click((i32, i32), Button, u8),
    Drag((i32, i32), (i32, i32)),
    Scroll((i32, i32), i32, i32),
    Type(String),
    Keys(Vec<Key>),
}

fn parse_input(args: &Value, snapshot: &Snapshot) -> AppResult<Input> {
    let action = args["action"].as_str().unwrap_or_default();
    let extra: &[&str] = match action {
        "move" => &["x", "y"],
        "click" => &["x", "y", "button", "clickCount"],
        "drag" => &["x", "y", "endX", "endY"],
        "scroll" => &["x", "y", "scrollX", "scrollY"],
        "type" => &["text"],
        "key" => &["keys"],
        _ => return Err(AppError::BadRequest("Unknown computer action".into())),
    };
    if args.as_object().unwrap().keys().any(|field| {
        !matches!(field.as_str(), "action" | "screenshotId") && !extra.contains(&field.as_str())
    }) {
        return Err(AppError::BadRequest(
            "Argument does not apply to this computer action".into(),
        ));
    }
    match action {
        "move" => Ok(Input::Move(snapshot.point(args, "x", "y")?)),
        "click" => {
            let button = match args.get("button").map(Value::as_str) {
                None | Some(Some("left")) => Button::Left,
                Some(Some("right")) => Button::Right,
                Some(Some("middle")) => Button::Middle,
                _ => return Err(AppError::BadRequest("Invalid mouse button".into())),
            };
            let count = if args.get("clickCount").is_some() {
                integer(args, "clickCount", 1, 2)? as u8
            } else {
                1
            };
            Ok(Input::Click(snapshot.point(args, "x", "y")?, button, count))
        }
        "drag" => Ok(Input::Drag(
            snapshot.point(args, "x", "y")?,
            snapshot.point(args, "endX", "endY")?,
        )),
        "scroll" => {
            let x = args
                .get("scrollX")
                .map(|_| integer(args, "scrollX", -20, 20))
                .transpose()?
                .unwrap_or(0);
            let y = args
                .get("scrollY")
                .map(|_| integer(args, "scrollY", -20, 20))
                .transpose()?
                .unwrap_or(0);
            if x == 0 && y == 0 {
                return Err(AppError::BadRequest(
                    "Supply a nonzero scrollX or scrollY".into(),
                ));
            }
            Ok(Input::Scroll(
                snapshot.point(args, "x", "y")?,
                x as i32,
                y as i32,
            ))
        }
        "type" => {
            let text = args["text"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.contains('\0'))
                .ok_or_else(|| {
                    AppError::BadRequest(
                        "Text must contain 1–8192 bytes without NUL characters".into(),
                    )
                })?;
            Ok(Input::Type(text.to_owned()))
        }
        "key" => {
            let keys = args["keys"]
                .as_array()
                .filter(|keys| !keys.is_empty() && keys.len() <= 5)
                .ok_or_else(|| {
                    AppError::BadRequest("Supply 1–5 keys in modifier-first order".into())
                })?;
            let parsed = keys
                .iter()
                .map(|key| parse_key(key.as_str().unwrap_or_default()))
                .collect::<AppResult<Vec<_>>>()?;
            if parsed.iter().enumerate().any(|(i, key)| {
                parsed[..i].contains(key) || (i + 1 < parsed.len() && !is_modifier(*key))
            }) {
                return Err(AppError::BadRequest(
                    "Use distinct modifiers followed by one key".into(),
                ));
            }
            Ok(Input::Keys(parsed))
        }
        _ => unreachable!(),
    }
}

fn integer(args: &Value, field: &str, min: i64, max: i64) -> AppResult<i64> {
    args[field]
        .as_i64()
        .filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| {
            AppError::BadRequest(format!("{field} must be an integer from {min} to {max}"))
        })
}

fn is_modifier(key: Key) -> bool {
    matches!(key, Key::Control | Key::Alt | Key::Shift | Key::Meta)
}

fn parse_key(name: &str) -> AppResult<Key> {
    let key = match name.to_ascii_lowercase().as_str() {
        "control" | "ctrl" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,
        "meta" | "command" | "cmd" | "super" | "win" => Key::Meta,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "space" => Key::Space,
        "up" | "arrowup" => Key::UpArrow,
        "down" | "arrowdown" => Key::DownArrow,
        "left" | "arrowleft" => Key::LeftArrow,
        "right" | "arrowright" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        _ if name.chars().count() == 1 && !name.chars().next().unwrap().is_control() => {
            Key::Unicode(name.chars().next().unwrap())
        }
        _ => return Err(AppError::BadRequest(format!("Unsupported key: {name}"))),
    };
    Ok(key)
}

trait Desktop: Send + Sync {
    fn displays(&self) -> AppResult<Vec<Display>>;
    fn status(&self) -> Value;
    fn capture(&self, display: &Display) -> AppResult<RgbaImage>;
    fn input(&self, input: Input, cancelled: &AtomicBool) -> AppResult<()>;
}

struct NativeDesktop;

fn desktop_error(error: impl std::fmt::Display) -> AppError {
    AppError::Conflict(format!(
        "Computer control unavailable: {error}. {}",
        setup_instructions()
    ))
}

fn setup_instructions() -> &'static str {
    if cfg!(target_os = "macos") {
        "Enable Screen Recording and Accessibility for Boosted (or the launching terminal) in System Settings → Privacy & Security, then restart that app."
    } else if cfg!(target_os = "linux") {
        "Run Boosted in a logged-in X11 desktop session with DISPLAY and XAUTHORITY access. Wayland input is not supported."
    } else {
        "Run Boosted in the logged-in user's interactive desktop session; locked desktops and elevated apps may reject input."
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
unsafe extern "system" {
    fn SetCursorPos(x: i32, y: i32) -> i32;
}

fn move_pointer(enigo: &mut Enigo, x: i32, y: i32) -> AppResult<()> {
    // Enigo's Windows absolute events are normalized to the primary display.
    // SetCursorPos accepts virtual-desktop coordinates, including other screens.
    #[cfg(target_os = "windows")]
    {
        let _ = enigo;
        if unsafe { SetCursorPos(x, y) } == 0 {
            return Err(desktop_error(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(desktop_error)
}

fn check_desktop_session() -> AppResult<()> {
    #[cfg(target_os = "linux")]
    if std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind == "wayland")
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
    {
        // XWayland input only reaches some windows. Reject mixed capture/input
        // coordinate spaces, and avoid opening a blocking screen-share portal.
        return Err(desktop_error(
            "Computer control requires an X11 desktop session",
        ));
    }
    Ok(())
}

impl Desktop for NativeDesktop {
    fn displays(&self) -> AppResult<Vec<Display>> {
        check_desktop_session()?;
        #[cfg(target_os = "windows")]
        let _ = enigo::set_dpi_awareness();
        let displays = xcap::Monitor::all()
            .map_err(desktop_error)?
            .iter()
            .map(Display::from_monitor)
            .collect::<AppResult<Vec<_>>>()?;
        if displays.is_empty() || displays.iter().any(|d| d.width == 0 || d.height == 0) {
            return Err(desktop_error("No usable desktop displays"));
        }
        Ok(displays)
    }

    fn status(&self) -> Value {
        let input = check_desktop_session().and_then(|()| {
            Enigo::new(&Settings {
                open_prompt_to_get_permissions: false,
                ..Settings::default()
            })
            .map_err(desktop_error)
        });
        let input_error = input.as_ref().err().map(ToString::to_string);
        #[cfg(target_os = "macos")]
        let capture_permission = Some(unsafe { CGPreflightScreenCaptureAccess() });
        #[cfg(not(target_os = "macos"))]
        let capture_permission: Option<bool> = None;
        json!({"inputAvailable":input.is_ok(),"inputError":input_error,
            "screenCapturePermission":capture_permission,"setupInstructions":setup_instructions()})
    }

    fn capture(&self, display: &Display) -> AppResult<RgbaImage> {
        check_desktop_session()?;
        #[cfg(target_os = "macos")]
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(desktop_error("Screen Recording permission is missing"));
        }
        let monitor = xcap::Monitor::all()
            .map_err(desktop_error)?
            .into_iter()
            .find(|m| m.id().ok() == Some(display.id))
            .ok_or_else(|| desktop_error("Display disconnected"))?;
        monitor.capture_image().map_err(desktop_error)
    }

    fn input(&self, input: Input, cancelled: &AtomicBool) -> AppResult<()> {
        check_cancelled(cancelled)?;
        check_desktop_session()?;
        let mut enigo = Enigo::new(&Settings {
            open_prompt_to_get_permissions: false,
            ..Settings::default()
        })
        .map_err(desktop_error)?;
        match input {
            Input::Move((x, y)) => move_pointer(&mut enigo, x, y)?,
            Input::Click((x, y), button, count) => {
                move_pointer(&mut enigo, x, y)?;
                for _ in 0..count {
                    check_cancelled(cancelled)?;
                    let pressed = enigo
                        .button(button, Direction::Press)
                        .map_err(desktop_error);
                    // Release even if posting the press reports a partial failure.
                    let released = enigo
                        .button(button, Direction::Release)
                        .map_err(desktop_error);
                    pressed?;
                    released?;
                }
            }
            Input::Drag((x, y), (end_x, end_y)) => {
                move_pointer(&mut enigo, x, y)?;
                check_cancelled(cancelled)?;
                let result: AppResult<()> = (|| {
                    enigo
                        .button(Button::Left, Direction::Press)
                        .map_err(desktop_error)?;
                    for step in 1..=10 {
                        check_cancelled(cancelled)?;
                        let px = i64::from(x) + (i64::from(end_x) - i64::from(x)) * step / 10;
                        let py = i64::from(y) + (i64::from(end_y) - i64::from(y)) * step / 10;
                        move_pointer(&mut enigo, px as i32, py as i32)?;
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Ok(())
                })();
                // Mouse buttons are not included in Enigo's drop cleanup.
                let released = enigo
                    .button(Button::Left, Direction::Release)
                    .map_err(desktop_error);
                result?;
                released?;
            }
            Input::Scroll((x, y), horizontal, vertical) => {
                move_pointer(&mut enigo, x, y)?;
                check_cancelled(cancelled)?;
                if horizontal != 0 {
                    enigo
                        .scroll(horizontal, Axis::Horizontal)
                        .map_err(desktop_error)?;
                }
                check_cancelled(cancelled)?;
                if vertical != 0 {
                    enigo
                        .scroll(vertical, Axis::Vertical)
                        .map_err(desktop_error)?;
                }
            }
            Input::Type(text) => {
                let chars: Vec<_> = text.chars().collect();
                for chunk in chars.chunks(32) {
                    check_cancelled(cancelled)?;
                    enigo
                        .text(&chunk.iter().collect::<String>())
                        .map_err(desktop_error)?;
                }
            }
            Input::Keys(keys) => {
                let mut attempted = Vec::new();
                let result: AppResult<()> = (|| {
                    for key in &keys {
                        check_cancelled(cancelled)?;
                        attempted.push(*key);
                        enigo.key(*key, Direction::Press).map_err(desktop_error)?;
                    }
                    Ok(())
                })();
                let mut release_error = None;
                for key in attempted.iter().rev() {
                    if let Err(error) = enigo.key(*key, Direction::Release) {
                        release_error.get_or_insert_with(|| desktop_error(error));
                    }
                }
                result?;
                if let Some(error) = release_error {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(AppError::Conflict(
            "Computer action stopped; inspect a fresh screenshot before retrying".into(),
        ))
    } else {
        Ok(())
    }
}

#[derive(Default)]
struct Session {
    revision: u64,
    snapshots: HashMap<String, Snapshot>,
}

#[derive(Clone)]
pub(crate) struct ComputerControl {
    session: Arc<Mutex<Session>>,
    desktop: Arc<dyn Desktop>,
}

impl Default for ComputerControl {
    fn default() -> Self {
        Self {
            session: Arc::new(Mutex::new(Session::default())),
            desktop: Arc::new(NativeDesktop),
        }
    }
}

// Dropping a tool future on Stop/timeout also cancels queued blocking work.
// The desktop mutex stays held inside that worker until native input ends.
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

impl ComputerControl {
    pub(crate) async fn forget(&self, owner: &str) {
        let session = self.session.clone();
        let owner = owner.to_owned();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut session) = session.lock() {
                session.snapshots.remove(&owner);
            }
        })
        .await;
    }

    pub(crate) async fn execute(&self, owner: &str, name: &str, args: &Value) -> AppResult<Value> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel_on_drop = CancelOnDrop(cancelled.clone());
        let control = self.clone();
        let owner = owner.to_owned();
        let name = name.to_owned();
        let args = args.clone();
        tokio::task::spawn_blocking(move || {
            let mut session = control.session.lock().map_err(AppError::internal)?;
            check_cancelled(&cancelled)?;
            control.execute_locked(&mut session, &owner, &name, &args, &cancelled)
        })
        .await
        .map_err(AppError::internal)?
    }

    fn execute_locked(
        &self,
        session: &mut Session,
        owner: &str,
        name: &str,
        args: &Value,
        cancelled: &AtomicBool,
    ) -> AppResult<Value> {
        match name {
            "computer_status" => {
                let mut status = self.desktop.status();
                status["platform"] = json!(std::env::consts::OS);
                status["target"] = json!("boosted-server-desktop");
                match self.desktop.displays() {
                    Ok(displays) => {
                        status["displays"] =
                            json!(displays.iter().map(Display::metadata).collect::<Vec<_>>());
                    }
                    Err(error) => {
                        status["displays"] = json!([]);
                        status["displayError"] = json!(error.to_string());
                    }
                }
                Ok(status)
            }
            "computer_screenshot" => {
                let displays = self.desktop.displays()?;
                let display = if args.get("displayId").is_some() {
                    let id = integer(args, "displayId", 0, u32::MAX.into())? as u32;
                    displays.into_iter().find(|display| display.id == id)
                } else {
                    displays
                        .iter()
                        .find(|display| display.primary)
                        .or(displays.first())
                        .cloned()
                }
                .ok_or_else(|| {
                    AppError::BadRequest("Display not found; use computer_status".into())
                })?;
                let image = self.desktop.capture(&display)?;
                check_cancelled(cancelled)?;
                if image.width() == 0 || image.height() == 0 {
                    return Err(desktop_error("Empty screen capture"));
                }
                let image = DynamicImage::ImageRgba8(image);
                let image = if image.width().max(image.height()) > SCREEN_MAX_SIZE {
                    image.resize(SCREEN_MAX_SIZE, SCREEN_MAX_SIZE, FilterType::Triangle)
                } else {
                    image
                };
                let mut png = Cursor::new(Vec::new());
                image
                    .write_to(&mut png, ImageFormat::Png)
                    .map_err(AppError::internal)?;
                let screenshot_id = Uuid::new_v4().to_string();
                let result = json!({"screenshotId":screenshot_id,"capturedAt":chrono::Utc::now().to_rfc3339(),
                    "display":display.metadata(),"imageWidth":image.width(),"imageHeight":image.height(),
                    "coordinateSpace":"screenshot-pixels","expiresInSeconds":SCREEN_MAX_AGE.as_secs(),
                    "imageDataUrl":format!("data:image/png;base64,{}", STANDARD.encode(png.into_inner()))});
                session.snapshots.insert(
                    owner.to_owned(),
                    Snapshot {
                        id: screenshot_id,
                        revision: session.revision,
                        captured: Instant::now(),
                        display,
                        image_width: image.width(),
                        image_height: image.height(),
                    },
                );
                Ok(result)
            }
            "computer_action" => {
                let snapshot = session.snapshots.get(owner).filter(|snapshot|
                    args["screenshotId"].as_str() == Some(snapshot.id.as_str())
                    && snapshot.revision == session.revision && snapshot.captured.elapsed() <= SCREEN_MAX_AGE)
                    .ok_or_else(|| AppError::Conflict("Screenshot is missing, stale, consumed, or belongs to another agent; take a fresh computer_screenshot".into()))?;
                let input = parse_input(args, snapshot)?;
                if !self.desktop.displays()?.contains(&snapshot.display) {
                    return Err(AppError::Conflict(
                        "Display layout changed; take a fresh computer_screenshot".into(),
                    ));
                }
                check_cancelled(cancelled)?;
                // Invalidate before posting input: a failure can have partial side effects.
                session.revision = session.revision.wrapping_add(1);
                session.snapshots.clear();
                self.desktop.input(input, cancelled).map_err(|error| AppError::Conflict(format!(
                    "{error}. Input may have partially completed; inspect a fresh screenshot before retrying"
                )))?;
                Ok(
                    json!({"performed":true,"action":args["action"],"target":"boosted-server-desktop",
                    "nextStep":"Take a fresh computer_screenshot to verify the result before further input"}),
                )
            }
            _ => Err(AppError::BadRequest("Unknown computer tool".into())),
        }
    }
}

/// Persist metadata only; send the screenshot as visual input to Codex.
pub(crate) fn receipt_result(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(fields) = value.as_object_mut() {
        fields.remove("imageDataUrl");
    }
    value
}

pub(crate) fn tool_response(value: Value) -> Value {
    let mut content = vec![json!({"type":"inputText","text":receipt_result(&value).to_string()})];
    if let Some(url) = value["imageDataUrl"].as_str() {
        content.push(json!({"type":"inputImage","imageUrl":url}));
    }
    json!({"success":true,"contentItems":content})
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct FakeDesktop {
        displays: Mutex<Vec<Display>>,
        inputs: Mutex<Vec<Input>>,
        fail: AtomicBool,
        block_input: AtomicBool,
        started: tokio::sync::Notify,
        cancelled: AtomicBool,
    }

    impl Default for FakeDesktop {
        fn default() -> Self {
            Self {
                displays: Mutex::new(vec![Display {
                    id: 7,
                    x: -200,
                    y: 50,
                    width: 200,
                    height: 100,
                    primary: true,
                }]),
                inputs: Mutex::new(Vec::new()),
                fail: AtomicBool::new(false),
                block_input: AtomicBool::new(false),
                started: tokio::sync::Notify::new(),
                cancelled: AtomicBool::new(false),
            }
        }
    }

    impl Desktop for FakeDesktop {
        fn displays(&self) -> AppResult<Vec<Display>> {
            Ok(self.displays.lock().unwrap().clone())
        }
        fn status(&self) -> Value {
            json!({"inputAvailable":true})
        }
        fn capture(&self, display: &Display) -> AppResult<RgbaImage> {
            Ok(RgbaImage::new(display.width * 2, display.height * 2))
        }
        fn input(&self, input: Input, cancelled: &AtomicBool) -> AppResult<()> {
            self.started.notify_one();
            let deadline = Instant::now() + Duration::from_secs(3);
            while self.block_input.load(Ordering::Acquire) {
                if cancelled.load(Ordering::Acquire) {
                    self.cancelled.store(true, Ordering::Release);
                    return check_cancelled(cancelled);
                }
                assert!(
                    Instant::now() < deadline,
                    "Input cancellation must reach the native worker"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            self.inputs.lock().unwrap().push(input);
            if self.fail.load(Ordering::Acquire) {
                Err(desktop_error("Synthetic input failure"))
            } else {
                Ok(())
            }
        }
    }

    pub(crate) fn fixture() -> (ComputerControl, Arc<FakeDesktop>) {
        let desktop = Arc::new(FakeDesktop::default());
        let control = ComputerControl {
            session: Arc::new(Mutex::new(Session::default())),
            desktop: desktop.clone(),
        };
        (control, desktop)
    }

    async fn screen(control: &ComputerControl, owner: &str) -> Value {
        control
            .execute(owner, "computer_screenshot", &json!({}))
            .await
            .unwrap()
    }

    fn click(screen: &Value) -> Value {
        json!({"action":"click","screenshotId":screen["screenshotId"],"x":200,"y":100})
    }

    #[tokio::test]
    async fn screenshot_images_reach_the_model_without_entering_receipt_history() {
        let (control, _) = fixture();
        let screenshot = screen(&control, "one").await;
        let response = tool_response(screenshot.clone());
        assert_eq!(response["contentItems"][1]["type"], "inputImage");
        let url = response["contentItems"][1]["imageUrl"].as_str().unwrap();
        let png = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let image = image::load_from_memory(&png).unwrap();
        assert_eq!((image.width(), image.height()), (400, 200));
        assert_eq!(screenshot["display"]["id"], 7);
        assert!(receipt_result(&screenshot).get("imageDataUrl").is_none());
        assert!(
            !response["contentItems"][0]["text"]
                .as_str()
                .unwrap()
                .contains("base64")
        );
    }

    #[tokio::test]
    async fn scaled_coordinates_and_negative_origins_are_mapped_and_tokens_consumed() {
        let (control, desktop) = fixture();
        let screenshot = screen(&control, "one").await;
        control
            .execute("one", "computer_action", &click(&screenshot))
            .await
            .unwrap();
        assert!(matches!(
            desktop.inputs.lock().unwrap()[0],
            Input::Click((-100, 100), Button::Left, 1)
        ));
        assert!(
            control
                .execute("one", "computer_action", &click(&screenshot))
                .await
                .is_err()
        );
        assert_eq!(desktop.inputs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn captures_are_bounded_and_coordinates_use_the_resized_image() {
        let (control, desktop) = fixture();
        desktop.displays.lock().unwrap()[0].width = 2000;
        desktop.displays.lock().unwrap()[0].height = 1000;
        let screenshot = screen(&control, "one").await;
        assert_eq!(
            (
                screenshot["imageWidth"].as_u64(),
                screenshot["imageHeight"].as_u64()
            ),
            (Some(1600), Some(800))
        );
        control
            .execute(
                "one",
                "computer_action",
                &json!({"action":"move",
            "screenshotId":screenshot["screenshotId"],"x":800,"y":400}),
            )
            .await
            .unwrap();
        assert!(matches!(
            desktop.inputs.lock().unwrap()[0],
            Input::Move((800, 550))
        ));
    }

    #[tokio::test]
    async fn agents_cannot_reuse_another_agents_screen_or_interleave_old_inputs() {
        let (control, desktop) = fixture();
        let one = screen(&control, "one").await;
        let two = screen(&control, "two").await;
        assert!(
            control
                .execute("two", "computer_action", &click(&one))
                .await
                .is_err()
        );
        let one_input = click(&one);
        let two_input = click(&two);
        let (a, b) = tokio::join!(
            control.execute("one", "computer_action", &one_input),
            control.execute("two", "computer_action", &two_input)
        );
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(desktop.inputs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn expired_and_changed_display_snapshots_cannot_send_input() {
        let (control, desktop) = fixture();
        let screenshot = screen(&control, "one").await;
        control
            .session
            .lock()
            .unwrap()
            .snapshots
            .get_mut("one")
            .unwrap()
            .captured = Instant::now() - SCREEN_MAX_AGE - Duration::from_secs(1);
        assert!(
            control
                .execute("one", "computer_action", &click(&screenshot))
                .await
                .is_err()
        );
        let screenshot = screen(&control, "one").await;
        desktop.displays.lock().unwrap()[0].x = 0;
        assert!(
            control
                .execute("one", "computer_action", &click(&screenshot))
                .await
                .unwrap_err()
                .to_string()
                .contains("layout changed")
        );
        assert!(desktop.inputs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn malformed_actions_are_rejected_before_sending_any_input() {
        let (control, desktop) = fixture();
        let screenshot = screen(&control, "one").await;
        for args in [
            json!({"action":"click","x":400,"y":0}),
            json!({"action":"click","x":-1,"y":0}),
            json!({"action":"drag","x":0,"y":0,"endX":0}),
            json!({"action":"click","x":0,"y":0,"button":"bad"}),
            json!({"action":"click","x":0,"y":0,"clickCount":3}),
            json!({"action":"click","x":0,"y":0,"text":"unrelated"}),
            json!({"action":"scroll","x":0,"y":0,"scrollY":0}),
            json!({"action":"scroll","x":0,"y":0,"scrollY":21}),
            json!({"action":"type","text":""}),
            json!({"action":"key","keys":["Control","Control","a"]}),
            json!({"action":"key","keys":["a","Control"]}),
            json!({"action":"key","keys":["not-a-key"]}),
        ] {
            let mut args = args;
            args["screenshotId"] = screenshot["screenshotId"].clone();
            assert!(
                control
                    .execute("one", "computer_action", &args)
                    .await
                    .is_err(),
                "{args}"
            );
        }
        assert!(desktop.inputs.lock().unwrap().is_empty());
        control
            .execute(
                "one",
                "computer_action",
                &json!({"action":"key",
            "screenshotId":screenshot["screenshotId"],"keys":["Command","l"]}),
            )
            .await
            .unwrap();
        assert!(
            matches!(&desktop.inputs.lock().unwrap()[0], Input::Keys(keys) if keys == &vec![Key::Meta, Key::Unicode('l')])
        );
    }

    #[tokio::test]
    async fn partial_input_failure_invalidates_all_snapshots_and_turn_cleanup_forgets_them() {
        let (control, desktop) = fixture();
        let one = screen(&control, "one").await;
        let two = screen(&control, "two").await;
        desktop.fail.store(true, Ordering::Release);
        assert!(
            control
                .execute("one", "computer_action", &click(&one))
                .await
                .unwrap_err()
                .to_string()
                .contains("partially completed")
        );
        assert!(
            control
                .execute("two", "computer_action", &click(&two))
                .await
                .is_err()
        );
        let fresh = screen(&control, "one").await;
        control.forget("one").await;
        assert!(
            control
                .execute("one", "computer_action", &click(&fresh))
                .await
                .is_err()
        );
        assert_eq!(desktop.inputs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn dropping_an_active_tool_cancels_native_input_before_unlocking_the_desktop() {
        let (control, desktop) = fixture();
        let screenshot = screen(&control, "one").await;
        desktop.block_input.store(true, Ordering::Release);
        let worker_control = control.clone();
        let action = tokio::spawn(async move {
            worker_control
                .execute("one", "computer_action", &click(&screenshot))
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), desktop.started.notified())
            .await
            .unwrap();
        action.abort();
        assert!(action.await.unwrap_err().is_cancelled());
        // This capture waits for cancellation to finish; the mutex is held by
        // the native worker even after its async caller is gone.
        tokio::time::timeout(Duration::from_secs(3), screen(&control, "two"))
            .await
            .unwrap();
        assert!(desktop.cancelled.load(Ordering::Acquire));
        assert!(desktop.inputs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    #[ignore = "Reads the real host screen and requires desktop permissions; no input is sent"]
    async fn native_desktop_status_and_screenshot() {
        let control = ComputerControl::default();
        let status = control
            .execute("probe", "computer_status", &json!({}))
            .await
            .unwrap();
        eprintln!("Desktop status: {status}");
        let screenshot = control
            .execute("probe", "computer_screenshot", &json!({}))
            .await
            .unwrap();
        assert!(
            screenshot["imageDataUrl"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        eprintln!("Screen capture: {}", receipt_result(&screenshot));
    }
}
