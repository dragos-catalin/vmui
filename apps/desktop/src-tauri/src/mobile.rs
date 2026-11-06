//! Android/iOS backend. The phone has no HyperHDR, no Task Scheduler, no repo
//! on disk: everything goes to the Pi's vmui (LAN or Tailscale) with the
//! shared display token, which the user pastes once on the setup screen and
//! we keep in the app's data dir. HA is reached through vmui as well
//! (`/api/display/control`), so a single host + token is all the config.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Conn {
    /// e.g. http://192.168.100.232:3737 — same address on LAN and over Tailscale (subnet router)
    pub url: String,
    pub token: String,
}

static CONN: RwLock<Option<Conn>> = RwLock::new(None);
static FILE: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let f = dir.join("conn.json");
    if let Ok(t) = std::fs::read_to_string(&f) {
        if let Ok(c) = serde_json::from_str::<Conn>(&t) {
            *CONN.write().unwrap() = Some(c);
        }
    }
    *FILE.write().unwrap() = Some(f);
}

pub fn data_dir() -> Option<PathBuf> {
    FILE.read().unwrap().as_ref().and_then(|f| f.parent().map(|p| p.to_path_buf()))
}

pub fn conn() -> Result<Conn> {
    CONN.read().unwrap().clone().filter(|c| !c.url.is_empty() && !c.token.is_empty()).ok_or_else(|| anyhow!("neconfigurat"))
}

pub fn set_conn(c: Conn) -> Result<()> {
    let c = Conn { url: c.url.trim().trim_end_matches('/').to_string(), token: c.token.trim().to_string() };
    if let Some(f) = FILE.read().unwrap().as_ref() {
        std::fs::write(f, serde_json::to_string(&c)?)?;
    }
    *CONN.write().unwrap() = Some(c);
    Ok(())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(8))).build().into()
}

fn url(c: &Conn, path: &str) -> String {
    format!("{}{path}", c.url)
}

pub fn vmui_get(path: &str) -> Result<Value> {
    let c = conn()?;
    let r = agent().get(&url(&c, path)).header("authorization", &format!("Bearer {}", c.token)).call();
    match r {
        Ok(r) => Ok(r.into_body().read_json()?),
        Err(ureq::Error::StatusCode(403)) => Err(anyhow!("acces revocat")),
        Err(e) => Err(e.into()),
    }
}

pub fn vmui_send(method: &str, path: &str, body: Value) -> Result<Value> {
    let c = conn()?;
    let u = url(&c, path);
    let auth = format!("Bearer {}", c.token);
    let r = match method {
        "PUT" => agent().put(&u).header("authorization", &auth).send_json(body),
        _ => agent().post(&u).header("authorization", &auth).send_json(body),
    };
    match r {
        Ok(r) => Ok(r.into_body().read_json::<Value>().unwrap_or(json!({"ok":true}))),
        Err(ureq::Error::StatusCode(403)) => Err(anyhow!("acces revocat")),
        Err(ureq::Error::StatusCode(c)) => Err(anyhow!("HTTP {c}")),
        Err(e) => Err(e.into()),
    }
}

/// Same shape as stack::Health so the UI has one type; on mobile "hyper" means
/// the Pi reports the PC agent alive and "tasks" is empty.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Health {
    pub state: String,
    pub detail: String,
    pub vmui: bool,
    pub ha: bool,
    pub hyper: bool,
    pub grabber: Option<bool>,
    pub source: String,
    pub tasks: Vec<Value>,
}

pub fn health() -> Health {
    let mut h = Health::default();
    match vmui_get("/api/display/state") {
        Err(e) => {
            h.state = "down".into();
            h.detail = if e.to_string().contains("neconfigurat") { "neconfigurat".into() } else { "vmui (Pi) nu răspunde".into() };
        }
        Ok(s) => {
            h.vmui = true;
            h.ha = s["haOnline"].as_bool().unwrap_or(true);
            let pc = vmui_get("/api/desktop/pc").unwrap_or(Value::Null);
            h.hyper = pc["online"].as_bool().unwrap_or(false);
            h.grabber = if h.hyper { pc["grabber"].as_bool() } else { None };
            h.source = pc["source"].as_str().unwrap_or("").to_string();
            let inside = s["inside"]["temp"]["state"].as_str().unwrap_or("");
            h.state = if h.ha { "ok".into() } else { "warn".into() };
            h.detail = if inside.is_empty() { "conectat".into() } else { format!("{inside}° în dormitor") };
        }
    }
    h
}

pub fn app_info(c: Option<&Conn>) -> Value {
    // tauri derives android versionCode from semver as major*1_000_000 + minor*1000 + patch
    let v: Vec<u64> = env!("CARGO_PKG_VERSION").split('.').filter_map(|x| x.parse().ok()).collect();
    let code = v.first().copied().unwrap_or(0) * 1_000_000 + v.get(1).copied().unwrap_or(0) * 1000 + v.get(2).copied().unwrap_or(0);
    json!({
        "root": "",
        "vmui": c.map(|c| c.url.clone()).unwrap_or_default(),
        "haUrl": "",
        "displayUrl": c.and_then(|c| link_url(c, "/display").ok()).unwrap_or_default(),
        "version": env!("CARGO_PKG_VERSION"),
        "versionCode": code,
        "mobile": true,
        "device": crate::pairing::device_name(),
    })
}

/// One-time URL (5 min, this path only) for things that cannot send headers: the system browser
/// downloading the APK, a kiosk tab. The token never appears in a URL (P0-06).
pub fn link_url(c: &Conn, path: &str) -> Result<String> {
    let r = agent().post(&url(c, "/api/devices/link")).header("authorization", &format!("Bearer {}", c.token)).send_json(json!({"path": path}))?;
    let v: Value = r.into_body().read_json()?;
    v["url"].as_str().map(|u| format!("{}{u}", c.url)).ok_or_else(|| anyhow!("no link"))
}
