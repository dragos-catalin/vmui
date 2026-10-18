//! One crate, two runtimes: on desktop the tray owns the process and talks to
//! the local stack; on Android/iOS there is only the window and everything is
//! proxied to the Pi. The frontend calls the same command names on both.

#[cfg(desktop)]
mod agent;
#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod devices;
#[cfg(desktop)]
mod i18n;
#[cfg(desktop)]
mod lights;
#[cfg(mobile)]
mod mobile;
#[cfg(desktop)]
mod notify;
#[cfg(mobile)]
mod pairing;
#[cfg(desktop)]
mod stack;

pub(crate) fn err<T>(r: anyhow::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[cfg(desktop)]
pub fn run() {
    desktop::run()
}

#[cfg(mobile)]
mod mobile_cmds {
    use crate::{err, mobile};
    use serde_json::{json, Value};
    use tauri::Manager;

    #[tauri::command]
    pub async fn health() -> mobile::Health {
        mobile::health()
    }
    #[tauri::command]
    pub async fn vmui_get(path: String) -> Result<Value, String> {
        err(mobile::vmui_get(&path))
    }
    #[tauri::command]
    pub async fn vmui_send(method: String, path: String, body: Value) -> Result<Value, String> {
        err(mobile::vmui_send(&method, &path, body))
    }
    /// Modes go through the Pi (HA scripts) like the Nest Hub does.
    #[tauri::command]
    pub async fn ambilight_mode(mode: String) -> Result<(), String> {
        err(mobile::vmui_send("POST", "/api/display/control", json!({"type":"ambilight","mode":mode})).map(|_| ()))
    }
    /// PC verbs are relayed by the Pi over MQTT to the desktop tray agent.
    #[tauri::command]
    pub async fn pc_action(action: String, value: Option<i64>) -> Result<String, String> {
        err(mobile::vmui_send("POST", "/api/desktop/pc", json!({"action":action,"value":value})).map(|v| v["result"].as_str().unwrap_or("trimis").to_string()))
    }
    #[tauri::command]
    pub async fn hyper_send(commands: Vec<Value>, instances: Option<Vec<u32>>) -> Result<Vec<String>, String> {
        err(mobile::vmui_send("POST", "/api/desktop/pc", json!({"action":"hyper","commands":commands,"instances":instances})).map(|_| Vec::new()))
    }
    #[tauri::command]
    pub async fn hyper_instances() -> Result<Value, String> {
        err(mobile::vmui_get("/api/desktop/pc").map(|v| v["instances"].clone()))
    }
    #[tauri::command]
    pub async fn app_info() -> Value {
        mobile::app_info(mobile::conn().ok().as_ref())
    }
    #[tauri::command]
    pub async fn conn_get() -> Option<mobile::Conn> {
        mobile::conn().ok()
    }
    #[tauri::command]
    pub async fn conn_set(url: String, token: String) -> Result<mobile::Health, String> {
        err(mobile::set_conn(mobile::Conn { url, token }))?;
        Ok(mobile::health())
    }
    #[tauri::command]
    pub async fn conn_clear() {
        let _ = mobile::set_conn(mobile::Conn::default());
    }
    #[tauri::command]
    pub async fn discover() -> Vec<crate::pairing::Found> {
        tauri::async_runtime::spawn_blocking(crate::pairing::discover).await.unwrap_or_default()
    }
    #[tauri::command]
    pub async fn pair_request(url: String) -> Result<crate::pairing::Ticket, String> {
        err(crate::pairing::request(&url, &crate::pairing::device_name(), crate::pairing::platform()))
    }
    #[tauri::command]
    pub async fn pair_login(url: String, email: String, password: String) -> Result<mobile::Health, String> {
        let t = err(crate::pairing::login(&url, &crate::pairing::device_name(), crate::pairing::platform(), &email, &password))?;
        err(mobile::set_conn(mobile::Conn { url, token: t.token }))?;
        Ok(mobile::health())
    }
    /// Polls until approved (returns health) or rejected (Err). Stores the token on success.
    #[tauri::command]
    pub async fn pair_wait(url: String, id: String, token: String) -> Result<mobile::Health, String> {
        loop {
            match crate::pairing::status(&url, &id) {
                Ok(s) if s == "approved" => {
                    err(mobile::set_conn(mobile::Conn { url, token }))?;
                    return Ok(mobile::health());
                }
                Ok(s) if s == "pending" => {}
                Ok(_) => return Err("cerere respinsă".into()),
                Err(e) => return Err(e.to_string()),
            }
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
    }
    /// Unsupported on the phone; the UI hides these pages' local bits.
    #[tauri::command]
    pub async fn tasks() -> Vec<Value> {
        Vec::new()
    }
    /// `vmui://…` the Android activity received (notification tap); consumed once.
    #[tauri::command]
    pub async fn pending_link() -> Option<String> {
        let f = mobile::data_dir()?.join("pending-link.txt");
        let s = std::fs::read_to_string(&f).ok()?;
        let _ = std::fs::remove_file(&f);
        Some(s.trim().to_string()).filter(|s| !s.is_empty())
    }

    pub fn init(app: &tauri::App) {
        let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
        mobile::init(dir);
    }
}

#[cfg(mobile)]
pub fn run() {
    use mobile_cmds::*;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            mobile_cmds::init(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![health, vmui_get, vmui_send, ambilight_mode, pc_action, hyper_send, hyper_instances, app_info, conn_get, conn_set, conn_clear, discover, pair_request, pair_login, pair_wait, tasks, pending_link])
        .run(tauri::generate_context!())
        .expect("vmui mobile");
}

#[cfg(mobile)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn mobile_main() {
    run()
}
