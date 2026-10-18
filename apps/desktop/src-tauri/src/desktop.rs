//! Windows/macOS/Linux: tray icon + window, local stack (HyperHDR, tasks, scripts).

use crate::i18n::{t, tf};
use crate::{lights, stack};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const TRAY_OK: &[u8] = include_bytes!("../icons/tray-ok-32.png");
const TRAY_WARN: &[u8] = include_bytes!("../icons/tray-warn-32.png");
const TRAY_DOWN: &[u8] = include_bytes!("../icons/tray-down-32.png");

const OPEN_SHORTCUT: &str = "ctrl+alt+v";
const OPEN_SHORTCUT_LABEL: &str = "Ctrl+Alt+V";
const ROOMS: [&str; 4] = ["bedroom", "living_room", "kitchen", "office"];
const PAGES: [&str; 9] = ["casa", "lumini", "dispozitive", "ambilight", "ecrane", "notificari", "pc", "sistem", "setari"];
const STREAM_SCENES: [&str; 7] = ["party", "calm", "red_alert", "gift_gold", "rainbow", "blackout_flash", "default"];
const AMBER: [u8; 3] = [255, 140, 0];

#[derive(Clone)]
struct TrayItems {
    status: MenuItem<Wry>,
    movie: CheckMenuItem<Wry>,
    music: CheckMenuItem<Wry>,
    off: CheckMenuItem<Wry>,
    capture: CheckMenuItem<Wry>,
    offline: MenuItem<Wry>,
}

/// The menu is rebuilt on a language change, so the handles live behind a lock.
#[derive(Default)]
struct Tray {
    items: Mutex<Option<TrayItems>>,
    tooltip: Mutex<String>,
    offline: Mutex<Option<Vec<String>>>,
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) mode: Mutex<String>,
    pub(crate) last: Mutex<Option<stack::Health>>,
}

fn icon_for(state: &str) -> Image<'static> {
    let bytes = match state {
        "ok" => TRAY_OK,
        "down" => TRAY_DOWN,
        _ => TRAY_WARN,
    };
    Image::from_bytes(bytes).expect("tray png")
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

use crate::err;

// ---------------------------------------------------------------- commands (window -> rust)

#[tauri::command]
async fn health() -> stack::Health {
    stack::health()
}

#[tauri::command]
async fn tasks() -> Vec<stack::TaskState> {
    stack::task_states()
}

#[tauri::command]
async fn task_action(name: String, action: String) -> Result<(), String> {
    err(match action.as_str() {
        "start" => stack::task_start(&name),
        "stop" => stack::task_stop(&name),
        _ => stack::task_restart(&name),
    })
}

#[tauri::command]
async fn tail_log(name: String, lines: Option<usize>) -> Result<String, String> {
    err(stack::tail_log(&name, lines.unwrap_or(200)))
}

#[tauri::command]
async fn open_path(what: String) -> Result<(), String> {
    err(stack::open_path(&what))
}

#[tauri::command]
async fn settings_get() -> Result<Value, String> {
    err(stack::read_settings())
}

#[tauri::command]
async fn settings_set(patch: Value) -> Result<Value, String> {
    err(stack::write_settings(patch))
}

#[tauri::command]
async fn ambilight_configure() -> Result<String, String> {
    err(stack::ambilight_configure())
}

#[tauri::command]
async fn hyper_instances() -> Result<Vec<stack::HyperInstance>, String> {
    err(stack::hyper_instances())
}

/// Raw JSON-API to one or all instances; the UI builds the command objects
/// (effect, color, clear, componentstate, adjustment) from a small vocabulary.
#[tauri::command]
async fn hyper_send(commands: Vec<Value>, instances: Option<Vec<u32>>) -> Result<Vec<String>, String> {
    let inst = instances.unwrap_or_else(|| stack::HYPER_INSTANCES.to_vec());
    Ok(stack::hyper_all(&commands, &inst))
}

#[tauri::command]
async fn ambilight_mode(app: AppHandle, mode: String) -> Result<(), String> {
    set_mode(&app, &mode)
}

#[tauri::command]
async fn pc_action(action: String, value: Option<i64>) -> Result<String, String> {
    err(stack::pc_action(&action, value))
}

#[tauri::command]
async fn ha_call(domain: String, service: String, data: Value) -> Result<Value, String> {
    err(stack::ha_post(&format!("services/{domain}/{service}"), data))
}

#[tauri::command]
async fn vmui_get(path: String) -> Result<Value, String> {
    err(stack::vmui_get(&path))
}

#[tauri::command]
async fn vmui_send(method: String, path: String, body: Value) -> Result<Value, String> {
    err(stack::vmui_send(&method, &path, body))
}

#[tauri::command]
async fn devices_list() -> Result<Value, String> {
    err(stack::pi_get("/api/devices", 8))
}

#[tauri::command]
async fn lights_get() -> Result<Value, String> {
    blocking(lights::lights_get).await
}

#[tauri::command]
async fn lights_op(body: Value) -> Result<Value, String> {
    blocking(move || lights::lights_op(body)).await
}

#[tauri::command]
async fn ble_scan(seconds: u64) -> Result<Value, String> {
    blocking(move || lights::ble_scan(seconds)).await
}

#[tauri::command]
async fn ble_status() -> Result<Value, String> {
    blocking(lights::ble_status).await
}

#[tauri::command]
async fn pi_status(log: Option<String>) -> Result<Value, String> {
    let path = match log.filter(|l| !l.is_empty()) {
        Some(l) => format!("/api/desktop/pi?log={}", l.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect::<String>()),
        None => "/api/desktop/pi".to_string(),
    };
    blocking(move || stack::pi_get(&path, 15)).await
}

#[tauri::command]
async fn lang_get() -> String {
    crate::i18n::lang()
}

#[tauri::command]
async fn lang_set(app: AppHandle, lang: String) -> Result<(), String> {
    err(crate::i18n::set_lang(&lang))?;
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = rebuild_tray(&a) {
            stack::log(&format!("tray rebuild: {e}"));
        }
    });
    let _ = app.emit("lang", &lang);
    Ok(())
}

/// Network/BLE calls can take seconds; keep them off the async runtime's workers.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Result<T, String> {
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => err(r),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn devices_op(op: String, id: String, code: Option<String>, name: Option<String>) -> Result<(), String> {
    let mut body = json!({"op": op, "id": id});
    if let Some(c) = code { body["code"] = json!(c); }
    if let Some(n) = name { body["name"] = json!(n); }
    let v = err(stack::pi_post("/api/devices", body))?;
    if v["ok"].as_bool() == Some(true) { Ok(()) } else { Err(v["error"].as_str().unwrap_or("eroare").to_string()) }
}

#[tauri::command]
async fn app_info() -> Value {
    json!({
        "root": stack::root().to_string_lossy(),
        "vmui": stack::VMUI,
        "haUrl": stack::creds().get("HA_URL").cloned().unwrap_or_default(),
        "displayUrl": format!("{}/display?k={}", stack::VMUI, stack::vmui_token()),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

// ---------------------------------------------------------------- shared actions (tray + window)

pub(crate) fn set_mode(app: &AppHandle, mode: &str) -> Result<(), String> {
    let script = match mode {
        "movie" => "movie_mode_on",
        "music" => "music_mode",
        "off" => "movie_mode_off",
        _ => return Err("unknown mode".into()),
    };
    // script.turn_on returns at once; movie_mode_off alone runs > 7 s
    err(stack::ha_script(script, json!({})).inspect_err(|e| stack::log(&format!("mode {mode}: {e}"))))?;
    *app.state::<State>().mode.lock().unwrap() = mode.to_string();
    let _ = app.emit("mode", mode);
    Ok(())
}

/// Case (1), room bulbs (2), desk bar (3), MELK strip (4). Instance 0 (behind
/// the Odyssey) always follows the screen and is not part of the toggle.
const CAPTURE_INSTANCES: [u32; 4] = [1, 2, 3, 4];

fn grabber(on: bool) -> Value {
    json!({"command":"componentstate","componentstate":{"component":"SYSTEMGRABBER","state":on}})
}

fn toggle_capture(app: &AppHandle) {
    let any_on = CAPTURE_INSTANCES.iter().any(|i| stack::hyper_grabber(*i).ok().flatten() == Some(true));
    let target = !any_on;
    let errs = stack::hyper_all(&[grabber(target)], &CAPTURE_INSTANCES);
    crate::agent::set_cached_grabber(&CAPTURE_INSTANCES, target);
    toast_result(app, &errs, if target { "captureOn" } else { "captureOff" });
    refresh(app);
}

fn toast_result(app: &AppHandle, errs: &[String], ok_key: &str) {
    let _ = if errs.is_empty() {
        app.emit("toast", json!({"kind":"ok","text":t(ok_key)}))
    } else {
        app.emit("toast", json!({"kind":"error","text":errs.join("; ")}))
    };
}

/// Capture checkmark = any of instances 1..4 grabbing, from the agent's
/// 30 s instance snapshot (no extra HyperHDR logins on the 15 s tick).
fn capture_on(h: &stack::Health) -> bool {
    let inst = crate::agent::cached_instances();
    let room: Vec<Option<bool>> = inst.iter().filter(|i| CAPTURE_INSTANCES.contains(&i.id)).map(|i| i.grabber).collect();
    if room.is_empty() { h.grabber == Some(true) } else { room.contains(&Some(true)) }
}

/// Locale strings may already carry the "vmui — " / "vmui · " prefix; never print it twice.
fn bare(s: &str) -> &str {
    s.strip_prefix("vmui — ").or_else(|| s.strip_prefix("vmui · ")).unwrap_or(s)
}

fn tooltip_text(detail: &str) -> String {
    // NOTIFYICONDATAW.szTip holds 128 UTF-16 units incl. the terminator
    let s = format!("vmui — {}", bare(detail));
    let mut out = String::new();
    let mut n = 0;
    for c in s.chars() {
        n += c.len_utf16();
        if n > 120 {
            break;
        }
        out.push(c);
    }
    out
}

/// Menu/tray setters block until the main thread runs them, and the tray
/// rebuild runs ON the main thread taking these locks: never hold one across
/// a UI call.
fn items(app: &AppHandle) -> Option<TrayItems> {
    app.state::<Tray>().items.lock().unwrap().clone()
}

fn set_tooltip(app: &AppHandle, text: String) {
    if *app.state::<Tray>().tooltip.lock().unwrap() == text {
        return;
    }
    if let Some(tray) = app.tray_by_id("main") {
        if tray.set_tooltip(Some(&text)).is_ok() {
            *app.state::<Tray>().tooltip.lock().unwrap() = text;
        }
    }
}

fn refresh(app: &AppHandle) {
    let h = stack::health();
    let mode = app.state::<State>().mode.lock().unwrap().clone();
    if let Some(items) = items(app) {
        let _ = items.status.set_text(format!("vmui · {}", bare(&h.detail)));
        let _ = items.capture.set_checked(capture_on(&h));
        let _ = items.movie.set_checked(mode == "movie");
        let _ = items.music.set_checked(mode == "music");
        let _ = items.off.set_checked(mode == "off");
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(icon_for(&h.state)));
    }
    set_tooltip(app, tooltip_text(&h.detail));
    let _ = app.emit("health", &h);
    *app.state::<State>().last.lock().unwrap() = Some(h);
}

fn item(app: &AppHandle, id: &str, label: &str) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, true, None::<&str>)
}

fn offline_label(app: &AppHandle) -> String {
    match app.state::<Tray>().offline.lock().unwrap().as_ref() {
        None => tf("offline", &[("list", "…")]),
        Some(v) if v.is_empty() => t("allOnline"),
        Some(v) => tf("offline", &[("list", &v.join(", "))]),
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<Wry>, TrayItems)> {
    let detail = app.state::<State>().last.lock().unwrap().as_ref().map(|h| h.detail.clone()).unwrap_or_else(|| t("starting"));
    let mode = app.state::<State>().mode.lock().unwrap().clone();
    let status = MenuItem::with_id(app, "status", format!("vmui · {}", bare(&detail)), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", t("open"), true, Some(OPEN_SHORTCUT_LABEL))?;
    let movie = CheckMenuItem::with_id(app, "mode:movie", t("movie"), true, mode == "movie", None::<&str>)?;
    let music = CheckMenuItem::with_id(app, "mode:music", t("music"), true, mode == "music", None::<&str>)?;
    let off = CheckMenuItem::with_id(app, "mode:off", t("off"), true, mode == "off", None::<&str>)?;
    let cap_on = app.state::<State>().last.lock().unwrap().as_ref().is_some_and(capture_on);
    let capture = CheckMenuItem::with_id(app, "capture", t("capture"), true, cap_on, None::<&str>)?;
    let clear = item(app, "clear", &t("clear"))?;

    let lights = Submenu::with_id(app, "lights", t("lights"), true)?;
    lights.append(&item(app, "lights:all:on", &t("allOn"))?)?;
    lights.append(&item(app, "lights:all:off", &t("allOff"))?)?;
    lights.append(&PredefinedMenuItem::separator(app)?)?;
    for r in ROOMS {
        let sub = Submenu::with_id(app, format!("lights:room:{r}"), t(&format!("room_{r}")), true)?;
        sub.append(&item(app, &format!("lights:room:{r}:on"), &t("turnOn"))?)?;
        sub.append(&item(app, &format!("lights:room:{r}:off"), &t("turnOff"))?)?;
        lights.append(&sub)?;
    }
    lights.append(&PredefinedMenuItem::separator(app)?)?;
    lights.append(&item(app, "lights:undo", &t("undo"))?)?;

    let ambilight = Submenu::with_id(app, "ambilight", t("ambilight"), true)?;
    ambilight.append(&item(app, "amb:on", &t("ambilightOn"))?)?;
    ambilight.append(&item(app, "amb:off", &t("ambilightOff"))?)?;
    let bri = Submenu::with_id(app, "amb:bri", t("brightness"), true)?;
    for p in [25, 50, 75, 100] {
        bri.append(&item(app, &format!("amb:bri:{p}"), &format!("{p} %"))?)?;
    }
    ambilight.append(&bri)?;

    let scenes = Submenu::with_id(app, "scenes", t("scenes"), true)?;
    scenes.append(&item(app, "scene:ambilight_all", &t("scene_ambilight_all"))?)?;
    scenes.append(&item(app, "scene:pc_wake", &t("scene_pc_wake"))?)?;
    scenes.append(&item(app, "scene:notify_flash", &t("scene_flash"))?)?;
    scenes.append(&PredefinedMenuItem::separator(app)?)?;
    for s in STREAM_SCENES {
        scenes.append(&item(app, &format!("stream:{s}"), &t(&format!("stream_{s}")))?)?;
    }

    let pages = Submenu::with_id(app, "pages", t("openPage"), true)?;
    for p in PAGES {
        pages.append(&item(app, &format!("page:{p}"), &t(&format!("page_{p}")))?)?;
    }

    let pc = Submenu::with_id_and_items(
        app,
        "pc",
        t("pc"),
        true,
        &[&item(app, "pc:lock", &t("lock"))?, &item(app, "pc:display_off", &t("displayOff"))?, &item(app, "pc:sleep", &t("sleep"))?],
    )?;
    let devices = Submenu::with_id(app, "devices", t("devices"), true)?;
    crate::devices::attach(app, devices.clone());
    let offline = MenuItem::with_id(app, "offline", offline_label(app), false, None::<&str>)?;
    let restart = item(app, "restart", &t("restart"))?;
    let quit = item(app, "quit", &t("quit"))?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &pages,
            &PredefinedMenuItem::separator(app)?,
            &movie,
            &music,
            &off,
            &PredefinedMenuItem::separator(app)?,
            &lights,
            &ambilight,
            &capture,
            &clear,
            &scenes,
            &PredefinedMenuItem::separator(app)?,
            &pc,
            &devices,
            &offline,
            &PredefinedMenuItem::separator(app)?,
            &restart,
            &quit,
        ],
    )?;
    Ok((menu, TrayItems { status, movie, music, off, capture, offline }))
}

/// Language change: recreate every label and swap the menu on the existing icon.
fn rebuild_tray(app: &AppHandle) -> tauri::Result<()> {
    let (menu, items) = build_menu(app)?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu))?;
    }
    *app.state::<Tray>().items.lock().unwrap() = Some(items);
    let detail = app.state::<State>().last.lock().unwrap().as_ref().map(|h| h.detail.clone()).unwrap_or_else(|| t("starting"));
    set_tooltip(app, tooltip_text(&detail));
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let (menu, items) = build_menu(app)?;
    *app.state::<Tray>().items.lock().unwrap() = Some(items);
    // No tooltip at NIM_ADD time: Windows kept the registration tip and
    // prefixed it to every later one ("vmui — pornire… vmui — …", D-002).
    // The text is set once via NIM_MODIFY below and on every refresh.
    TrayIconBuilder::with_id("main")
        .icon(icon_for("warn"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| {
            let id = ev.id().as_ref().to_string();
            let app = app.clone();
            std::thread::spawn(move || on_menu(&app, &id));
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    set_tooltip(app, tooltip_text(&t("starting")));
    Ok(())
}

fn toast_err(app: &AppHandle, what: &str, e: impl std::fmt::Display) {
    stack::log(&format!("{what}: {e}"));
    let _ = app.emit("toast", json!({"kind":"error","text":format!("{what}: {e}")}));
}

fn lights_set(app: &AppHandle, target: &str, on: bool) {
    match lights::lights_op(json!({"op":"set","target":target,"state":{"on":on}})) {
        Ok(_) => refresh_offline(app),
        Err(e) => toast_err(app, "lights", e),
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main(app),
        "capture" => toggle_capture(app),
        "clear" => {
            let errs = stack::hyper_all(&[json!({"command":"clear","priority":40})], &stack::HYPER_INSTANCES);
            if !errs.is_empty() {
                toast_err(app, "clear", errs.join("; "));
            }
        }
        "restart" => {
            for task in stack::AMBILIGHT_TASKS {
                let _ = stack::task_restart(task);
            }
            refresh(app);
        }
        "quit" => app.exit(0),
        "lights:all:on" => lights_set(app, "all", true),
        "lights:all:off" => lights_set(app, "all", false),
        "lights:undo" => {
            if let Err(e) = lights::lights_op(json!({"op":"undo"})) {
                toast_err(app, "undo", e);
            }
        }
        "amb:on" => {
            let errs = stack::hyper_all(&[json!({"command":"clear","priority":40}), grabber(true)], &stack::HYPER_INSTANCES);
            crate::agent::set_cached_grabber(&stack::HYPER_INSTANCES, true);
            toast_result(app, &errs, "ambilightOn");
            refresh(app);
        }
        "amb:off" => {
            let errs = stack::hyper_all(&[grabber(false)], &stack::HYPER_INSTANCES);
            crate::agent::set_cached_grabber(&stack::HYPER_INSTANCES, false);
            toast_result(app, &errs, "ambilightOff");
            refresh(app);
        }
        "scene:ambilight_all" => {
            // the script only fans out `commands`; without them it is a no-op (D-009)
            let cmds = json!([{"command":"clear","priority":40}, grabber(true)]);
            if let Err(e) = stack::ha_script("ambilight_all", json!({"commands": cmds})) {
                toast_err(app, "ambilight_all", e);
            }
        }
        "scene:notify_flash" => {
            // field names from ambilight/ha-scenes.yaml: color + duration_ms (D-011)
            if let Err(e) = stack::ha_script("notify_flash", json!({"color": AMBER, "duration_ms": 1500})) {
                toast_err(app, "notify_flash", e);
            }
        }
        m if m.starts_with("mode:") => {
            if let Err(e) = set_mode(app, &m[5..]) {
                toast_err(app, m, e);
            }
            refresh(app);
        }
        s if s.starts_with("scene:") => {
            if let Err(e) = stack::ha_script(&s[6..], json!({})) {
                toast_err(app, s, e);
            }
        }
        s if s.starts_with("stream:") && STREAM_SCENES.contains(&&s[7..]) => {
            if let Err(e) = stack::ha_script(&format!("stream_scene_{}", &s[7..]), json!({})) {
                toast_err(app, s, e);
            }
        }
        b if b.starts_with("amb:bri:") => {
            let pct: u32 = b[8..].parse().unwrap_or(100).min(100);
            let errs = stack::hyper_all(&[json!({"command":"adjustment","adjustment":{"brightness":pct}})], &stack::HYPER_INSTANCES);
            if !errs.is_empty() {
                toast_err(app, "brightness", errs.join("; "));
            }
        }
        r if r.starts_with("lights:room:") => {
            let rest = &r["lights:room:".len()..];
            if let Some((room, state)) = rest.rsplit_once(':') {
                if ROOMS.contains(&room) {
                    lights_set(app, &format!("room:{room}"), state == "on");
                }
            }
        }
        p if p.starts_with("page:") && PAGES.contains(&&p[5..]) => {
            let _ = app.emit("navigate", json!({"page": &p[5..]}));
            show_main(app);
        }
        p if p.starts_with("pc:") => {
            if let Err(e) = stack::pc_action(&p[3..], None) {
                toast_err(app, p, e);
            }
        }
        d if crate::devices::handle_menu(app, d) => {}
        _ => {}
    }
}

/// Offline registry devices, shown as a disabled tray line; every 60 s.
fn refresh_offline(app: &AppHandle) {
    let Ok(v) = lights::lights_get() else { return };
    *app.state::<Tray>().offline.lock().unwrap() = Some(lights::offline_names(&v));
    let label = offline_label(app);
    if let Some(items) = items(app) {
        let _ = items.offline.set_text(label);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, ev| {
                    if ev.state == ShortcutState::Pressed {
                        show_main(app);
                    }
                })
                .build(),
        )
        .manage(State::default())
        .manage(Tray::default())
        .setup(|app| {
            crate::i18n::init(app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()));
            build_tray(app.handle())?;
            if let Err(e) = app.global_shortcut().register(OPEN_SHORTCUT) {
                stack::log(&format!("global shortcut {OPEN_SHORTCUT}: {e}"));
            }
            // closing the window hides it; the tray owns the process
            if let Some(w) = app.get_webview_window("main") {
                let wh = w.clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        let _ = wh.hide();
                    }
                });
                // window-state restores visibility on its own; `--hidden`
                // (the logon task) must win, so hide explicitly after it ran.
                if std::env::args().any(|a| a == "--hidden") {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
                }
            }
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                refresh(&h);
                std::thread::sleep(Duration::from_secs(15));
            });
            let o = app.handle().clone();
            std::thread::spawn(move || loop {
                refresh_offline(&o);
                std::thread::sleep(Duration::from_secs(60));
            });
            // phone -> Pi (MQTT) -> this PC
            let a = app.handle().clone();
            std::thread::spawn(move || crate::agent::run(a));
            // pairing requests on the Pi -> toast + tray entry here
            let d = app.handle().clone();
            std::thread::spawn(move || crate::devices::run(d));
            // notification centre on the Pi -> Windows toasts with buttons
            let n = app.handle().clone();
            std::thread::spawn(move || crate::notify::run(n));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            tasks,
            devices_list,
            devices_op,
            task_action,
            tail_log,
            open_path,
            settings_get,
            settings_set,
            ambilight_configure,
            hyper_instances,
            hyper_send,
            ambilight_mode,
            pc_action,
            ha_call,
            vmui_get,
            vmui_send,
            app_info,
            lights_get,
            lights_op,
            ble_scan,
            ble_status,
            pi_status,
            lang_get,
            lang_set,
            crate::notify::notify_list,
            crate::notify::notify_act,
            crate::notify::notify_op,
            crate::notify::notify_settings
        ])
        .run(tauri::generate_context!())
        .expect("vmui desktop");
}
