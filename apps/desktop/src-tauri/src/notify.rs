//! Desktop: mirror the vmui notification centre as Windows toasts. Follows
//! `/api/notify/stream` (SSE) on the Pi; each `upsert` becomes a toast with
//! the card's buttons, each `dismiss` removes it. Button presses go back to
//! `/api/notify/act`; the tap opens the card's deep link (codai://…) or the
//! window's Notificări page. Acks cancel the HA Companion fallback.

use crate::stack;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static SHOWN: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

pub fn run(app: AppHandle) {
    #[cfg(windows)]
    if let Err(e) = register_aumid(&app) {
        stack::log(&format!("notify: aumid: {e}"));
    }
    loop {
        if let Err(e) = follow(&app) {
            stack::log(&format!("notify: stream ended: {e}"));
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

fn follow(app: &AppHandle) -> anyhow::Result<()> {
    let a: ureq::Agent = ureq::Agent::config_builder().timeout_global(None).build().into();
    let url = format!("{}/api/notify/stream?k={}", stack::VMUI_PI, stack::vmui_token());
    let r = a.get(&url).call()?;
    let mut rd = BufReader::new(r.into_body().into_reader());
    let mut event = String::new();
    let mut data = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        if rd.read_line(&mut line)? == 0 {
            anyhow::bail!("eof");
        }
        let l = line.trim_end();
        if let Some(v) = l.strip_prefix("event: ") {
            event = v.to_string();
        } else if let Some(v) = l.strip_prefix("data: ") {
            data.push_str(v);
        } else if l.is_empty() && !event.is_empty() {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                handle(app, &event, v);
            }
            event.clear();
            data.clear();
        }
    }
}

fn handle(app: &AppHandle, event: &str, v: Value) {
    match event {
        "snapshot" => {
            // cards that appeared while we were away: toast only the unread ones, once
            let mut shown = SHOWN.lock().unwrap();
            let first = shown.is_none();
            let m = shown.get_or_insert_with(HashMap::new);
            let cards = v["cards"].as_array().cloned().unwrap_or_default();
            for c in &cards {
                let id = c["id"].as_str().unwrap_or("").to_string();
                let at = c["updatedAt"].as_str().map(|s| s.len() as u64).unwrap_or(0);
                if first && c["readAt"].is_null() && !m.contains_key(&id) {
                    show(app, c);
                }
                m.insert(id, at);
            }
            let _ = app.emit("notify", json!({"type":"snapshot","cards":cards}));
        }
        "upsert" => {
            let id = v["id"].as_str().unwrap_or("").to_string();
            // in-place updates (progress, agents summary) re-toast only if the title changed;
            // Windows replaces by tag anyway so the user sees one card
            SHOWN.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, 0);
            show(app, &v);
            let _ = app.emit("notify", json!({"type":"upsert","card":v}));
        }
        "dismiss" => {
            let id = v["id"].as_str().unwrap_or("");
            SHOWN.lock().unwrap().get_or_insert_with(HashMap::new).remove(id);
            let _ = app.emit("notify", json!({"type":"dismiss","card":v}));
        }
        _ => {}
    }
}

pub fn act(id: &str, action: &str) -> anyhow::Result<Value> {
    stack::pi_post("/api/notify/act", json!({"id":id,"action":action}))
}

fn ack(id: &str) {
    let _ = stack::pi_post("/api/notify", json!({"op":"ack","ids":[id]}));
}

fn show(app: &AppHandle, c: &Value) {
    let id = c["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return;
    }
    ack(&id);
    #[cfg(windows)]
    {
        if let Err(e) = toast(app, c) {
            stack::log(&format!("notify: toast failed: {e}"));
        }
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(c["title"].as_str().unwrap_or("vmui")).body(c["body"].as_str().unwrap_or("")).show();
    }
}

#[cfg(windows)]
const APP_ID: &str = "ro.dragoscatalin.vmui";

/// Unpackaged exes have no AppUserModelID, and Windows silently drops toasts
/// for an unknown one. Register it under HKCU and tag the process so buttons
/// activate back into us.
#[cfg(windows)]
fn register_aumid(_app: &AppHandle) -> anyhow::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let (k, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!("Software\\Classes\\AppUserModelId\\{APP_ID}"))?;
    k.set_value("DisplayName", &"vmui")?;
    let dir = std::env::temp_dir().join("vmui-toast");
    std::fs::create_dir_all(&dir)?;
    let icon = dir.join("app.png");
    std::fs::write(&icon, include_bytes!("../icons/128x128.png"))?;
    k.set_value("IconUri", &icon.to_string_lossy().to_string())?;
    k.set_value("IconBackgroundColor", &"FF0B0F1A")?;
    let wide: Vec<u16> = APP_ID.encode_utf16().chain(std::iter::once(0)).collect();
    let hr = unsafe { windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
    if hr < 0 {
        anyhow::bail!("SetCurrentProcessExplicitAppUserModelID hr={hr:#x}");
    }
    Ok(())
}

#[cfg(windows)]
fn toast(app: &AppHandle, c: &Value) -> anyhow::Result<()> {
    use tauri_winrt_notification::{Duration as TDur, IconCrop, Progress, Scenario, Sound, Toast};
    let id = c["id"].as_str().unwrap_or("").to_string();
    let kind = c["kind"].as_str().unwrap_or("system");
    let priority = c["priority"].as_str().unwrap_or("default");
    let title = c["title"].as_str().unwrap_or("vmui");
    let body = c["body"].as_str().unwrap_or("");
    let subtitle = c["subtitle"].as_str().unwrap_or("");
    let url = c["url"].as_str().unwrap_or("").to_string();

    let mut t = Toast::new(APP_ID).title(title).text1(body).text2(subtitle);
    t = match priority {
        "urgent" => t.scenario(Scenario::Reminder).duration(TDur::Long),
        "high" => t.duration(TDur::Long),
        "low" => t.sound(None).duration(TDur::Short),
        _ => t.duration(TDur::Short),
    };
    if kind == "intercom" {
        t = t.scenario(Scenario::IncomingCall).sound(Some(Sound::Reminder));
    }
    if let Some(p) = kind_icon(kind, c["color"].as_str()) {
        t = t.icon(&p, IconCrop::Circular, kind);
    }
    if let Some(img) = c["image"].as_str().filter(|s| !s.is_empty()) {
        if let Some(p) = cache_image(&id, img) {
            t = t.hero(&p, "");
        }
    }
    if let Some(pr) = c["progress"].as_u64() {
        t = t.progress(&Progress { tag: id.clone(), title: String::new(), status: String::new(), value: pr as f32 / 100.0, value_string: format!("{pr} %") });
    }
    let mut actions: Vec<(String, Option<String>)> = Vec::new();
    for a in c["actions"].as_array().into_iter().flatten().take(3) {
        let aid = a["id"].as_str().unwrap_or("");
        let label = a["label"].as_str().unwrap_or("");
        if aid.is_empty() || label.is_empty() {
            continue;
        }
        t = t.add_button(label, aid);
        actions.push((aid.to_string(), a["url"].as_str().map(str::to_string)));
    }
    let app2 = app.clone();
    let id2 = id.clone();
    t = t.on_activated(move |arg| {
        match arg.as_deref() {
            None | Some("") => {
                // body tap: deep link if any, else the window's Notificări page
                if !url.is_empty() {
                    open_url(&app2, &url);
                    let _ = stack::pi_post("/api/notify", json!({"op":"read","ids":[id2]}));
                } else {
                    let _ = app2.emit("navigate", json!({"page":"notificari","id":id2}));
                    crate::desktop::show_main(&app2);
                }
            }
            Some(aid) => {
                if let Some((_, Some(u))) = actions.iter().find(|(a, _)| a == aid) {
                    open_url(&app2, u);
                    let _ = stack::pi_post("/api/notify", json!({"op":"read","ids":[id2]}));
                } else {
                    let r = act(&id2, aid);
                    let text = match &r {
                        Ok(v) if v["ok"].as_bool() == Some(true) => v["message"].as_str().unwrap_or("gata").to_string(),
                        Ok(v) => v["error"].as_str().unwrap_or("nu a mers").to_string(),
                        Err(e) => e.to_string(),
                    };
                    let _ = app2.emit("toast", json!({"kind": if r.is_ok() {"ok"} else {"error"}, "text": text}));
                }
            }
        }
        Ok(())
    });
    t.show().map_err(|e| anyhow::anyhow!("{e:?}"))
}

fn open_url(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        let _ = app.emit("toast", json!({"kind":"error","text":format!("nu pot deschide {url}: {e}")}));
    }
}

/// A 96 px disc in the kind's colour with the app glyph, cached under app-data.
#[cfg(windows)]
fn kind_icon(kind: &str, color: Option<&str>) -> Option<std::path::PathBuf> {
    let hex = color.filter(|c| c.len() == 7 && c.starts_with('#')).unwrap_or(match kind {
        "copilot" | "agents" => "#6366f1",
        "intercom" => "#ff5a1f",
        "pairing" => "#22c55e",
        "water" | "window" => "#8fd3ff",
        "pc" => "#7cff9a",
        "pi" | "door" => "#f2b85a",
        "presence" => "#c084fc",
        "battery" => "#ff7a7a",
        "contact" => "#38bdf8",
        _ => "#94a3b8",
    });
    let dir = std::env::temp_dir().join("vmui-toast");
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join(format!("{}.png", &hex[1..]));
    if !p.exists() {
        let r = u8::from_str_radix(&hex[1..3], 16).ok()?;
        let g = u8::from_str_radix(&hex[3..5], 16).ok()?;
        let b = u8::from_str_radix(&hex[5..7], 16).ok()?;
        let n = 96u32;
        let mut px = vec![0u8; (n * n * 4) as usize];
        let c = (n as f32 - 1.0) / 2.0;
        for y in 0..n {
            for x in 0..n {
                let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
                let a = ((c - d + 0.5).clamp(0.0, 1.0) * 255.0) as u8;
                let i = ((y * n + x) * 4) as usize;
                px[i] = r;
                px[i + 1] = g;
                px[i + 2] = b;
                px[i + 3] = a;
            }
        }
        let f = std::fs::File::create(&p).ok()?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(f), n, n);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&px).ok()?;
    }
    Some(p)
}

#[cfg(windows)]
fn cache_image(id: &str, url: &str) -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join("vmui-toast");
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join(format!("img-{id}.jpg"));
    let a: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(8))).build().into();
    let mut r = a.get(url).call().ok()?;
    let bytes = r.body_mut().read_to_vec().ok()?;
    std::fs::write(&p, bytes).ok()?;
    Some(p)
}

/// Tauri command surface for the window's Notificări page.
#[tauri::command]
pub fn notify_list(all: bool) -> Result<Value, String> {
    stack::pi_get(&format!("/api/notify{}", if all { "?all=1" } else { "" }), 15).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notify_act(id: String, action: String) -> Result<Value, String> {
    act(&id, &action).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notify_op(op: String, id: Option<String>, ids: Option<Vec<String>>) -> Result<Value, String> {
    let mut b = json!({"op": op});
    if let Some(i) = id { b["id"] = json!(i); }
    if let Some(i) = ids { b["ids"] = json!(i); }
    stack::pi_post("/api/notify", b).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notify_settings(save: Option<Value>) -> Result<Value, String> {
    match save {
        Some(v) => stack::pi_send("PUT", "/api/notify/settings", v).map_err(|e| e.to_string()),
        None => stack::pi_get("/api/notify/settings", 15).map_err(|e| e.to_string()),
    }
}
