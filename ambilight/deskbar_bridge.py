"""HyperHDR udpraw -> Tuya Cloud: the Desk Light Bar follows the top of the screen.

The bar (Tuya category `dd`, product "Smart Monitor Light Bar") has RGB LEDs
that Home Assistant cannot drive: its `light.turn_on` with hs_color 500s on
this device because HA's Tuya integration sends `control_data`, which the
firmware rejects with "type is incorrect". The bar DOES accept `colour_data`
(HSV, s/v 0..1000) while `work_mode` = "color" -- an enum value the cloud
schema does not list (it says music|white) but the firmware accepts over LAN
(verified 2026-09-15). "music" also takes colour_data but keeps the built-in
microphone reactive, which made the bar pulse to room sound in idle. Cloud
fallback still has to use "music": the cloud validates against its schema.
First verified 2026-09-14 with
red/green/blue via tinytuya.Cloud.

  HyperHDR inst 3 "Desk bar (Tuya)"  udpraw :19448  1 LED = top region
      -> this bridge -> Tuya Cloud (EU)  colour_data at <= MAX_HZ

Transport: LAN first (tinytuya protocol 3.3, ~65 ms per write, no quota;
needs TUYA_DESKBAR_IP / _VERSION / _LOCAL_KEY in .private/credentials.env,
written by the one-off cloud lookup), Tuya Cloud as fallback (~0.4 s, 2 Hz
cap). A failed LAN write closes the session and reconnects on the next frame;
after LAN_SOFT_FAILS in a row LAN is retried with backoff (never abandoned)
while the cloud carries frames. Cloud Err 913 (IoT Core subscription expired,
2026-10) disables the cloud for the process. Idle: when frames stop (movie off, grabber off) the bar is put back in
"white" mode so the HA scenes' colour_temp_kelvin calls keep working; the
ambient() gate turns it off on dark scenes exactly like the case LEDs.

Raw DP ids (protocol 3.3): 20 switch_led, 21 work_mode, 22 bright_value,
23 temp_value, 24 colour_data as 12-hex hhhhssssvvvv (h 0-360, s/v 0-1000).

  python deskbar_bridge.py --test          # red / green / blue / off
  python deskbar_bridge.py --listen 19448
"""
from __future__ import annotations

import argparse
import colorsys
import json
import os
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DEVICE_ID = "bf965a6835d854af14xkxb"  # Desk Light Bar (Smart Life)
CLOUD_HZ = 2.0  # Tuya free tier: keep well under the per-day quota
LAN_HZ = 10.0  # 65 ms per write measured; 10 Hz leaves the socket idle half the time
MIN_DELTA_CLOUD = 12  # 0..255 per channel; smaller changes are not worth a cloud call
MIN_DELTA_LAN = 3
V_MAX = 600  # colour_data v ceiling (0..1000): the bar is 30 cm from the eyes
V_MIN = 25  # never fully off mid-session: switch_led toggles are what flashed
WAKE_MIN = 40  # max(rgb) after ambient() needed to switch the relay back on
# The firmware applies every colour_data as a hard cut (no internal fade in
# music mode), so the bridge does the easing: each 10 Hz tick moves the
# emitted HSV this fraction of the way to the target. 0.18 @ 10 Hz ~ 0.5 s
# to 90 %, which on top of HyperHDR's own smoothing reads as a glide.
SLEW = 0.12
CHROMA_HUE = 0.10  # (max-min)/255 below which the hue is noise and is frozen
IDLE_WHITE = {"temp_value": 374, "bright_value": 356}  # what HA left it at
DP = {"switch_led": 20, "work_mode": 21, "bright_value": 22, "temp_value": 23, "colour_data": 24}
# LAN failures in a row before the cloud (if alive) carries frames; LAN is
# still retried after LAN_BACKOFF_S[min(n, len-1)] -- it is never given up.
LAN_SOFT_FAILS = 3
LAN_BACKOFF_S = (1.0, 2.0, 4.0, 8.0, 15.0, 30.0)


def _credentials() -> dict[str, str]:
    env = os.path.join(os.path.dirname(HERE), ".private", "credentials.env")
    vals: dict[str, str] = {}
    try:
        with open(env, encoding="utf-8") as fh:
            for line in fh:
                if "=" in line and not line.lstrip().startswith("#"):
                    k, v = line.split("=", 1)
                    vals[k.strip()] = v.strip()
    except OSError:
        pass
    for k in ("TUYA_ACCESS_ID", "TUYA_ACCESS_SECRET", "TUYA_DESKBAR_IP", "TUYA_DESKBAR_VERSION", "TUYA_DESKBAR_LOCAL_KEY"):
        if os.environ.get(k):
            vals[k] = os.environ[k]
    if not (vals.get("TUYA_DESKBAR_LOCAL_KEY") or (vals.get("TUYA_ACCESS_ID") and vals.get("TUYA_ACCESS_SECRET"))):
        raise SystemExit("Tuya credentials missing (.private/credentials.env)")
    return vals


class DeskBar:
    def __init__(self) -> None:
        import tinytuya  # noqa: PLC0415 -- optional dependency, only this bridge needs it

        v = _credentials()
        self.local = None
        if v.get("TUYA_DESKBAR_LOCAL_KEY") and v.get("TUYA_DESKBAR_IP"):
            self.local = tinytuya.BulbDevice(DEVICE_ID, v["TUYA_DESKBAR_IP"], v["TUYA_DESKBAR_LOCAL_KEY"])
            self.local.set_version(float(v.get("TUYA_DESKBAR_VERSION") or 3.3))
            self.local.set_socketPersistent(True)
            self.local.set_socketTimeout(0.5)  # a dead session must not stall the 10 Hz loop for 2 s
            # tinytuya defaults to 5 connect attempts 5 s apart = a 25 s stall
            # per frame when the bar is away; one attempt, reconnect next frame.
            self.local.set_socketRetryLimit(1)
            self.local.set_socketRetryDelay(0)
        self.cloud = None
        if v.get("TUYA_ACCESS_ID") and v.get("TUYA_ACCESS_SECRET"):
            try:
                self.cloud = tinytuya.Cloud(apiRegion="eu", apiKey=v["TUYA_ACCESS_ID"], apiSecret=v["TUYA_ACCESS_SECRET"])
            except Exception as e:  # noqa: BLE001
                print(f"  tuya cloud init failed ({e}); LAN only", flush=True)
        self.lan_failures = 0
        self.lan_retry_at = 0.0
        self._cloud_carried = False  # last successful write went via cloud ("music" mode)
        self.colour_mode = False
        self.last: tuple[int, int, int] | None = None
        self.on = True
        self._last_h = 0.08  # warm amber until the first frame
        self.target: tuple[float, float, float] | None = None  # hsv 0..1
        self.cur: tuple[float, float, float] | None = None

    @property
    def use_lan(self) -> bool:
        """LAN is the active path: healthy, or the only path there is."""
        return self.local is not None and (self.lan_failures < LAN_SOFT_FAILS or self.cloud is None)

    @property
    def max_hz(self) -> float:
        return LAN_HZ if self.use_lan else CLOUD_HZ

    def _cloud_failed(self, r: object) -> None:
        """Err 913 = the Tuya IoT Core subscription has expired (or another
        hard cloud error): stop calling the cloud for this process."""
        if isinstance(r, dict) and str(r.get("Err")) == "913" and self.cloud is not None:
            self.cloud = None
            print(f"  tuya cloud unavailable ({r.get('Payload') or r.get('Error')}); LAN only from now on", flush=True)
        else:
            print(f"  tuya: {r}", flush=True)

    def _lan_failed(self, r: object) -> None:
        self.lan_failures += 1
        try:
            self.local.close()  # next call opens a fresh session (persistent socket)
        except Exception:  # noqa: BLE001
            pass
        n = self.lan_failures
        if n >= LAN_SOFT_FAILS:
            wait = LAN_BACKOFF_S[min(n - LAN_SOFT_FAILS, len(LAN_BACKOFF_S) - 1)]
            self.lan_retry_at = time.monotonic() + wait
        # Log the first few, then only at each backoff step change so a bar
        # that is unplugged for an hour does not write 36000 lines.
        if n <= LAN_SOFT_FAILS or n - LAN_SOFT_FAILS < len(LAN_BACKOFF_S):
            print(f"  lan: {r} (fail #{n}, reconnecting)", flush=True)

    def describe(self) -> None:
        if self.local is not None:
            st = self.local.status()
            if isinstance(st, dict) and "dps" in st:
                print(f"  Desk Light Bar: LAN {self.local.address} v{self.local.version} work_mode={st['dps'].get('21', '?')}")
                self.colour_mode = st["dps"].get("21") == "color"  # "music" must be re-sent as "color"
                self.on = bool(st["dps"].get("20", True))
                return
            print(f"  Desk Light Bar: LAN status failed ({st}); will keep retrying LAN")
            self.lan_failures = LAN_SOFT_FAILS - 1
            self._lan_failed(st)
        if self.cloud is None:
            if self.local is not None:
                return  # LAN-only; the loop reconnects with backoff
            raise RuntimeError("no LAN and no cloud credentials")
        st = self.cloud.getstatus(DEVICE_ID)
        if not isinstance(st, dict) or not st.get("success"):
            if self.local is not None:
                self._cloud_failed(st)
                return
            raise RuntimeError(f"Tuya getstatus failed: {st}")
        mode = next((x["value"] for x in st["result"] if x["code"] == "work_mode"), "?")
        print(f"  Desk Light Bar: cloud work_mode={mode}")

    def _send(self, cmds: list[dict]) -> bool:
        if self.local is not None and time.monotonic() >= self.lan_retry_at:
            dps = {}
            for c in cmds:
                val = c["value"]
                if c["code"] == "colour_data":
                    j = json.loads(val)
                    val = "%04x%04x%04x" % (j["h"], j["s"], j["v"])
                if c["code"] == "work_mode" and val == "music":
                    val = "color"  # LAN takes the firmware's real colour mode
                dps[str(DP[c["code"]])] = val
            # Tuya 3.3 firmware holds ONE TCP session: any other client
            # (HA polling, a diagnostic status()) evicts ours. Wait for the
            # reply so a dead socket is seen here and reopened on the next
            # frame instead of failing silently forever.
            try:
                r = self.local.set_multiple_values(dps)
            except Exception as e:  # noqa: BLE001
                r = {"Error": f"{type(e).__name__}: {e}"}
            if not isinstance(r, dict) or "Error" in r or "dps" not in r:
                self._lan_failed(r)
                if self.lan_failures >= LAN_SOFT_FAILS and self.cloud is not None:
                    return self._send_cloud(cmds)
                return False
            if self.lan_failures >= LAN_SOFT_FAILS:
                print(f"  lan: back after {self.lan_failures} failures", flush=True)
            self.lan_failures = 0
            self.lan_retry_at = 0.0
            if self._cloud_carried:
                # The cloud left the bar in "music" (mic-reactive): make the
                # next tick re-send work_mode=color over LAN.
                self._cloud_carried = False
                if not any(c["code"] == "work_mode" for c in cmds):
                    self.colour_mode = False
            return True
        return self._send_cloud(cmds)

    def _send_cloud(self, cmds: list[dict]) -> bool:
        if self.cloud is None:
            return False
        cmds = [{"code": "work_mode", "value": "music"} if c["code"] == "work_mode" and c["value"] == "color" else c for c in cmds]
        try:
            r = self.cloud.sendcommand(DEVICE_ID, {"commands": cmds})
        except Exception as e:  # noqa: BLE001
            r = {"Error": f"{type(e).__name__}: {e}"}
        ok = isinstance(r, dict) and bool(r.get("success"))
        if ok:
            self._cloud_carried = True
        else:
            self._cloud_failed(r)
        return ok

    def set_target(self, rgb: tuple[int, int, int]) -> None:
        # Hysteresis on the relay: a dark scene hovers around the ambient()
        # luma gate and the bar clicked off/on every second (logbook 22:07).
        # Once off, stay off until the region is clearly lit again.
        if not self.on and 0 < max(rgb) < WAKE_MIN:
            rgb = (0, 0, 0)
        r, g, b = rgb
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        # Hue is meaningless when the region is near-black: (11,10,3) and
        # (11,19,17) are both "dark" yet 120 deg apart, and a film's dark
        # scene wanders between them every frame. Traced 2026-09-15: the
        # green/blue "lightning" on the bar was exactly this -- v ~ 27/1000
        # with the hue spinning 165 -> 45 deg in one second. Only let the
        # hue move when there is real chroma; below that hold the last hue
        # and fade saturation out so the bar just dims to warm-neutral.
        chroma = (max(rgb) - min(rgb)) / 255
        if chroma >= CHROMA_HUE:
            self._last_h = h
        h = self._last_h
        if max(rgb) < 8:
            # A black picture (fade to black, paused black frame, credits) means
            # the bar goes OUT, not "dim warm". The relay pop on the way back
            # on is handled in tick(): the colour is written in the same
            # packet as switch_led=true, so the firmware never shows its own
            # last brightness. Dark-but-not-black keeps V_MIN.
            s, v = 0.3, 0.0
        else:
            s = s * min(1.0, chroma / CHROMA_HUE) if chroma < CHROMA_HUE else s
            v = max(V_MIN / 1000, min(v, 1.0) * V_MAX / 1000)
        self.target = (h, s, v)
        self.last = rgb

    def tick(self) -> None:
        """One step towards the target; call at max_hz. No-op when settled."""
        if self.target is None:
            return
        if self.cur is None or not self.use_lan:
            self.cur = self.target  # cloud path: 2 Hz is too slow to ease, just jump
        else:
            th, ts, tv = self.target
            ch, cs, cv = self.cur
            dh = ((th - ch + 0.5) % 1.0) - 0.5  # shortest way round the hue circle
            self.cur = ((ch + dh * SLEW) % 1.0, cs + (ts - cs) * SLEW, cv + (tv - cv) * SLEW)
            if abs(dh) < 0.002 and abs(ts - cs) < 0.005 and abs(tv - cv) < 0.005:
                self.cur = self.target
            if tv == 0.0 and self.cur[2] < V_MIN / 1000:
                self.cur = self.target  # easing below the floor is invisible; go dark now
        h, s, v = self.cur
        step = {"h": int(h * 360), "s": int(s * 1000), "v": int(v * 1000)}
        want_on = step["v"] > 0
        if not want_on:
            if not self.on:
                return
            self._sent = step
            if self._send([{"code": "switch_led", "value": False}]):
                self.on = False
            else:
                self._sent = None
            return
        if step == getattr(self, "_sent", None) and self.on and self.colour_mode:
            return
        if self.local is not None and self.cloud is None and time.monotonic() < self.lan_retry_at:
            return  # LAN backing off and no cloud: nothing could carry this frame
        was_on, was_colour = self.on, self.colour_mode
        self._sent = step
        cmds: list[dict] = []
        if not self.on:
            step["v"] = max(step["v"], V_MIN)  # never wake into v=0
            cmds.append({"code": "switch_led", "value": True})
            self.on = True
        if not self.colour_mode:
            cmds.append({"code": "work_mode", "value": "color" if self.use_lan else "music"})
            self.colour_mode = True
        cmds.append({"code": "colour_data", "value": json.dumps(step)})
        if not self._send(cmds):
            # Unknown what reached the bar: resend everything on the next tick.
            self._sent = None
            self.on, self.colour_mode = was_on, was_colour

    def apply(self, rgb: tuple[int, int, int]) -> None:
        """Immediate set (tests / cloud path)."""
        self.set_target(rgb)
        self.cur = None
        self.tick()

    def release(self) -> None:
        """Back to plain white so HA's colour_temp scenes take effect again."""
        if not self.colour_mode and self.on:
            return
        self._send(
            [
                {"code": "switch_led", "value": True},
                {"code": "work_mode", "value": "white"},
                {"code": "temp_value", "value": IDLE_WHITE["temp_value"]},
                {"code": "bright_value", "value": IDLE_WHITE["bright_value"]},
            ]
        )
        self.colour_mode = False
        self.on = True
        self.last = None

    def close(self) -> None:
        try:
            self.release()
        except Exception:  # noqa: BLE001
            pass
        if self.local is not None:
            try:
                self.local.close()
            except Exception:  # noqa: BLE001
                pass


def run_test(bar: DeskBar) -> None:
    for name, rgb in (("red", (200, 0, 0)), ("green", (0, 200, 0)), ("blue", (0, 0, 200)), ("off", (0, 0, 0))):
        print(f"  {name}")
        bar.apply(rgb)
        time.sleep(2.5)
    bar.release()
    print("  released to white")


def run_listen(bar: DeskBar, port: int) -> None:
    from openrgb_bridge import ambient  # same dark->off / chroma rules as the case LEDs

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", port))
    tick_s = 1 / bar.max_hz
    sock.settimeout(tick_s)
    print(f"  listening udp://127.0.0.1:{port} (1 region = 3 bytes/frame, <= {bar.max_hz:g} Hz via {'LAN' if bar.use_lan else 'cloud'})")
    next_tick = time.monotonic()
    last_rx = time.monotonic()
    released = True
    while True:
        try:
            data, _ = sock.recvfrom(64)
        except socket.timeout:
            data = b""
        now = time.monotonic()
        if len(data) >= 3:
            last_rx = now
            released = False
            rgb = tuple(ambient(bytes(data[:3]) * 3)[:3])  # ambient() works on 3 regions; feed one thrice
            bar.set_target(rgb)  # type: ignore[arg-type]
        if now >= next_tick:
            next_tick = now + 1 / bar.max_hz  # drops to CLOUD_HZ while the cloud carries frames
            if not released:
                try:
                    bar.tick()
                except Exception as e:  # noqa: BLE001 -- one bad write must not kill the loop
                    print(f"  tick: {e}", flush=True)
            # HyperHDR sends one black frame then silence when the source goes
            # away; 5 s without frames = movie over -> hand the bar back to HA.
            if not released and now - last_rx > 5:
                bar.release()
                released = True
                bar.target = bar.cur = None
                print("  idle -> white mode", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--listen", type=int, metavar="PORT")
    a = ap.parse_args()
    bar = DeskBar()
    bar.describe()
    if a.test:
        run_test(bar)
    elif a.listen:
        run_listen(bar, a.listen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
