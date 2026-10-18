//! Light registry glue (desktop): the registry lives on the Pi (`/api/lights`),
//! BLE GATT links are owned by `ambilight/ble_lights.py`, which listens for
//! newline-delimited JSON on 127.0.0.1:19460. This module talks to both.

use crate::stack;
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const BLE_ADDR: &str = "127.0.0.1:19460";

/// One request/response round trip with ble_lights.py.
pub fn ble(req: &Value, timeout: Duration) -> Result<Value> {
    let addr: SocketAddr = BLE_ADDR.parse()?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).context("ble_lights (127.0.0.1:19460)")?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(Duration::from_secs(2)))?;
    s.write_all(format!("{req}\n").as_bytes())?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line)?;
    if line.trim().is_empty() {
        return Err(anyhow!("ble_lights: empty response"));
    }
    let v: Value = serde_json::from_str(line.trim())?;
    if v.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(anyhow!("ble_lights: {}", v["error"].as_str().unwrap_or("error")));
    }
    Ok(v)
}

/// BLE scan on this PC, then hand the results to the Pi registry (kept there 10 min).
pub fn ble_scan(seconds: u64) -> Result<Value> {
    let secs = seconds.clamp(1, 60);
    let r = ble(&json!({"op":"scan","seconds":secs}), Duration::from_secs(secs + 10))?;
    let items = r.get("items").cloned().unwrap_or_else(|| json!([]));
    if let Err(e) = stack::pi_post("/api/lights", json!({"op":"discovered","items":items})) {
        stack::log(&format!("ble_scan: posting discovered to Pi failed: {e}"));
    }
    Ok(items)
}

pub fn ble_status() -> Result<Value> {
    ble(&json!({"op":"status"}), Duration::from_secs(4))
}

pub fn lights_get() -> Result<Value> {
    stack::pi_get("/api/lights", 10)
}

pub fn lights_op(body: Value) -> Result<Value> {
    let v = stack::pi_post("/api/lights", body)?;
    if v.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(anyhow!("{}", v["error"].as_str().unwrap_or("error")));
    }
    Ok(v)
}

/// Names of registry devices that are unreachable: health offline, or an
/// enabled HA light whose state the Pi could not read.
pub fn offline_names(v: &Value) -> Vec<String> {
    v["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| {
            d["health"] == "offline" || (d["enabled"].as_bool().unwrap_or(true) && d["transport"] == "ha" && d["state"].is_null())
        })
        .map(|d| d["name"].as_str().or(d["id"].as_str()).unwrap_or("?").to_string())
        .collect()
}

// ---------------------------------------------------------------- BLE status cache (heartbeat)

static BLE: OnceLock<Mutex<Value>> = OnceLock::new();

fn ble_cache() -> &'static Mutex<Value> {
    BLE.get_or_init(|| Mutex::new(Value::Null))
}

pub fn ble_cached() -> Value {
    ble_cache().lock().unwrap().clone()
}

/// The heartbeat must never wait on BLE: refresh a snapshot every 30 s.
pub fn refresh_ble_forever() {
    loop {
        let v = ble_status().unwrap_or(Value::Null);
        *ble_cache().lock().unwrap() = v;
        std::thread::sleep(Duration::from_secs(30));
    }
}

// ---------------------------------------------------------------- MQTT "light" action

/// `{device:{mac,protocol,transport?,address?}, segment?, state}` from control.ts.
pub fn apply_light(cmd: &Value) -> Result<String> {
    let dev = &cmd["device"];
    let state = &cmd["state"];
    if dev["transport"] == "hyperhdr" {
        let inst: u32 = dev["address"]
            .as_u64()
            .map(|x| x as u32)
            .or_else(|| dev["address"].as_str().and_then(|s| s.parse().ok()))
            .or_else(|| dev["instance"].as_u64().map(|x| x as u32))
            .ok_or_else(|| anyhow!("hyperhdr device without instance"))?;
        let on = state["on"].as_bool().unwrap_or(true);
        let rgb: Vec<u64> = state["rgb"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).filter(|v: &Vec<u64>| v.len() == 3).unwrap_or_else(|| vec![255, 255, 255]);
        let bri = state["bri"].as_u64().or(state["brightnessPct"].as_u64()).unwrap_or(100).min(100);
        let color: Vec<u64> = if on { rgb.iter().map(|c| c * bri / 100).collect() } else { vec![0, 0, 0] };
        let errs = stack::hyper_all(&[json!({"command":"color","color":color,"priority":40,"origin":"vmui lights"})], &[inst]);
        return if errs.is_empty() { Ok("ok".into()) } else { Err(anyhow!(errs.join("; "))) };
    }
    let mac = dev["mac"].as_str().or(cmd["mac"].as_str()).ok_or_else(|| anyhow!("light: device.mac missing"))?;
    let mut req = json!({"op":"set","mac":mac,"protocol":dev["protocol"].as_str().or(cmd["protocol"].as_str()).unwrap_or("melk"),"state":state});
    if !cmd["segment"].is_null() {
        req["segment"] = cmd["segment"].clone();
    }
    ble(&req, Duration::from_secs(8)).map(|_| "ok".into())
}

pub fn apply_led_count(cmd: &Value) -> Result<String> {
    let mac = cmd["mac"].as_str().or(cmd["device"]["mac"].as_str()).ok_or_else(|| anyhow!("led_count: mac missing"))?;
    let count = cmd["count"].as_u64().ok_or_else(|| anyhow!("led_count: count missing"))?;
    ble(&json!({"op":"led_count","mac":mac,"count":count}), Duration::from_secs(8)).map(|_| "ok".into())
}
