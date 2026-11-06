#!/usr/bin/env python3
"""Desk button on the Pi: GPIO17 -> GND (internal pull-up).

Counts 1..5 clicks inside a 400 ms window, or a >=1 s hold, and posts the
gesture to vmui, which maps it via the /home "Butonul de birou" table.
Optional status LED on GPIO27 blinks the `led` count vmui returns.

Env: VMUI_URL (default http://127.0.0.1:3737), ESP_DISPLAY_TOKEN (read from
/srv/homepi/vmui/.private/credentials.env when unset), BUTTON_GPIO, LED_GPIO.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request

from gpiozero import LED, Button

MULTI_MS = 400
LONG_S = 1.0
VMUI = os.environ.get("VMUI_URL", "http://127.0.0.1:3737")
NODE = os.environ.get("BUTTON_NODE", "homepi")


def token() -> str:
    # own appliance token first (scripts/appliance-tokens.mjs), the shared one only as a fallback
    for key in ("VATRA_TOKEN_DESK_BUTTON", "ESP_DISPLAY_TOKEN"):
        if t := os.environ.get(key):
            return t
        with open("/srv/homepi/vmui/.private/credentials.env", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("VATRA_TOKEN_DESK_BUTTON missing")


def auth_headers(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"} if tok.startswith("vmd_") else {"x-esp-token": tok}


TOKEN = token()
led = LED(int(os.environ["LED_GPIO"])) if os.environ.get("LED_GPIO") else None


def blink(n: int) -> None:
    if not led:
        return
    for _ in range(n):
        led.on(); time.sleep(0.12); led.off(); time.sleep(0.12)


def post(click: str) -> None:
    q = urllib.parse.urlencode({"node": NODE, "btn": "desk", "click": click})
    req = urllib.request.Request(f"{VMUI}/api/esp/button?{q}", method="POST", headers=auth_headers(TOKEN))
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            body = json.loads(r.read() or b"{}")
        print(f"{time.strftime('%H:%M:%S')} {click} -> {body.get('result')}", flush=True)
        blink(int(body.get("led", 1)))
    except Exception as e:  # network / 5xx: 5 blinks, keep running
        print(f"{time.strftime('%H:%M:%S')} {click} FAILED {e}", file=sys.stderr, flush=True)
        blink(5)


class Clicks:
    def __init__(self) -> None:
        self.n = 0
        self.timer: threading.Timer | None = None
        self.pressed_at = 0.0
        self.long_fired = False
        self.lock = threading.Lock()

    def pressed(self) -> None:
        self.pressed_at = time.monotonic()
        self.long_fired = False

    def held(self) -> None:  # gpiozero hold_time reached
        with self.lock:
            self.long_fired = True
            self.n = 0
            if self.timer:
                self.timer.cancel()
        post("long")

    def released(self) -> None:
        if self.long_fired:
            return
        with self.lock:
            self.n += 1
            if self.timer:
                self.timer.cancel()
            self.timer = threading.Timer(MULTI_MS / 1000, self.fire)
            self.timer.daemon = True
            self.timer.start()

    def fire(self) -> None:
        with self.lock:
            n, self.n = self.n, 0
        post(str(min(n, 5)))


def main() -> None:
    pin = int(os.environ.get("BUTTON_GPIO", "17"))
    btn = Button(pin, pull_up=True, bounce_time=0.03, hold_time=LONG_S)
    c = Clicks()
    btn.when_pressed = c.pressed
    btn.when_held = c.held
    btn.when_released = c.released
    print(f"desk-button on GPIO{pin} -> {VMUI} (node {NODE})", flush=True)
    blink(1)
    threading.Event().wait()


if __name__ == "__main__":
    main()
