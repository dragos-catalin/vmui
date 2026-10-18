//! PC agent (desktop only): lets the phone reach this PC when it is away.
//!
//! Subscribes to `vmui/pc/cmd` on the Pi's Mosquitto and runs the same fixed
//! verbs the tray exposes; publishes `vmui/pc/state` retained every 15 s so
//! HA's `sensor.vmui_pc_agent` (pi/ha-packages/vmui_pc.yaml) and therefore
//! vmui's /api/desktop/pc know the PC is up, what HyperHDR shows and which
//! mode is active. Commands older than 60 s are dropped (retained/replayed
//! after a reconnect must not lock the PC).

use crate::{lights, stack};
use rumqttc::{Client, Event, Incoming, MqttOptions, QoS};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{OnceLock, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const CMD: &str = "vmui/pc/cmd";
const STATE: &str = "vmui/pc/state";

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// HyperHDR logins take seconds each, so the heartbeat must never wait on them:
/// a background thread refreshes this snapshot and the publisher only reads it.
static INSTANCES: OnceLock<Mutex<Vec<stack::HyperInstance>>> = OnceLock::new();

fn instances_cache() -> &'static Mutex<Vec<stack::HyperInstance>> {
    INSTANCES.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn cached_instances() -> Vec<stack::HyperInstance> {
    instances_cache().lock().unwrap().clone()
}

/// After a grabber change, update the snapshot so the tray checkmark does not
/// lag up to 30 s behind.
pub fn set_cached_grabber(ids: &[u32], on: bool) {
    for i in instances_cache().lock().unwrap().iter_mut().filter(|i| ids.contains(&i.id) && i.running) {
        i.grabber = Some(on);
    }
}

fn refresh_instances_forever() {
    loop {
        if let Ok(v) = stack::hyper_instances() {
            *instances_cache().lock().unwrap() = v;
        }
        std::thread::sleep(Duration::from_secs(30));
    }
}

fn state_payload(app: &AppHandle) -> String {
    let last = app.state::<crate::desktop::State>().last.lock().unwrap().clone();
    let mode = app.state::<crate::desktop::State>().mode.lock().unwrap().clone();
    let instances = instances_cache().lock().unwrap().clone();
    json!({
        "state": "online",
        "at": now(),
        "host": std::env::var("COMPUTERNAME").unwrap_or_default(),
        "mode": mode,
        "grabber": last.as_ref().and_then(|h| h.grabber),
        "source": last.as_ref().map(|h| h.source.clone()).unwrap_or_default(),
        "hyper": last.as_ref().map(|h| h.hyper).unwrap_or(false),
        "instances": instances,
        "ble": lights::ble_cached(),
    })
    .to_string()
}

fn handle(app: &AppHandle, cmd: Value, seen: &Mutex<HashSet<String>>) {
    let id = cmd["id"].as_str().unwrap_or("").to_string();
    if !id.is_empty() && !seen.lock().unwrap().insert(id.clone()) {
        return; // duplicate delivery
    }
    if now().saturating_sub(cmd["at"].as_u64().unwrap_or(0)) > 60 {
        stack::log(&format!("agent: stale cmd dropped {cmd}"));
        return;
    }
    let action = cmd["action"].as_str().unwrap_or("");
    let res: Result<String, String> = match action {
        "hyper" => {
            let commands: Vec<Value> = cmd["commands"].as_array().cloned().unwrap_or_default();
            let inst: Vec<u32> = cmd["instances"].as_array().map(|a| a.iter().filter_map(|v| v.as_u64().map(|x| x as u32)).collect()).filter(|v: &Vec<u32>| !v.is_empty()).unwrap_or_else(|| stack::HYPER_INSTANCES.to_vec());
            let errs = stack::hyper_all(&commands, &inst);
            if errs.is_empty() { Ok("ok".into()) } else { Err(errs.join("; ")) }
        }
        "mode" => crate::desktop::set_mode(app, cmd["mode"].as_str().unwrap_or("")).map(|_| "ok".into()),
        "light" => lights::apply_light(&cmd).map_err(|e| e.to_string()),
        "led_count" => lights::apply_led_count(&cmd).map_err(|e| e.to_string()),
        "ble_scan" => lights::ble_scan(cmd["seconds"].as_u64().unwrap_or(8)).map(|v| format!("{} found", v.as_array().map_or(0, Vec::len))).map_err(|e| e.to_string()),
        a if stack::PC_ACTIONS.contains(&a) => stack::pc_action(a, cmd["value"].as_i64()).map_err(|e| e.to_string()),
        _ => Err(format!("unknown action {action:?}")),
    };
    match &res {
        Ok(r) => stack::log(&format!("agent: {action} -> {r}")),
        Err(e) => stack::log(&format!("agent: {action} failed: {e}")),
    }
    // light commands arrive from every surface (web, MCP, scenes); toasting each would be noise
    if !matches!(action, "light" | "led_count") {
        let text = format!("{} {}", crate::i18n::tf("phoneAction", &[("action", action)]), if res.is_ok() { "✓" } else { "✗" });
        let _ = app.emit("toast", json!({"kind": if res.is_ok() {"info"} else {"error"}, "text": text}));
    }
}

/// Runs forever on its own thread; reconnects with backoff. No-op if MQTT creds are missing.
pub fn run(app: AppHandle) {
    let c = stack::creds();
    let (Some(user), Some(pass)) = (c.get("MQTT_USER"), c.get("MQTT_PASS")) else {
        stack::log("agent: MQTT_USER/PASS missing, PC agent off");
        return;
    };
    // the broker is the Pi's Mosquitto (MQTT_HOST in credentials.env is a stale pre-homepi address)
    let host = stack::VMUI_PI.trim_start_matches("http://").split(':').next().unwrap_or("192.168.100.232").to_string();
    let user = user.clone();
    let pass = pass.clone();
    let seen = Arc::new(Mutex::new(HashSet::new()));
    std::thread::spawn(refresh_instances_forever);
    std::thread::spawn(lights::refresh_ble_forever);
    let mut backoff = 5u64;
    loop {
        let mut opts = MqttOptions::new(format!("vmui-pc-{}", std::env::var("COMPUTERNAME").unwrap_or_else(|_| "pc".into())), &host, 1883);
        opts.set_credentials(&user, &pass);
        opts.set_keep_alive(Duration::from_secs(30));
        opts.set_last_will(rumqttc::LastWill::new(STATE, json!({"state":"offline","at":now()}).to_string(), QoS::AtLeastOnce, true));
        let (client, mut conn) = Client::new(opts, 16);
        let publisher = {
            let client = client.clone();
            let app = app.clone();
            std::thread::spawn(move || loop {
                if client.publish(STATE, QoS::AtLeastOnce, true, state_payload(&app)).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_secs(15));
            })
        };
        let mut ok = false;
        for ev in conn.iter() {
            match ev {
                Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                    ok = true;
                    backoff = 5;
                    let _ = client.subscribe(CMD, QoS::AtLeastOnce);
                    stack::log("agent: connected");
                }
                Ok(Event::Incoming(Incoming::Publish(p))) if p.topic == CMD => {
                    if let Ok(v) = serde_json::from_slice::<Value>(&p.payload) {
                        let app = app.clone();
                        let seen = seen.clone();
                        std::thread::spawn(move || handle(&app, v, &seen));
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    stack::log(&format!("agent: {e}"));
                    break;
                }
            }
        }
        drop(client);
        let _ = publisher.join();
        if !ok {
            backoff = (backoff * 2).min(300);
        }
        std::thread::sleep(Duration::from_secs(backoff));
    }
}
