//! Everything the window and the tray talk to: the repo on disk (credentials,
//! ambilight/settings.json, scripts), Task Scheduler, HyperHDR's JSON-API over
//! WebSocket, Home Assistant REST and the local vmui HTTP API.
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
pub const VMUI: &str = "http://127.0.0.1:3737";
/// The house's vmui (homepi). Pairing requests from phones land there.
pub const VMUI_PI: &str = "http://192.168.100.232:3737";
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

/// The vmui checkout. Walk up from the executable (dev: target/debug, prod:
/// wherever it is installed) until a directory holds `ambilight/tray.py`;
/// fall back to VMUI_ROOT then E:\gh\vmui.
pub fn root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        if let Ok(r) = std::env::var("VMUI_ROOT") {
            return PathBuf::from(r);
        }
        let mut p = std::env::current_exe().ok();
        while let Some(dir) = p.as_ref().and_then(|x| x.parent()).map(Path::to_path_buf) {
            if dir.join("ambilight").join("tray.py").exists() {
                return dir;
            }
            if dir.parent().is_none() {
                break;
            }
            p = Some(dir);
        }
        PathBuf::from(r"E:\gh\vmui")
    })
}

pub fn creds() -> &'static HashMap<String, String> {
    static C: OnceLock<HashMap<String, String>> = OnceLock::new();
    C.get_or_init(|| {
        let mut out = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(root().join(".private").join("credentials.env")) {
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

/// Append one line to .copilot-tmp/service-logs/desktop.log (the Servicii page tails it).
pub fn log(msg: &str) {
    let dir = root().join(".copilot-tmp").join("service-logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        use std::io::Write;
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{:02}:{:02}:{:02} {msg}", (t / 3600 + 3) % 24, (t / 60) % 60, t % 60);
    }
}

// ---------------------------------------------------------------- settings.json

pub fn settings_path() -> PathBuf {
    root().join("ambilight").join("settings.json")
}

pub fn read_settings() -> Result<Value> {
    let t = std::fs::read_to_string(settings_path()).context("ambilight/settings.json")?;
    Ok(serde_json::from_str(&t)?)
}

/// Merge `patch` into settings.json (top-level keys) and write it back pretty.
pub fn write_settings(patch: Value) -> Result<Value> {
    let mut cur = read_settings().unwrap_or_else(|_| json!({}));
    if let (Some(c), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            c.insert(k.clone(), v.clone());
        }
    }
    std::fs::write(settings_path(), serde_json::to_string_pretty(&cur)? + "\n")?;
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

pub fn task_states() -> Vec<TaskState> {
    TASKS
        .iter()
        .map(|t| {
            let out = cmd("schtasks").args(["/query", "/tn", t, "/fo", "csv", "/nh"]).output();
            let text = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
            // "\vmui-turzx","N/A","Running"
            let status = text.split(',').nth(2).map(|s| s.trim().trim_matches('"').trim_matches('\r').trim_matches('\n').to_string()).unwrap_or_else(|| "missing".into());
            TaskState { name: t.to_string(), running: status == "Running", status }
        })
        .collect()
}

pub fn task_start(name: &str) -> Result<()> {
    if !TASKS.contains(&name) {
        return Err(anyhow!("unknown task"));
    }
    cmd("schtasks").args(["/run", "/tn", name]).output()?;
    Ok(())
}

pub fn task_stop(name: &str) -> Result<()> {
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

pub fn pc_action(action: &str, value: Option<i64>) -> Result<String> {
    if !PC_ACTIONS.contains(&action) {
        return Err(anyhow!("unknown pc action"));
    }
    let script = root().join("scripts").join("pc-action.ps1");
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

/// Re-push settings.json into HyperHDR (layouts, smoothing, wall compensation).
pub fn ambilight_configure() -> Result<String> {
    let script = root().join("scripts").join("ambilight.ps1");
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
        "tray" | "turzx" | "bridges" | "hyperhdr" | "openrgb" | "vmui" | "desktop" => format!("{name}.log"),
        _ => return Err(anyhow!("unknown log")),
    };
    let p = root().join(".copilot-tmp").join("service-logs").join(file);
    let t = std::fs::read_to_string(&p).unwrap_or_default();
    let v: Vec<&str> = t.lines().collect();
    let start = v.len().saturating_sub(lines);
    Ok(v[start..].join("\n"))
}

pub fn open_path(p: &str) -> Result<()> {
    let target = match p {
        "settings" => settings_path(),
        "logs" => root().join(".copilot-tmp").join("service-logs"),
        "root" => root().to_path_buf(),
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

pub fn ha_post(path: &str, body: Value) -> Result<Value> {
    let url = cred("HA_URL").trim_end_matches('/').to_string();
    let tok = cred("HA_TOKEN");
    if url.is_empty() || tok.is_empty() {
        return Err(anyhow!("HA_URL / HA_TOKEN missing"));
    }
    let r = agent().post(&format!("{url}/api/{path}")).header("Authorization", &format!("Bearer {tok}")).send_json(body)?;
    Ok(r.into_body().read_json::<Value>().unwrap_or(json!(null)))
}

pub fn ha_get(path: &str) -> Result<Value> {
    let url = cred("HA_URL").trim_end_matches('/').to_string();
    let tok = cred("HA_TOKEN");
    if url.is_empty() || tok.is_empty() {
        return Err(anyhow!("HA_URL / HA_TOKEN missing"));
    }
    Ok(agent().get(&format!("{url}/api/{path}")).header("Authorization", &format!("Bearer {tok}")).call()?.into_body().read_json()?)
}

pub fn vmui_token() -> String {
    cred("ESP_DISPLAY_TOKEN")
}

/// Start an HA script without waiting for it: `script.turn_on` returns at once,
/// whereas `script/<name>` blocks for the script's whole run (movie_mode_off
/// has a 7 s delay, longer than the 6 s agent timeout).
pub fn ha_script(name: &str, variables: Value) -> Result<()> {
    let mut body = json!({"entity_id": format!("script.{name}")});
    if variables.as_object().is_some_and(|o| !o.is_empty()) {
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

/// GET against the Pi with an explicit timeout (long-poll endpoints use 40 s).
pub fn pi_get(path: &str, timeout_secs: u64) -> Result<Value> {
    let sep = if path.contains('?') { '&' } else { '?' };
    let a: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(timeout_secs))).build().into();
    match a.get(&format!("{VMUI_PI}{path}{sep}k={}", vmui_token())).call() {
        Ok(r) => Ok(r.into_body().read_json()?),
        Err(ureq::Error::StatusCode(c)) => Err(anyhow!("HTTP {c}")),
        Err(e) => Err(e.into()),
    }
}

pub fn pi_post(path: &str, body: Value) -> Result<Value> {
    pi_send("POST", path, body)
}

pub fn pi_send(method: &str, path: &str, body: Value) -> Result<Value> {
    let sep = if path.contains('?') { '&' } else { '?' };
    let u = format!("{VMUI_PI}{path}{sep}k={}", vmui_token());
    let r = match method {
        "PUT" => agent().put(&u).send_json(body),
        _ => agent().post(&u).send_json(body),
    };
    match r {
        Ok(r) => Ok(r.into_body().read_json::<Value>().unwrap_or(json!({"ok":true}))),
        Err(ureq::Error::StatusCode(c)) => Err(anyhow!("HTTP {c}")),
        Err(e) => Err(e.into()),
    }
}

pub fn vmui_ok() -> bool {
    match agent().get(&format!("{VMUI}/api/health")).call() {
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
    let tasks = task_states();
    let vm = vmui_ok();
    let ha = ha_get("").is_ok();
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
