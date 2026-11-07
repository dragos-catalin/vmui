//! The house hub this desktop is paired with (P9). An installed copy knows nothing but
//! `<app data>/hub.json`: the hub URL and its own `vmd_…` device token from
//! `/api/devices/pair` (Windows: the token is DPAPI-protected for the current user).
//! A developer checkout (stack::root() found) without a pairing falls back to the
//! house Pi and the shared token from .private/credentials.env, as before.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

/// The house Pi: only the developer fallback uses it.
const DEV_HUB: &str = "http://192.168.100.232:3737";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Conn {
    pub url: String,
    pub token: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    url: String,
    /// hex of the DPAPI blob (Windows) or of the raw token elsewhere
    token: String,
    #[serde(default)]
    protected: bool,
}

static CONN: RwLock<Option<Conn>> = RwLock::new(None);
static FILE: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let f = dir.join("hub.json");
    if let Some(c) = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str::<Stored>(&t).ok()).and_then(|s| decode(&s)) {
        *CONN.write().unwrap() = Some(c);
    }
    *FILE.write().unwrap() = Some(f);
}

/// The paired hub, if any (never the developer fallback).
pub fn paired() -> Option<Conn> {
    CONN.read().unwrap().clone().filter(|c| !c.url.is_empty() && !c.token.is_empty())
}

/// Where requests go: the pairing, else (developer checkout only) the house Pi with the shared token.
pub fn current() -> Option<Conn> {
    paired().or_else(|| {
        crate::stack::root()?;
        let t = crate::stack::creds().get("ESP_DISPLAY_TOKEN").cloned().filter(|t| !t.is_empty())?;
        Some(Conn { url: DEV_HUB.into(), token: t })
    })
}

pub fn url() -> String {
    current().map(|c| c.url).unwrap_or_default()
}

/// Auth header for the hub; never put the token in a URL (P0-06).
pub fn auth() -> Result<(&'static str, String)> {
    let c = current().ok_or_else(|| anyhow!("not paired"))?;
    Ok(if c.token.starts_with("vmd_") { ("Authorization", format!("Bearer {}", c.token)) } else { ("x-esp-token", c.token) })
}

pub fn set(url: &str, token: &str) -> Result<()> {
    let url = crate::pairing::normalise_hub(url).ok_or_else(|| anyhow!("invalid hub address"))?;
    let c = Conn { url, token: token.trim().to_string() };
    if let Some(f) = FILE.read().unwrap().as_ref() {
        std::fs::write(f, serde_json::to_string(&encode(&c)?)?)?;
    }
    *CONN.write().unwrap() = Some(c);
    Ok(())
}

pub fn clear() -> Result<()> {
    if let Some(f) = FILE.read().unwrap().as_ref() {
        let _ = std::fs::remove_file(f);
    }
    *CONN.write().unwrap() = None;
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn encode(c: &Conn) -> Result<Stored> {
    #[cfg(windows)]
    {
        return Ok(Stored { url: c.url.clone(), token: hex(&dpapi::protect(c.token.as_bytes())?), protected: true });
    }
    #[allow(unreachable_code)]
    Ok(Stored { url: c.url.clone(), token: hex(c.token.as_bytes()), protected: false })
}

fn decode(s: &Stored) -> Option<Conn> {
    let raw = unhex(&s.token)?;
    let bytes = if s.protected {
        #[cfg(windows)]
        {
            dpapi::unprotect(&raw).ok()?
        }
        #[cfg(not(windows))]
        {
            return None;
        }
    } else {
        raw
    };
    Some(Conn { url: s.url.clone(), token: String::from_utf8(bytes).ok()? })
}

#[cfg(windows)]
mod dpapi {
    use anyhow::{anyhow, Result};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    const UI_FORBIDDEN: u32 = 0x1;

    fn run(input: &[u8], protect: bool) -> Result<Vec<u8>> {
        let inb = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: valid input blob for the call's duration; the output buffer is LocalAlloc'd by
        // the API, copied out, then released with LocalFree.
        let ok = unsafe {
            if protect {
                CryptProtectData(&inb, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&inb, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), UI_FORBIDDEN, &mut out)
            }
        };
        if ok == 0 || out.pbData.is_null() {
            return Err(anyhow!("DPAPI {} failed", if protect { "protect" } else { "unprotect" }));
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        Ok(v)
    }

    pub fn protect(b: &[u8]) -> Result<Vec<u8>> {
        run(b, true)
    }
    pub fn unprotect(b: &[u8]) -> Result<Vec<u8>> {
        run(b, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        assert_eq!(unhex(&hex(b"vmd_abc\x00\xff")).unwrap(), b"vmd_abc\x00\xff");
        assert!(unhex("abc").is_none());
        assert!(unhex("zz").is_none());
    }

    #[test]
    fn stored_token_is_not_plaintext_and_decodes() {
        let c = Conn { url: "http://hub:3737".into(), token: "vmd_secret_token_value".into() };
        let s = encode(&c).unwrap();
        assert!(!s.token.contains("vmd_"));
        assert_eq!(String::from_utf8(unhex(&s.token).unwrap()).map(|t| t.contains("vmd_secret")).unwrap_or(false), !s.protected);
        let back = decode(&s).unwrap();
        assert_eq!(back.token, c.token);
        assert_eq!(back.url, c.url);
    }
}
