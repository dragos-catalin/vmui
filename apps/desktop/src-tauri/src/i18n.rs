//! Tray / toast strings. The window's locale files are the single source:
//! their top-level `tray` object is compiled in and looked up here. The
//! chosen language lives in `<app data>/lang.txt` ("ro" default, or "en").

use anyhow::{anyhow, Result};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const RO: &str = include_str!("../../src/locales/ro.json");
const EN: &str = include_str!("../../src/locales/en.json");

static LANG: Mutex<String> = Mutex::new(String::new());
static DIR: OnceLock<PathBuf> = OnceLock::new();

struct Tables {
    ro: Value,
    en: Value,
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let tray = |s: &str| serde_json::from_str::<Value>(s).map(|mut v| v["tray"].take()).unwrap_or(Value::Null);
        Tables { ro: tray(RO), en: tray(EN) }
    })
}

/// Strings the tray needs that are not part of the shared contract list.
fn extra(key: &str, en: bool) -> Option<&'static str> {
    Some(match (key, en) {
        ("accessRequestTitle", false) => "vmui: {name} cere acces",
        ("accessRequestTitle", true) => "vmui: {name} requests access",
        ("accessRequestBody", false) => "Cod {code} — aprobă din tray sau din fereastră",
        ("accessRequestBody", true) => "Code {code} — approve from the tray or the window",
        ("phoneAction", false) => "telefon: {action}",
        ("phoneAction", true) => "phone: {action}",
        ("hyperDown", false) => "HyperHDR nu răspunde",
        ("hyperDown", true) => "HyperHDR is not responding",
        ("haDown", false) => "HA indisponibil",
        ("haDown", true) => "HA unavailable",
        ("stopped", false) => "{name} oprit",
        ("stopped", true) => "{name} stopped",
        ("turnOn", false) => "Aprinde",
        ("turnOn", true) => "Turn on",
        ("turnOff", false) => "Stinge",
        ("turnOff", true) => "Turn off",
        ("actDone", false) => "gata",
        ("actDone", true) => "done",
        ("actFailed", false) => "nu a mers",
        ("actFailed", true) => "it did not work",
        ("cantOpen", false) => "nu pot deschide {url}: {error}",
        ("cantOpen", true) => "cannot open {url}: {error}",
        _ => return None,
    })
}

pub fn init(dir: PathBuf) {
    let l = std::fs::read_to_string(dir.join("lang.txt")).unwrap_or_default();
    *LANG.lock().unwrap() = if l.trim() == "en" { "en".into() } else { "ro".into() };
    let _ = DIR.set(dir);
}

pub fn lang() -> String {
    let l = LANG.lock().unwrap();
    if l.is_empty() { "ro".into() } else { l.clone() }
}

pub fn set_lang(lang: &str) -> Result<()> {
    if lang != "ro" && lang != "en" {
        return Err(anyhow!("unsupported language {lang:?}"));
    }
    if let Some(d) = DIR.get() {
        std::fs::create_dir_all(d)?;
        std::fs::write(d.join("lang.txt"), lang)?;
    }
    *LANG.lock().unwrap() = lang.to_string();
    Ok(())
}

pub fn t(key: &str) -> String {
    let en = lang() == "en";
    let tb = tables();
    let primary = if en { &tb.en } else { &tb.ro };
    primary[key]
        .as_str()
        .or_else(|| tb.ro[key].as_str())
        .or_else(|| extra(key, en))
        .unwrap_or(key)
        .to_string()
}

/// `t` with `{name}` placeholders replaced.
pub fn tf(key: &str, args: &[(&str, &str)]) -> String {
    let mut s = t(key);
    for (k, v) in args {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}
