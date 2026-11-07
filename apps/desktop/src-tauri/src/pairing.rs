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

/// Names a hub answers to without mDNS: the image's generic name, then the original house Pi
/// over Tailscale MagicDNS. No raw LAN address: an installed copy must not assume this house.
const CANDIDATES: &[&str] = &["http://vatra.local:3737", "http://homepi:3737", "http://homepi.local:3737"];

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

/// QR / deep-link pairing: a one-time invite minted by a signed-in member is redeemed for an
/// approved token straight away (`vatra://pair?h=<hub>&c=<invite>`).
pub fn redeem(url: &str, name: &str, platform: &str, invite: &str) -> Result<Ticket> {
    let r = agent(8).post(&format!("{url}/api/devices/pair")).send_json(json!({"name": name, "platform": platform, "invite": invite}));
    let v: Value = match r {
        Ok(r) => r.into_body().read_json()?,
        Err(ureq::Error::StatusCode(401)) => return Err(anyhow!("invite_invalid")),
        Err(e) => return Err(e.into()),
    };
    Ok(Ticket { id: v["id"].as_str().unwrap_or("").into(), token: v["token"].as_str().unwrap_or("").into(), code: String::new(), status: "approved".into() })
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PairLink {
    pub hub: String,
    pub invite: String,
}

fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Same rules as the Android/iOS PairLink: only `vatra://pair`, an http(s) origin and a
/// 16-64 char URL-safe invite; anything else (a stray QR, a link with a path) is ignored.
pub fn parse_link(raw: &str) -> Option<PairLink> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("vatra") {
        return None;
    }
    let (host, query) = rest.split_once('?')?;
    if !host.trim_end_matches('/').eq_ignore_ascii_case("pair") {
        return None;
    }
    let (mut h, mut c) = (None, None);
    for kv in query.split('&') {
        let (k, v) = kv.split_once('=')?;
        match k {
            "h" => h = pct_decode(v),
            "c" => c = pct_decode(v),
            _ => {}
        }
    }
    let hub = normalise_hub(&h?)?;
    let invite = c.filter(|c| (16..=64).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))?;
    Some(PairLink { hub, invite })
}

/// An http(s) origin only: no credentials, path, query or fragment (a QR must not point the token elsewhere).
pub fn normalise_hub(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let with = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let (scheme, rest) = with.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty() || authority.contains(['/', '?', '#', '@', ' ']) {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, _)) if !h.ends_with(']') && h.contains(':') => (authority, None), // bare IPv6
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._[]:".contains(&b)) {
        return None;
    }
    let port = match port {
        Some(p) => Some(p.parse::<u16>().ok().filter(|p| *p > 0)?),
        None => None,
    };
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_ascii_lowercase() };
    Some(match port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    // the same cases as apps/android PairingTest.kt and apps/ios PairingTests.swift
    #[test]
    fn parses_a_well_formed_invite() {
        let l = parse_link("vatra://pair?h=http%3A%2F%2F192.168.1.5%3A3737&c=AbCdEfGhIjKlMnOpQrStUv").unwrap();
        assert_eq!(l.hub, "http://192.168.1.5:3737");
        assert_eq!(l.invite, "AbCdEfGhIjKlMnOpQrStUv");
    }

    #[test]
    fn refuses_anything_else() {
        for bad in [
            "vatra://pair?h=http%3A%2F%2Fhub&c=short",
            "vatra://pair?h=file%3A%2F%2F%2Fetc&c=AbCdEfGhIjKlMnOpQrStUv",
            "vatra://pair?h=http%3A%2F%2Fu%3Ap%40hub&c=AbCdEfGhIjKlMnOpQrStUv",
            "vatra://pair?h=http%3A%2F%2Fhub%2Fapi&c=AbCdEfGhIjKlMnOpQrStUv",
            "vatra://do?a=scene&id=x",
            "https://pair?h=http%3A%2F%2Fhub&c=AbCdEfGhIjKlMnOpQrStUv",
            "vatra://pair?h=http%3A%2F%2Fhub&c=AbCdEfGhIjKlMnOp%3BrStUv",
        ] {
            assert!(parse_link(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn normalises_hub_origins() {
        assert_eq!(normalise_hub("hub.local:3737").as_deref(), Some("http://hub.local:3737"));
        assert_eq!(normalise_hub("HTTPS://Hub.Example/").as_deref(), Some("https://hub.example"));
        assert_eq!(normalise_hub("http://[fd00::1]:3737").as_deref(), Some("http://[fd00::1]:3737"));
        assert!(normalise_hub("http://hub:99999").is_none());
        assert!(normalise_hub("http://hub/x").is_none());
        assert!(normalise_hub("ftp://hub").is_none());
    }
}
