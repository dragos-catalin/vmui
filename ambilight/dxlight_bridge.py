"""DX Light (Robobloq "PC SYNC Backlight", USB HID 1a86:fe07) bridge.

HyperHDR has no driver for this controller, but its "udpraw" LED device
sends one UDP datagram per frame with raw R,G,B bytes for every LED. This
bridge listens for those datagrams and re-emits them in the controller's
HID protocol, so the strip becomes a first-class HyperHDR output with its
own LED geometry.

Protocol (verified against the open-source hypr-quicklight / rgb-controller
implementations and against this unit):
  * HID output reports, report id 0 + 64 payload bytes, packets chunked.
  * Control frame:  'R' 'B' len msg_id action payload... checksum8
        action 147 payload [0]                init ("openUrl")
        action 135 payload [brightness 0-255]
        action 134 payload [1,85,85,85,65,66,0,0,0,254]  section defaults
  * Per-LED frame:  'S' 'C' len_hi len_lo msg_id 128 (n R G B n)*count checksum8
        n is 1-based. Physical order on this strip: right (bottom->top),
        top (right->left), left (top->bottom) -- 17 + 31 + 17 = 65 LEDs.

Usage:
  python dxlight_bridge.py --test           # red/green/blue sweep, then off
  python dxlight_bridge.py --listen 19446   # HyperHDR udpraw target

Idle: after settings.json `idleAfterSec` (default 20) without a datagram the
strip fades to `idleStripHex` (default off). HyperHDR's own
backgroundEffect is NOT used for this: it flips in after 800 ms without a new
frame, and the DX11 grabber emits no frame while the picture is static, so a
paused film or a still scene flashed idle/picture/idle. Here the last frame
is held and idle only wins after a real silence.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time

SETTINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")


def idle_config(key: str) -> tuple[tuple[int, int, int], float]:
    """(rgb, seconds) from ambilight/settings.json; `key` = idleStripHex | idleGlowHex."""
    try:
        with open(SETTINGS, encoding="utf-8") as fh:
            s = json.load(fh)
    except (OSError, ValueError):
        s = {}
    h = str(s.get(key, "#000000")).lstrip("#")
    rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)) if len(h) == 6 else (0, 0, 0)
    return rgb, float(s.get("idleAfterSec", 20))


def fade_frames(src: bytes, dst: bytes, steps: int):
    for i in range(1, steps + 1):
        t = i / steps
        yield bytes(int(a + (b - a) * t) for a, b in zip(src, dst))


def is_black(data: bytes) -> bool:
    return not any(data)


# Per-LED black level. A dark scene averages to grey noise around 16-24/255
# (HyperHDR live image on a "black" frame), and 65 LEDs of dim grey read as
# WHITE on the wall. Below BLACK_OFF the LED is off, ramping to full by
# BLACK_FULL; the ratio keeps the hue, only the level changes.
# Measured on the max channel (HSV value), NOT luma: Rec.709 luma weights
# blue 0.07 and red 0.21, so a full-screen #102040 (-> LED 5,15,44) and a
# #600000 (-> 75,0,0) both fell under 0.08 and the strip went dark while
# green/white of the same level passed -- "blue never shows, red looks white".
BLACK_OFF = 0.08
BLACK_FULL = 0.22


def black_gate(data: bytes) -> bytes:
    out = bytearray(len(data))
    for i in range(0, len(data) - 2, 3):
        r, g, b = data[i], data[i + 1], data[i + 2]
        level = max(r, g, b) / 255
        if level <= BLACK_OFF:
            continue
        k = min(1.0, (level - BLACK_OFF) / (BLACK_FULL - BLACK_OFF))
        out[i], out[i + 1], out[i + 2] = int(r * k), int(g * k), int(b * k)
    return bytes(out)


def _mean(data: bytes) -> float:
    return sum(data) / max(1, len(data))


FLASH_TRACE = os.environ.get("AMBILIGHT_TRACE_FLASH") == "1"


class DaylightGate:
    """Polls HA `binary_sensor.ambilight_idle_allowed` (ha-scenes.yaml).

    off  -> room is bright (A51 lux or sun) and the user wants idle LEDs off
    on / unreachable -> idle colours as configured. HA down must not make
    the rig go dark, so failures count as allowed.
    """

    ENTITY = "binary_sensor.ambilight_idle_allowed"

    def __init__(self, every_s: float = 60.0) -> None:
        self.every_s = every_s
        self.allowed = True
        self._next = 0.0
        self._url, self._tok = self._creds()

    @staticmethod
    def _creds() -> tuple[str, str]:
        env = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".private", "credentials.env")
        vals: dict[str, str] = {}
        try:
            with open(env, encoding="utf-8") as fh:
                for line in fh:
                    if "=" in line and not line.lstrip().startswith("#"):
                        k, v = line.split("=", 1)
                        vals[k.strip()] = v.strip()
        except OSError:
            pass
        return os.environ.get("HA_URL") or vals.get("HA_URL", ""), os.environ.get("HA_TOKEN") or vals.get("HA_TOKEN", "")

    def poll(self) -> bool:
        """Returns True when the value CHANGED."""
        now = time.monotonic()
        if now < self._next or not self._url or not self._tok:
            return False
        self._next = now + self.every_s
        import urllib.request  # noqa: PLC0415

        try:
            req = urllib.request.Request(f"{self._url}/api/states/{self.ENTITY}", headers={"Authorization": f"Bearer {self._tok}"})
            with urllib.request.urlopen(req, timeout=4) as r:
                state = json.load(r).get("state")
        except Exception:  # noqa: BLE001 -- HA unreachable: keep current decision
            return False
        if state not in ("on", "off"):
            return False
        new = state == "on"
        changed = new != self.allowed
        self.allowed = new
        return changed


class IdleGate:
    """Shared idle policy for the UDP bridges.

    HyperHDR emits ONE all-black frame when it switches the LED device off
    (no source / grabber stopped) and then goes silent. Applying that frame
    is the short flash seen on every idle transition: lit -> black -> (20 s
    later) fade to idle red. Rule: a black frame after real content is not
    content, it is the off signal -> keep the last picture and let the idle
    timer run. Leaving idle is faded too, so the first film frame does not
    pop out of solid red.
    """

    def __init__(self, idle_frame: bytes, idle_after: float, steps: int = 40) -> None:
        self.configured_idle = idle_frame
        self.idle_frame = idle_frame
        self.idle_after = idle_after
        self.steps = steps
        self.last: bytes | None = None
        self.last_rx = time.monotonic()
        self.idle = False
        self.daylight = DaylightGate()

    def _refresh_daylight(self, apply) -> None:
        if not self.daylight.poll():
            return
        self.idle_frame = self.configured_idle if self.daylight.allowed else bytes(len(self.configured_idle))
        print(f"  daylight: idle {'allowed' if self.daylight.allowed else 'OFF (room is bright)'}", flush=True)
        if self.idle and self.last != self.idle_frame:
            for f in fade_frames(self.last or bytes(len(self.idle_frame)), self.idle_frame, self.steps):
                apply(f)
                time.sleep(0.05)
            self.last = self.idle_frame

    def on_timeout(self, apply) -> None:
        self._refresh_daylight(apply)
        if not self.idle and time.monotonic() - self.last_rx >= self.idle_after and self.last != self.idle_frame:
            for f in fade_frames(self.last or bytes(len(self.idle_frame)), self.idle_frame, self.steps):
                apply(f)
                time.sleep(0.05)
            self.last = self.idle_frame
            self.idle = True
            print("  idle", flush=True)

    def on_frame(self, data: bytes, apply, off_signal: bool | None = None) -> bool:
        """Returns True if `data` was applied. `off_signal` overrides the
        all-black heuristic (a gated dark picture is black but IS a picture)."""
        if off_signal is None:
            off_signal = is_black(data)
        if off_signal and self.last is not None and not self.idle:
            # the off signal, not a picture
            self.last_rx = time.monotonic()
            return False
        was_idle = self.idle
        self.last_rx = time.monotonic()
        self.idle = False
        if data == self.last:
            return False
        if FLASH_TRACE and self.last is not None:
            a, b = _mean(self.last), _mean(data)
            if abs(a - b) > 40:
                print(f"  JUMP {a:5.1f} -> {b:5.1f}  max={max(data)} was_idle={was_idle}", flush=True)
        if was_idle:
            for f in fade_frames(self.last or bytes(len(data)), data, 20):
                apply(f)
                time.sleep(0.03)
        else:
            apply(data)
        self.last = data
        return True


import hid  # hidapi

VID, PID = 0x1A86, 0xFE07
LED_COUNT = 65
REPORT_SIZE = 64
# The controller has no flow control: a full frame is 6 interrupt-OUT reports
# and a transition (idle -> film, movie mode ON) makes HyperHDR emit 60
# distinct frames/s = 360 reports/s, above what a full-speed HID pipe drains.
# The firmware buffer overflows, the endpoint stops ACKing and the pending
# overlapped write never returns (0x3E5) until the strip is replugged. Every
# recorded wedge sat exactly on such a burst. Pace here, not only upstream.
MAX_FPS = 30.0
REPORT_GAP_S = 0.0015
SLOW_WRITE_S = 0.25


def device_present() -> bool:
    """Is the strip's HID interface enumerated right now? (cheap; no open)"""
    try:
        return any(d["interface_number"] == 0 for d in hid.enumerate(VID, PID))
    except Exception:  # noqa: BLE001
        return False


def _checksum8(data: bytes) -> int:
    return sum(data) & 0xFF


class DxLight:
    def __init__(self, brightness: int = 255) -> None:
        self._msg_id = 0
        self._last_frame: bytes | None = None
        self._next_frame_at = 0.0
        self.slow_writes = 0
        self.dev = self._open()
        self._init(brightness)

    @staticmethod
    def _open() -> hid.device:
        candidates = [d for d in hid.enumerate(VID, PID) if d["interface_number"] == 0]
        if not candidates:
            raise SystemExit("DX Light not found (1a86:fe07 interface 0). Is it plugged in?")
        dev = hid.device()
        dev.open_path(candidates[0]["path"])
        dev.set_nonblocking(False)
        return dev

    def _next_id(self) -> int:
        self._msg_id = (self._msg_id + 1) & 0xFF
        return self._msg_id

    def _write(self, packet: bytes) -> None:
        for off in range(0, len(packet), REPORT_SIZE):
            chunk = packet[off : off + REPORT_SIZE]
            report = bytes([0x00]) + chunk + bytes(REPORT_SIZE - len(chunk))
            t0 = time.monotonic()
            rc = self.dev.write(report)
            took = time.monotonic() - t0
            if rc < 0:
                # hidapi's own reason (e.g. "Overlapped I/O operation is in
                # progress", "The device is not connected") tells a wedged
                # controller from a pulled cable; the bare -1 did not.
                raise OSError(f"HID write failed: {self.dev.error()!s}")
            if took > SLOW_WRITE_S:
                # The pipe is backing up: the firmware is close to the edge.
                # Log it and give it a breather instead of piling on.
                self.slow_writes += 1
                print(f"  slow HID write {took * 1000:.0f} ms (#{self.slow_writes}); backing off", flush=True)
                time.sleep(0.1)
            elif off + REPORT_SIZE < len(packet):
                time.sleep(REPORT_GAP_S)

    def _rb(self, action: int, payload: bytes) -> None:
        body = bytes([ord("R"), ord("B"), 5 + len(payload) + 1, self._next_id(), action]) + payload
        self._write(body + bytes([_checksum8(body)]))

    def _init(self, brightness: int) -> None:
        self._rb(147, b"\x00")
        self._rb(135, bytes([brightness]))
        self._rb(134, bytes([1, 85, 85, 85, 65, 66, 0, 0, 0, 254]))
        self.frame(bytes(LED_COUNT * 3))

    def set_brightness(self, value: int) -> None:
        self._rb(135, bytes([max(0, min(255, value))]))

    def frame(self, rgb: bytes) -> None:
        """rgb: LED_COUNT*3 bytes in strip order. Identical frames are not
        resent and frames are paced to MAX_FPS (blocking); both keep the
        controller's input buffer from overflowing."""
        count = min(LED_COUNT, len(rgb) // 3)
        rgb = bytes(rgb[: count * 3])
        if rgb == self._last_frame:
            return
        wait = self._next_frame_at - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        total = 2 + 2 + 1 + 1 + count * 5 + 1
        out = bytearray([ord("S"), ord("C"), (total >> 8) & 0xFF, total & 0xFF, self._next_id(), 128])
        for i in range(count):
            n = i + 1
            out += bytes([n, rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], n])
        out.append(_checksum8(out))
        self._write(bytes(out))
        self._last_frame = rgb
        self._next_frame_at = time.monotonic() + 1.0 / MAX_FPS

    def close(self) -> None:
        try:
            self.frame(bytes(LED_COUNT * 3))
        finally:
            self.dev.close()


def run_test(dx: DxLight) -> None:
    for name, col in (("red", (255, 0, 0)), ("green", (0, 255, 0)), ("blue", (0, 0, 255))):
        print(f"  {name}")
        dx.frame(bytes(col) * LED_COUNT)
        time.sleep(1.0)
    print("  chase (shows physical LED order: right -> top -> left)")
    for i in range(LED_COUNT):
        buf = bytearray(LED_COUNT * 3)
        buf[3 * i : 3 * i + 3] = (255, 255, 255)
        dx.frame(bytes(buf))
        time.sleep(0.03)
    print("  off")


def run_listen(dx: DxLight, port: int) -> None:
    import select  # noqa: PLC0415
    from notify_fx import FPS as FX_FPS, FX_PORT, Animator  # noqa: PLC0415

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", port))
    fxsock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    fxsock.bind(("127.0.0.1", FX_PORT))
    fx = Animator()
    print(f"  listening udp://127.0.0.1:{port} for {LED_COUNT} LEDs ({LED_COUNT * 3} bytes/frame)")
    print(f"  notifications on udp://127.0.0.1:{FX_PORT} (json event/color/duration)")
    idle_rgb, idle_after = idle_config("idleStripHex")
    gate = IdleGate(bytes(idle_rgb) * LED_COUNT, idle_after)
    print(f"  idle {idle_rgb} after {idle_after:.0f}s of silence")
    frames, t0 = 0, time.monotonic()
    fx_next = 0.0
    while True:
        # While a notification plays we still DRAIN HyperHDR frames (so the
        # idle gate keeps its timing) but the strip shows the animation.
        timeout = max(0.0, fx_next - time.monotonic()) if fx.active else 1.0
        ready, _, _ = select.select([sock, fxsock], [], [], timeout)
        if fxsock in ready:
            was_active = fx.active
            fx.handle(fxsock.recvfrom(1024)[0])
            if fx.active and not was_active and gate.last is not None:
                fx.base = gate.last  # blend in from what the strip shows now
            if not fx.active:
                gate.last = None  # force the next HyperHDR frame through, no dedupe
        if sock in ready:
            data, _ = sock.recvfrom(4096)
            # Pacing in dx.frame() blocks; take only the newest datagram so a
            # burst becomes dropped frames, not a growing backlog.
            while select.select([sock], [], [], 0)[0]:
                data, _ = sock.recvfrom(4096)
            if len(data) >= 3:
                frames += 1
                if fx.active:
                    gate.last_rx = time.monotonic()  # seen, not shown
                    if not is_black(data):
                        fx.base = black_gate(data)  # blend out into the live picture
                else:
                    gate.on_frame(black_gate(data), dx.frame, off_signal=is_black(data))
        elif not fx.active and not ready:
            gate.on_timeout(dx.frame)
        if fx.active and time.monotonic() >= fx_next:
            fx_next = time.monotonic() + 1 / FX_FPS
            f = fx.frame()
            if f is not None:
                dx.frame(f)
            else:
                gate.last = None
            continue
        if frames % 600 == 0:
            now = time.monotonic()
            print(f"  {frames / (now - t0):.1f} fps", flush=True)
            frames, t0 = 0, now


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--listen", type=int, metavar="PORT")
    ap.add_argument("--brightness", type=int, default=255)
    a = ap.parse_args()
    dx = DxLight(a.brightness)
    try:
        if a.test:
            run_test(dx)
        elif a.listen:
            run_listen(dx, a.listen)
        else:
            ap.print_help()
            return 2
    except KeyboardInterrupt:
        pass
    finally:
        dx.close()
    return 0


if sys.stdout is None:  # pythonw: no console, keep the prints somewhere readable
    import os
    _log = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".copilot-tmp", "service-logs")
    os.makedirs(_log, exist_ok=True)
    sys.stdout = sys.stderr = open(os.path.join(_log, "dxlight-bridge.log"), "a", buffering=1, encoding="utf-8")

if __name__ == "__main__":
    sys.exit(main())
