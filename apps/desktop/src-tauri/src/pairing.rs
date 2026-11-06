//! Autodiscovery + pairing, shared by desktop and mobile.
//!
//! discover(): mDNS `_vmui._tcp` on the LAN (avahi advert on the Pi), then a
//! parallel probe of well-known names (`homepi` via Tailscale MagicDNS,
//! `homepi.local`, the Pi's LAN IP). First `/api/discover` that says
//! `app: vmui` wins.
//!
//! pair(): POST /api/devices/pair → {id, token, code}; the UI shows the code
//! while status() is polled until someone approves it from the web, the
//! desktop app or an already-paired phone. login() skips approval by proving
//! the vmui account.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Found {
    pub url: String,
    pub host: String,
    pub via: String,
}

const CANDIDATES: &[&str] = &["http://homepi:3737", "http://homepi.local:3737", "http://192.168.100.232:3737"];

fn agent(secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(secs))).build().into()
}

fn identify(url: &str, via: &str) -> Option<Found> {
    let v: Value = agent(3).get(&format!("{url}/api/discover")).call().ok()?.into_body().read_json().ok()?;
    (v["app"].as_str() == Some("vmui")).then(|| Found { url: url.to_string(), host: v["host"].as_str().unwrap_or("").to_string(), via: via.to_string() })
}

pub fn discover() -> Vec<Found> {
    let (tx, rx) = mpsc::channel::<Found>();
    for c in CANDIDATES {
        let tx = tx.clone();
        let c = c.to_string();
        std::thread::spawn(move || {
            if let Some(f) = identify(&c, "dns") {
                let _ = tx.send(f);
            }
        });
    }
    for service in ["_vatra._tcp.local.", "_vmui._tcp.local."] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let Ok(d) = mdns_sd::ServiceDaemon::new() else { return };
            let Ok(rx) = d.browse(service) else { return };
            let until = std::time::Instant::now() + Duration::from_secs(4);
            while let Ok(ev) = rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now())) {
                if let mdns_sd::ServiceEvent::ServiceResolved(info) = ev {
                    for ip in info.get_addresses() {
                        if ip.is_ipv4() {
                            let url = format!("http://{}:{}", ip, info.get_port());
                            if let Some(f) = identify(&url, "mdns") {
                                let _ = tx.send(f);
                            }
                        }
                    }
                }
            }
            let _ = d.shutdown();
        });
    }
    drop(tx);
    let mut out: Vec<Found> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while let Ok(f) = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
        if !out.iter().any(|o| o.url == f.url) {
            out.push(f);
        }
    }
    // stable preference: mDNS (LAN, fastest) > Tailscale name > raw IP
    out.sort_by_key(|f| match f.via.as_str() { "mdns" => 0, _ if f.url.contains("homepi:") => 1, _ => 2 });
    out
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Ticket {
    pub id: String,
    pub token: String,
    pub code: String,
    pub status: String,
}

pub fn request(url: &str, name: &str, platform: &str) -> Result<Ticket> {
    let v: Value = agent(8).post(&format!("{url}/api/devices/pair")).send_json(json!({"name": name, "platform": platform}))?.into_body().read_json()?;
    Ok(Ticket { id: v["id"].as_str().unwrap_or("").into(), token: v["token"].as_str().unwrap_or("").into(), code: v["code"].as_str().unwrap_or("").into(), status: v["status"].as_str().unwrap_or("").into() })
}

pub fn login(url: &str, name: &str, platform: &str, email: &str, password: &str) -> Result<Ticket> {
    let r = agent(8).post(&format!("{url}/api/devices/pair")).send_json(json!({"name": name, "platform": platform, "email": email, "password": password}));
    let v: Value = match r {
        Ok(r) => r.into_body().read_json()?,
        Err(ureq::Error::StatusCode(401)) => return Err(anyhow!("email sau parolă greșită")),
        Err(e) => return Err(e.into()),
    };
    Ok(Ticket { id: v["id"].as_str().unwrap_or("").into(), token: v["token"].as_str().unwrap_or("").into(), code: String::new(), status: "approved".into() })
}

pub fn status(url: &str, id: &str) -> Result<String> {
    let v: Value = agent(8).get(&format!("{url}/api/devices/pair?id={id}")).call()?.into_body().read_json()?;
    Ok(v["status"].as_str().unwrap_or("rejected").to_string())
}

pub fn device_name() -> String {
    #[cfg(target_os = "android")]
    {
        // ro.product.model via getprop is the closest thing to "Galaxy A51" without JNI
        if let Ok(o) = std::process::Command::new("getprop").arg("ro.product.model").output() {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
        return "Android".into();
    }
    #[allow(unreachable_code)]
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "desktop".into())
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "android") { "android" } else if cfg!(target_os = "ios") { "ios" } else if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" }
}
