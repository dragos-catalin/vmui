//! Desktop: watch the Pi's /api/devices for pairing requests. A new phone
//! shows up as a Windows toast + a tray submenu entry ("Aprobă Galaxy A51 ·
//! 4821"), and the window gets a `devices` event for its banner. Approving
//! from here goes straight back to the Pi with the shared token.

use crate::i18n::{t, tf};
use crate::stack;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

/// The submenu is recreated when the tray menu is rebuilt (language change);
/// the last pending list is kept so the new one is filled immediately.
#[derive(Default)]
pub struct DevicesMenu {
    sub: Mutex<Option<Submenu<Wry>>>,
    items: Mutex<Vec<MenuItem<Wry>>>,
    pending: Mutex<Vec<Value>>,
}

pub fn attach(app: &AppHandle, sub: Submenu<Wry>) {
    if app.try_state::<DevicesMenu>().is_none() {
        app.manage(DevicesMenu::default());
    }
    let m = app.state::<DevicesMenu>();
    *m.sub.lock().unwrap() = Some(sub);
    m.items.lock().unwrap().clear();
    let pending = m.pending.lock().unwrap().clone();
    rebuild_menu(app, &pending);
}

pub fn approve(id: &str, code: &str) -> anyhow::Result<()> {
    let v = stack::pi_post("/api/devices", json!({"op":"approve","id":id,"code":code}))?;
    if v["ok"].as_bool() == Some(true) { Ok(()) } else { Err(anyhow::anyhow!(v["error"].as_str().unwrap_or("eroare").to_string())) }
}

pub fn reject(id: &str) -> anyhow::Result<()> {
    stack::pi_post("/api/devices", json!({"op":"reject","id":id})).map(|_| ())
}

fn rebuild_menu(app: &AppHandle, pending: &[Value]) {
    let Some(m) = app.try_state::<DevicesMenu>() else { return };
    *m.pending.lock().unwrap() = pending.to_vec();
    // submenu calls block on the main thread, which may be rebuilding the
    // tray (and calling attach) right now: take what we need, drop the locks
    let Some(sub) = m.sub.lock().unwrap().clone() else { return };
    let old: Vec<MenuItem<Wry>> = m.items.lock().unwrap().drain(..).collect();
    for it in old {
        let _ = sub.remove(&it);
    }
    let mut items = Vec::new();
    if pending.is_empty() {
        if let Ok(it) = MenuItem::with_id(app, "devices:none", t("noRequests"), false, None::<&str>) {
            let _ = sub.append(&it);
            items.push(it);
        }
    }
    for p in pending {
        let id = p["id"].as_str().unwrap_or("");
        let code = p["code"].as_str().unwrap_or("");
        let name = p["name"].as_str().unwrap_or("?");
        if let Ok(it) = MenuItem::with_id(app, format!("approve:{id}:{code}"), tf("approve", &[("name", name), ("code", code)]), true, None::<&str>) {
            let _ = sub.append(&it);
            items.push(it);
        }
        if let Ok(it) = MenuItem::with_id(app, format!("reject:{id}"), format!("   {}", tf("reject", &[("name", name)])), true, None::<&str>) {
            let _ = sub.append(&it);
            items.push(it);
        }
    }
    *m.items.lock().unwrap() = items;
}

pub fn run(app: AppHandle) {
    let mut announced: HashSet<String> = HashSet::new();
    let mut since: Option<u64> = None;
    loop {
        let path = match since { Some(v) => format!("/api/devices?since={v}"), None => "/api/devices".to_string() };
        match stack::pi_get(&path, 40) {
            Ok(v) => {
                since = v["version"].as_u64();
                let pending = v["pending"].as_array().cloned().unwrap_or_default();
                for p in &pending {
                    let id = p["id"].as_str().unwrap_or("").to_string();
                    if announced.insert(id.clone()) {
                        let name = p["name"].as_str().unwrap_or("?");
                        let code = p["code"].as_str().unwrap_or("");
                        match app.notification().builder().title(tf("accessRequestTitle", &[("name", name)])).body(tf("accessRequestBody", &[("code", code)])).show() {
                            Ok(()) => stack::log(&format!("devices: toast for {name} ({code})")),
                            Err(e) => stack::log(&format!("devices: toast failed: {e}")),
                        }
                        let _ = app.emit("toast", json!({"kind":"info","text":format!("{} · {code}", tf("accessRequestTitle", &[("name", name)]))}));
                    }
                }
                announced.retain(|id| pending.iter().any(|p| p["id"].as_str() == Some(id)));
                rebuild_menu(&app, &pending);
                let _ = app.emit("devices", &v);
            }
            Err(_) => std::thread::sleep(Duration::from_secs(10)),
        }
    }
}

/// Tray menu ids `approve:<id>:<code>` / `reject:<id>`.
pub fn handle_menu(app: &AppHandle, id: &str) -> bool {
    if let Some(rest) = id.strip_prefix("approve:") {
        let mut it = rest.splitn(2, ':');
        let (dev, code) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
        let r = approve(dev, code);
        let _ = app.emit("toast", json!({"kind": if r.is_ok() {"ok"} else {"error"}, "text": match &r { Ok(_) => t("approved"), Err(e) => e.to_string() }}));
        return true;
    }
    if let Some(dev) = id.strip_prefix("reject:") {
        let _ = reject(dev);
        return true;
    }
    false
}
