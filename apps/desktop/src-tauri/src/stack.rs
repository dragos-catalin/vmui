//! Everything the window and the tray talk to: the paired hub (crate::hub), HyperHDR's
//! JSON-API over WebSocket on this PC and, in a developer checkout only, the repo on disk
//! (credentials, ambilight/settings.json, scripts) and its Task Scheduler stack.
//! An installed copy (P9) reads nothing outside its own app-data and log folders.
//!
//! All calls are blocking and short; Tauri runs commands on a thread pool.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

pub const HYPER_WS: &str = "ws://127.0.0.1:8090";
/// The developer PC's own vmui (Hyper-V provider); only probed in a checkout.
pub const VMUI: &str = "http://127.0.0.1:3737";
pub const TASKS: [&str; 6] = [
    "vmui-ambilight-hyperhdr",
    "vmui-ambilight-openrgb",
    "vmui-ambilight-bridges",
    "vmui-service",
    "vmui-turzx",
    "vmui-tray",
];
pub const AMBILIGHT_TASKS: [&str; 3] = ["vmui-ambilight-hyperhdr", "vmui-ambilight-openrgb", "vmui-ambilight-bridges"];
pub const HYPER_INSTANCES: [u32; 5] = [0, 1, 2, 3, 4];

#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------- repo + creds

/// The vmui checkout, when this binary runs from one: VMUI_ROOT, or a parent of the executable
/// that holds `ambilight/tray.py` (target/release inside the repo). None for an installed copy,
/// which then never touches a repo path (P9-01).
pub fn root() -> Option<&'static Path> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        if let Ok(r) = std::env::var("VMUI_ROOT") {
            let p = PathBuf::from(r);
            return p.join("ambilight").join("tray.py").exists().then_some(p);
        }
        let mut p = std::env::current_exe().ok();
        while let Some(dir) = p.as_ref().and_then(|x| x.parent()).map(Path::to_path_buf) {
            if dir.join("ambilight").join("tray.py").exists() {
                return Some(dir);
            }
            if dir.parent().is_none() {
                break;
            }
            p = Some(dir);
        }
        None
    })
    .as_deref()
}

pub fn dev() -> bool {
    root().is_some()
}

fn need_root() -> Result<&'static Path> {
    root().ok_or_else(|| anyhow!("dev_only"))
}

/// Developer checkout credentials (+ the same keys from the environment). Empty for an installed copy.
pub fn creds() -> &'static HashMap<String, String> {
    static C: OnceLock<HashMap<String, String>> = OnceLock::new();
    C.get_or_init(|| {
        let mut out = HashMap::new();
        let Some(root) = root() else { return out };
        if let Ok(text) = std::fs::read_to_string(root.join(".private").join("credentials.env")) {
            for line in text.lines() {
                let line = line.trim_end_matches('\r');
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    out.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
                }
            }
        }
        for k in ["HA_URL", "HA_TOKEN", "HYPERHDR_ADMIN_PASS", "ESP_DISPLAY_TOKEN"] {
            if let Ok(v) = std::env::var(k) {
                out.insert(k.to_string(), v);
            }
        }
        out
    })
}

fn cred(k: &str) -> String {
    creds().get(k).cloned().unwrap_or_default()
}

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The app's own log folder (Tauri app_log_dir); set once at startup.
pub fn set_log_dir(dir: PathBuf) {
    let _ = LOG_DIR.set(dir);
}

fn log_dir() -> PathBuf {
    match root() {
        Some(r) => r.join(".copilot-tmp").join("service-logs"),
        None => LOG_DIR.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("vatra")),
    }
}

/// Append one line to desktop.log (the Sistem page tails it).
pub fn log(msg: &str) {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        use std::io::Write;
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{:02}:{:02}:{:02} {msg}", (t / 3600 + 3) % 24, (t / 60) % 60, t % 60);
    }
}

// ---------------------------------------------------------------- settings.json

pub fn settings_path() -> Result<PathBuf> {
    Ok(need_root()?.join("ambilight").join("settings.json"))
}

pub fn read_settings() -> Result<Value> {
    let t = std::fs::read_to_string(settings_path()?).context("ambilight/settings.json")?;
    Ok(serde_json::from_str(&t)?)
}

/// Merge `patch` into settings.json (top-level keys) and write it back pretty.
pub fn write_settings(patch: Value) -> Result<Value> {
    let path = settings_path()?;
    let mut cur = read_settings().unwrap_or_else(|_| json!({}));
    if let (Some(c), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            c.insert(k.clone(), v.clone());
        }
    }
    std::fs::write(path, serde_json::to_string_pretty(&cur)? + "\n")?;
    Ok(cur)
}

// ---------------------------------------------------------------- processes

fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(NO_WINDOW);
    }
    c
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TaskState {
    pub name: String,
    pub status: String,
    pub running: bool,
}

/// One `schtasks /query` for every task (was one process per task, 6 per tick).
/// The Task Scheduler stack is the developer house's; an installed copy has none.
pub fn task_states() -> Vec<TaskState> {
    if !dev() {
        return Vec::new();
    }
    let text = cmd("schtasks").args(["/query", "/fo", "csv", "/nh"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let mut found: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        // "\vmui-turzx","N/A","Running" (root-folder tasks only: the name has a single leading backslash)
        let cols: Vec<&str> = line.trim_end_matches('\r').split("\",\"").map(|s| s.trim_matches('"')).collect();
        if let (Some(name), Some(status)) = (cols.first(), cols.get(2)) {
            if let Some(n) = name.strip_prefix('\\').filter(|n| TASKS.contains(n)) {
                found.entry(n.to_string()).or_insert_with(|| status.trim().to_string());
            }
        }
    }
    TASKS
        .iter()
        .map(|t| {
            let status = found.get(*t).cloned().unwrap_or_else(|| "missing".into());
            TaskState { name: t.to_string(), running: status == "Running", status }
        })
        .collect()
}

pub fn task_start(name: &str) -> Result<()> {
    need_root()?;
    if !TASKS.contains(&name) {
        return Err(anyhow!("unknown task"));
    }
    cmd("schtasks").args(["/run", "/tn", name]).output()?;
    Ok(())
}

pub fn task_stop(name: &str) -> Result<()> {
    need_root()?;
    if !TASKS.contains(&name) {
        return Err(anyhow!("unknown task"));
    }
    cmd("schtasks").args(["/end", "/tn", name]).output()?;
    // /end leaves the child alive for hyperhdr/openrgb; be explicit
    let exe = match name {
        "vmui-ambilight-hyperhdr" => Some("hyperhdr.exe"),
        "vmui-ambilight-openrgb" => Some("OpenRGB.exe"),
        _ => None,
    };
    if let Some(e) = exe {
        cmd("taskkill").args(["/f", "/im", e]).output()?;
    }
    Ok(())
}

pub fn task_restart(name: &str) -> Result<()> {
    task_stop(name)?;
    std::thread::sleep(Duration::from_millis(1500));
    task_start(name)
}

/// The fixed verbs of scripts/pc-action.ps1 — never arbitrary shell.
pub const PC_ACTIONS: [&str; 12] = [
    "lock", "sleep", "display_off", "volume", "mute", "unmute", "restart_tunnel", "unfreeze_vscode", "kill_runaway_renderer", "restart_ambilight", "restart_turzx", "restart_vmui",
];

/// Verbs every installed copy can do itself (Win32, no script); the rest drive the developer
/// house's scheduled tasks and need the checkout.
pub const NATIVE_PC_ACTIONS: [&str; 6] = ["lock", "sleep", "display_off", "volume", "mute", "unmute"];

pub fn pc_action(action: &str, value: Option<i64>) -> Result<String> {
    if !PC_ACTIONS.contains(&action) {
        return Err(anyhow!("unknown pc action"));
    }
    if NATIVE_PC_ACTIONS.contains(&action) {
        return native_pc(action, value).map(|_| format!("ok {action}"));
    }
    let script = need_root()?.join("scripts").join("pc-action.ps1");
    let mut c = cmd("pwsh");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script).args(["-Action", action]);
    if let Some(v) = value {
        c.args(["-Value", &v.to_string()]);
    }
    let out = c.output().context("pwsh")?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(anyhow!("{}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Same effects as scripts/pc-action.ps1, through Win32 directly.
#[cfg(windows)]
fn native_pc(action: &str, value: Option<i64>) -> Result<()> {
    use windows_sys::Win32::System::Power::SetSuspendState;
    use windows_sys::Win32::System::Shutdown::LockWorkStation;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND};
    let key = |vk: u16| unsafe {
        keybd_event(vk as u8, 0, 0, 0);
        keybd_event(vk as u8, 0, KEYEVENTF_KEYUP, 0);
    };
    // SAFETY: plain Win32 calls with constant arguments; none keeps a pointer.
    match action {
        "lock" => {
            if unsafe { LockWorkStation() } == 0 {
                return Err(anyhow!("LockWorkStation failed"));
            }
        }
        "sleep" => {
            unsafe { SetSuspendState(false, false, false) };
        }
        "display_off" => {
            unsafe { SendMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER as usize, 2) };
        }
        "mute" | "unmute" => key(VK_VOLUME_MUTE),
        "volume" => {
            let v = value.filter(|v| (0..=100).contains(v)).ok_or_else(|| anyhow!("volume needs 0..100"))?;
            // media keys move 2 % per press: drive to 0, then up
            for _ in 0..50 {
                key(VK_VOLUME_DOWN);
            }
            for _ in 0..((v as f64 / 2.0).round() as i64) {
                key(VK_VOLUME_UP);
            }
        }
        _ => return Err(anyhow!("unknown pc action")),
    }
    Ok(())
}

#[cfg(not(windows))]
fn native_pc(_action: &str, _value: Option<i64>) -> Result<()> {
    Err(anyhow!("unsupported on this OS"))
}

/// Re-push settings.json into HyperHDR (layouts, smoothing, wall compensation).
pub fn ambilight_configure() -> Result<String> {
    let script = need_root()?.join("scripts").join("ambilight.ps1");
    let out = cmd("pwsh").args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script).arg("-Configure").output()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(anyhow!("{}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

pub fn tail_log(name: &str, lines: usize) -> Result<String> {
    let file = match name {
        "desktop" => format!("{name}.log"),
        "tray" | "turzx" | "bridges" | "hyperhdr" | "openrgb" | "vmui" if dev() => format!("{name}.log"),
        _ => return Err(anyhow!("unknown log")),
    };
    let p = log_dir().join(file);
    let t = std::fs::read_to_string(&p).unwrap_or_default();
    let v: Vec<&str> = t.lines().collect();
    let start = v.len().saturating_sub(lines);
    Ok(v[start..].join("\n"))
}

pub fn open_path(p: &str) -> Result<()> {
    let target = match p {
        "settings" => settings_path()?,
        "logs" => {
            let d = log_dir();
            std::fs::create_dir_all(&d)?;
            d
        }
        "root" => need_root()?.to_path_buf(),
        _ => return Err(anyhow!("unknown path")),
    };
    cmd("explorer").arg(target).spawn()?;
    Ok(())
}

// ---------------------------------------------------------------- HyperHDR

/// Same session rules as scripts/lib/hyperhdr.ps1: login -> switchTo -> cmds.
pub fn hyper(commands: &[Value], instance: u32) -> Result<Vec<Value>> {
    use tungstenite::{connect, Message};
    let (mut ws, _) = connect(HYPER_WS).context("HyperHDR websocket")?;
    let mut tan = 0u64;
    let mut send = |o: Value| -> Result<Value> {
        tan += 1;
        let mut o = o;
        o["tan"] = json!(tan);
        ws.send(Message::Text(o.to_string().into()))?;
        loop {
            let m = ws.read()?;
            if let Message::Text(t) = m {
                let r: Value = serde_json::from_str(&t)?;
                if r["tan"].as_u64() == Some(tan) {
                    return Ok(r);
                }
            }
        }
    };
    let pass = creds().get("HYPERHDR_ADMIN_PASS").cloned().unwrap_or_else(|| "hyperhdr".into());
    let a = send(json!({"command":"authorize","subcommand":"login","password":pass}))?;
    if a["success"] != json!(true) {
        return Err(anyhow!("hyperhdr login: {}", a["error"]));
    }
    if instance != 0 {
        send(json!({"command":"instance","subcommand":"switchTo","instance":instance}))?;
    }
    let mut out = Vec::new();
    for c in commands {
        let r = send(c.clone())?;
        if r["success"] != json!(true) {
            return Err(anyhow!("{}: {}", c["command"], r["error"]));
        }
        out.push(r);
    }
    Ok(out)
}

pub fn hyper_all(commands: &[Value], instances: &[u32]) -> Vec<String> {
    let mut errs = Vec::new();
    for i in instances {
        if let Err(e) = hyper(commands, *i) {
            log(&format!("hyper inst {i}: {e}"));
            errs.push(format!("inst {i}: {e}"));
        }
    }
    errs
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct HyperInstance {
    pub id: u32,
    pub name: String,
    pub running: bool,
    pub grabber: Option<bool>,
    pub source: String,
    pub brightness: Option<i64>,
    pub effects: Vec<String>,
}

pub fn hyper_info() -> Result<Value> {
    Ok(hyper(&[json!({"command":"serverinfo"})], 0)?.remove(0)["info"].take())
}

/// SYSTEMGRABBER state of one instance (one login + serverinfo).
pub fn hyper_grabber(instance: u32) -> Result<Option<bool>> {
    let i = hyper(&[json!({"command":"serverinfo"})], instance)?.remove(0)["info"].take();
    Ok(i["components"].as_array().and_then(|c| c.iter().find(|x| x["name"] == "SYSTEMGRABBER")).and_then(|x| x["enabled"].as_bool()))
}

pub fn hyper_instances() -> Result<Vec<HyperInstance>> {
    let info = hyper_info()?;
    let effects: Vec<String> = info["effects"].as_array().map(|a| a.iter().filter_map(|e| e["name"].as_str().map(str::to_string)).collect()).unwrap_or_default();
    let mut out = Vec::new();
    for inst in info["instance"].as_array().cloned().unwrap_or_default() {
        let id = inst["instance"].as_u64().unwrap_or(0) as u32;
        let running = inst["running"].as_bool().unwrap_or(false);
        let mut h = HyperInstance { id, name: inst["friendly_name"].as_str().unwrap_or("").to_string(), running, effects: effects.clone(), ..Default::default() };
        if running {
            if let Ok(mut r) = hyper(&[json!({"command":"serverinfo"})], id) {
                let i = r.remove(0)["info"].take();
                h.grabber = i["components"].as_array().and_then(|c| c.iter().find(|x| x["name"] == "SYSTEMGRABBER")).and_then(|x| x["enabled"].as_bool());
                h.source = i["priorities"].as_array().and_then(|p| p.iter().find(|x| x["visible"] == json!(true))).and_then(|x| x["componentId"].as_str()).unwrap_or("idle").to_lowercase();
                h.brightness = i["adjustment"].as_array().and_then(|a| a.first()).and_then(|a| a["scaleOutput"].as_f64()).map(|s| (s * 100.0).round() as i64);
            }
        }
        out.push(h);
    }
    Ok(out)
}

// ---------------------------------------------------------------- HA + vmui

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(6))).build().into()
}

/// Direct Home Assistant access exists only in a developer checkout with its own HA token;
/// an installed copy goes through the hub (`/api/desktop/agent`).
fn ha_direct() -> bool {
    !cred("HA_URL").is_empty() && !cred("HA_TOKEN").is_empty()
}

pub fn ha_post(path: &str, body: Value) -> Result<Value> {
    let url = cred("HA_URL").trim_end_matches('/').to_string();
    let tok = cred("HA_TOKEN");
    if url.is_empty() || tok.is_empty() {
        return Err(anyhow!("dev_only"));
    }
    let r = agent().post(&format!("{url}/api/{path}")).header("Authorization", &format!("Bearer {tok}")).send_json(body)?;
    Ok(r.into_body().read_json::<Value>().unwrap_or(json!(null)))
}

pub fn ha_get(path: &str) -> Result<Value> {
    let url = cred("HA_URL").trim_end_matches('/').to_string();
    let tok = cred("HA_TOKEN");
    if url.is_empty() || tok.is_empty() {
        return Err(anyhow!("dev_only"));
    }
    Ok(agent().get(&format!("{url}/api/{path}")).header("Authorization", &format!("Bearer {tok}")).call()?.into_body().read_json()?)
}

/// HA reachable: directly in a checkout, else as the hub sees it.
pub fn ha_online() -> bool {
    if ha_direct() {
        return ha_get("").is_ok();
    }
    pi_get("/api/desktop/agent", 8).ok().and_then(|v| v["haOnline"].as_bool()).unwrap_or(false)
}

/// Start an HA script without waiting for it: `script.turn_on` returns at once,
/// whereas `script/<name>` blocks for the script's whole run (movie_mode_off
/// has a 7 s delay, longer than the 6 s agent timeout).
pub fn ha_script(name: &str, variables: Value) -> Result<()> {
    let has_vars = variables.as_object().is_some_and(|o| !o.is_empty());
    if !ha_direct() {
        let mut body = json!({"script": name});
        if has_vars {
            body["variables"] = variables;
        }
        return pi_post("/api/desktop/agent", body).map(|_| ());
    }
    let mut body = json!({"entity_id": format!("script.{name}")});
    if has_vars {
        body["variables"] = variables;
    }
    ha_post("services/script/turn_on", body).map(|_| ())
}

/// The window's generic HTTP bridge targets the house vmui (homepi); the
/// local vmui only serves the Hyper-V provider.
pub fn vmui_get(path: &str) -> Result<Value> {
    pi_get(path, 8)
}

pub fn vmui_send(method: &str, path: &str, body: Value) -> Result<Value> {
    pi_send(method, path, body)
}

/// GET against the paired hub with an explicit timeout (long-poll endpoints use 40 s).
pub fn pi_get(path: &str, timeout_secs: u64) -> Result<Value> {
    let a: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(timeout_secs))).build().into();
    let (h, v) = crate::hub::auth()?;
    match a.get(&format!("{}{path}", crate::hub::url())).header(h, &v).call() {
        Ok(r) => Ok(r.into_body().read_json()?),
        Err(ureq::Error::StatusCode(c)) => Err(anyhow!("HTTP {c}")),
        Err(e) => Err(e.into()),
    }
}

pub fn pi_post(path: &str, body: Value) -> Result<Value> {
    pi_send("POST", path, body)
}

pub fn pi_send(method: &str, path: &str, body: Value) -> Result<Value> {
    let u = format!("{}{path}", crate::hub::url());
    let (h, v) = crate::hub::auth()?;
    let r = match method {
        "PUT" => agent().put(&u).header(h, &v).send_json(body),
        _ => agent().post(&u).header(h, &v).send_json(body),
    };
    match r {
        Ok(r) => Ok(r.into_body().read_json::<Value>().unwrap_or(json!({"ok":true}))),
        Err(ureq::Error::StatusCode(c)) => Err(anyhow!("HTTP {c}")),
        Err(e) => Err(e.into()),
    }
}

/// The checkout probes its local vmui (Hyper-V provider); an installed copy probes its hub.
pub fn vmui_ok() -> bool {
    let base = if dev() { VMUI.to_string() } else { crate::hub::url() };
    if base.is_empty() {
        return false;
    }
    match agent().get(&format!("{base}/api/health")).call() {
        Ok(_) => true,
        // 307 -> sign-in still means the server is up
        Err(ureq::Error::StatusCode(c)) => matches!(c, 301 | 302 | 307 | 401 | 403),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------- health

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Health {
    /// ok | warn | down
    pub state: String,
    pub detail: String,
    pub vmui: bool,
    pub ha: bool,
    pub hyper: bool,
    pub grabber: Option<bool>,
    pub source: String,
    pub tasks: Vec<TaskState>,
}

pub fn health() -> Health {
    if !dev() {
        return product_health();
    }
    let tasks = task_states();
    let vm = vmui_ok();
    let ha = ha_online();
    let mut h = Health { vmui: vm, ha, tasks: tasks.clone(), ..Default::default() };
    match hyper_info() {
        Err(_) => {
            h.state = "down".into();
            h.detail = crate::i18n::t("hyperDown");
        }
        Ok(info) => {
            h.hyper = true;
            h.grabber = info["components"].as_array().and_then(|c| c.iter().find(|x| x["name"] == "SYSTEMGRABBER")).and_then(|x| x["enabled"].as_bool());
            h.source = info["priorities"].as_array().and_then(|p| p.iter().find(|x| x["visible"] == json!(true))).and_then(|x| x["componentId"].as_str()).unwrap_or("idle").to_lowercase();
            let missing: Vec<String> = AMBILIGHT_TASKS.iter().filter(|t| !tasks.iter().any(|s| &s.name == *t && s.running)).map(|t| t.replace("vmui-ambilight-", "")).collect();
            if !missing.is_empty() || !vm || !ha {
                h.state = "warn".into();
                let mut parts = Vec::new();
                if !vm {
                    parts.push(crate::i18n::tf("stopped", &[("name", "vmui")]));
                }
                if !ha {
                    parts.push(crate::i18n::t("haDown"));
                }
                if !missing.is_empty() {
                    parts.push(crate::i18n::tf("stopped", &[("name", &missing.join(", "))]));
                }
                h.detail = parts.join(" · ");
            } else {
                h.state = "ok".into();
                h.detail = format!("{} · {}", h.source, crate::i18n::t(if h.grabber == Some(true) { "captureOn" } else { "captureOff" }));
            }
        }
    }
    h
}

/// Installed copy: the hub decides health; HyperHDR on this PC is optional (ambilight is an extra).
fn product_health() -> Health {
    let mut h = Health::default();
    if crate::hub::paired().is_none() {
        h.state = "down".into();
        h.detail = crate::i18n::t("notPaired");
        return h;
    }
    match pi_get("/api/desktop/agent", 8) {
        Err(_) => {
            h.state = "down".into();
            h.detail = crate::i18n::t("hubDown");
        }
        Ok(v) => {
            h.vmui = true;
            h.ha = v["haOnline"].as_bool().unwrap_or(false);
            if let Ok(info) = hyper_info() {
                h.hyper = true;
                h.grabber = info["components"].as_array().and_then(|c| c.iter().find(|x| x["name"] == "SYSTEMGRABBER")).and_then(|x| x["enabled"].as_bool());
                h.source = info["priorities"].as_array().and_then(|p| p.iter().find(|x| x["visible"] == json!(true))).and_then(|x| x["componentId"].as_str()).unwrap_or("idle").to_lowercase();
            }
            if h.ha {
                h.state = "ok".into();
                h.detail = if h.hyper { format!("{} · {}", h.source, crate::i18n::t(if h.grabber == Some(true) { "captureOn" } else { "captureOff" })) } else { crate::i18n::t("connected") };
            } else {
                h.state = "warn".into();
                h.detail = crate::i18n::t("haDown");
            }
        }
    }
    h
}
