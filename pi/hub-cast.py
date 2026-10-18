#!/usr/bin/env python3
"""Keep /display on the Nest Hub.

The Hub drops a DashCast page after ~10 min of "idle" (no media session), and
it also loses it on reboot. This loop asks HA what the Hub is doing and re-casts
the kiosk URL only when the Hub shows nothing of ours and nothing else the user
wants (YouTube, Spotify, a Lovelace cast). Settings come from vmui so the /home
card controls it: cast.device, cast.keepAlive, cast.respectPlayback.

catt (pychromecast) does the casting; it is installed with pipx on homepi.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path("/srv/homepi/vmui")
VMUI = os.environ.get("VMUI_URL", "http://127.0.0.1:3737").rstrip("/")
LAN_VMUI = os.environ.get("VMUI_LAN_URL", "http://192.168.100.232:3737").rstrip("/")
HA = os.environ.get("HA_URL", "http://127.0.0.1").rstrip("/")
CATT = os.path.expanduser("~/.local/bin/catt")
HUB_ENTITY = "media_player.bedroom_smart_display"
OURS = ("DashCast",)
# Apps the owner started on the Hub. "Bluetooth Audio" = the Hub is a BT speaker: recasting
# /display kills the stream (hub-cast.log 2026-10: dozens of casts over it). "Google Photos"
# is NOT here: it is the Hub's own fallback frame after a dropped cast, exactly when we must recast.
LEAVE_ALONE = ("YouTube", "Spotify", "Netflix", "Home Assistant Lovelace", "Bluetooth Audio")


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def cred(key: str) -> str:
    if v := os.environ.get(key):
        return v
    for line in (ROOT / ".private" / "credentials.env").read_text(encoding="utf-8").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return ""


def get(url: str, headers: dict | None = None, timeout: float = 6) -> dict | None:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def cast(device: str, url: str) -> bool:
    try:
        r = subprocess.run([CATT, "-d", device, "cast_site", url], capture_output=True, text=True, timeout=40)
        if r.returncode != 0:
            log(f"catt failed: {(r.stderr or r.stdout).strip()[:200]}")
        return r.returncode == 0
    except Exception as e:  # noqa: BLE001
        log(f"catt error: {e}")
        return False


def main() -> int:
    tok = cred("ESP_DISPLAY_TOKEN")
    ha_tok = cred("HA_TOKEN")
    if not tok:
        log("ESP_DISPLAY_TOKEN missing")
        return 1
    url = f"{LAN_VMUI}/display?k={tok}"
    last_cast = 0.0
    fails = 0
    ha_down_logged = False
    while True:
        st = get(f"{VMUI}/api/display/state?k={tok}")
        cfg = ((st or {}).get("display") or {}).get("cast") or {}
        device = cfg.get("device") or "Bedroom Smart Display"
        if not cfg.get("keepAlive", True):
            time.sleep(30)
            continue
        hub = get(f"{HA}/api/states/{HUB_ENTITY}", {"Authorization": f"Bearer {ha_tok}"})
        if hub is None:
            # HA unreachable / bad token looks like a Hub that is off; say so once instead of silently idling
            if not ha_down_logged:
                log("HA state read failed (HA down or HA_TOKEN wrong); not casting")
                ha_down_logged = True
            time.sleep(30)
            continue
        ha_down_logged = False
        state = hub.get("state", "unavailable")
        app = (hub.get("attributes") or {}).get("app_name") or ""
        showing_ours = app in OURS and state not in ("off", "unavailable", "unknown")
        busy = cfg.get("respectPlayback", True) and (app in LEAVE_ALONE or state in ("playing", "paused") and app not in OURS)
        if showing_ours or busy or state == "unavailable":
            fails = 0
            time.sleep(20)
            continue
        # backoff: 30 s, 60, 120 … capped at 10 min, so a Hub that is really off is not hammered
        wait = min(600, 30 * 2**fails)
        if time.time() - last_cast < wait:
            time.sleep(5)
            continue
        log(f"hub state={state} app={app!r}; casting {url.split('?')[0]}")
        ok = cast(device, url)
        last_cast = time.time()
        fails = 0 if ok else fails + 1
        time.sleep(15)


if __name__ == "__main__":
    sys.exit(main())
