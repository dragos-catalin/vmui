"""Single owner of every BLE light's GATT connection on this PC.

A BLE peripheral accepts ONE central at a time. Before this module the MELK
strip behind the viewer (MELK-OA10, light.led_argb in HA) was held by
melk_bridge.py during films and by HA's elkbledom (via the ESPHome BLE proxy)
the rest of the time. New strips (MELK-OC21, ...) have no HA integration at
all, so the PC drives them directly. Everything that wants to talk to a BLE
light on this PC goes through the hub below:

  * HyperHDR instance 4 -> udpraw 127.0.0.1:19450 (3 bytes/frame) -> OA10,
    same ambient() gate / hysteresis / rate limit as melk_bridge had;
  * control server, TCP JSON lines on 127.0.0.1:19460 (desktop agent, CLI):
      {"op":"set","mac","protocol","state":{on,rgb?,bri?,effect?,speed?}}
      {"op":"led_count","mac","count"}   {"op":"effect","mac","id","speed"?}
      {"op":"scan","seconds":8} -> {"ok":true,"items":[{mac,name,rssi,protocol}]}
      {"op":"status"} -> [{mac,connected,latencyMs,lastError,lastWriteAt,...}]
      {"op":"release","mac"}
    (TCP 19460 does not clash with notify_fx's UDP 19460: separate namespaces.)
  * lazy connect, one asyncio.Lock per MAC, latest-state-wins write queue,
    >= MIN_INTERVAL_S between writes, and release (disconnect) after idle:
    RELEASE_S for devices HA also drives (so elkbledom can reconnect),
    RELEASE_OTHER_S for the rest.

Protocol 'melk' (ELK-BLEDOM family, char fff3, write without response):
  on 7e0004010000ff00ef  off 7e0004000000ff00ef  rgb 7e000503rrggbb00ef
  bri 7e0001bb00000000ef  effect 7e0503XX06ffff00ef  speed 7e0402SSffffff00ef
  led count 7e0721LOHI00ff00ef

  python ble_lights.py --scan 8
  python ble_lights.py --status
  python ble_lights.py --set BE:16:2F:00:05:29 255 80 0
  python ble_lights.py --led-count BE:16:2F:00:05:29 27
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import socket
import socketserver
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

CHAR = "0000fff3-0000-1000-8000-00805f9b34fb"
OA10_MAC = "BE:69:83:00:C4:0B"  # behind the viewer; HA alias light.led_argb
OC21_MAC = "BE:16:2F:00:05:29"
HA_ALIASED = frozenset({OA10_MAC})  # HA must be able to take these back quickly

CONTROL_HOST = "127.0.0.1"
CONTROL_PORT = 19460
UDP_PORT = 19450

CONNECT_TIMEOUT_S = 15
MIN_INTERVAL_S = 0.2
MIN_DELTA = 6
RELEASE_S = 5.0
RELEASE_OTHER_S = 30.0
WAKE_MIN = 40
MAX_LINE = 64 * 1024

PROTOCOLS = ("melk", "elk")  # elk = generic ELK-BLEDOM firmware, same byte set
SCAN_PREFIXES = ("MELK", "ELK-BLEDOM", "ELK-BLEDOB", "duoCo", "Triones", "LEDnet")
MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")


# --------------------------------------------------------------- protocol --

def cmd_on() -> bytes:
    return bytes.fromhex("7e0004010000ff00ef")


def cmd_off() -> bytes:
    return bytes.fromhex("7e0004000000ff00ef")


def cmd_rgb(r: int, g: int, b: int) -> bytes:
    for c in (r, g, b):
        if not 0 <= c <= 255:
            raise ValueError("rgb channel out of 0..255")
    return bytes([0x7E, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xEF])


def cmd_brightness(pct: int) -> bytes:
    return bytes([0x7E, 0x00, 0x01, max(0, min(100, int(pct))), 0x00, 0x00, 0x00, 0x00, 0xEF])


def cmd_effect(effect_id: int) -> bytes:
    if not 0 <= effect_id <= 255:
        raise ValueError("effect id out of 0..255")
    return bytes([0x7E, 0x05, 0x03, effect_id, 0x06, 0xFF, 0xFF, 0x00, 0xEF])


def cmd_speed(speed: int) -> bytes:
    return bytes([0x7E, 0x04, 0x02, max(0, min(100, int(speed))), 0xFF, 0xFF, 0xFF, 0x00, 0xEF])


def cmd_led_count(n: int) -> bytes:
    if not 1 <= n <= 1000:
        raise ValueError("led count out of 1..1000")
    return bytes([0x7E, 0x07, 0x21, n & 0xFF, (n >> 8) & 0xFF, 0x00, 0xFF, 0x00, 0xEF])


def guess_protocol(name: str | None) -> str | None:
    """Protocol for a scanned advertisement name; None = not a light we know."""
    if not name or not name.startswith(SCAN_PREFIXES):
        return None
    if name.startswith("MELK"):
        return "melk"
    if name.startswith("ELK-"):
        return "elk"
    return "unknown"


def plan_writes(state: dict, sent: dict) -> tuple[list[bytes], dict]:
    """Minimal payloads that move a strip from `sent` (what we last wrote on
    this connection; {} = unknown) to `state`. Pure."""
    out: list[bytes] = []
    new = dict(sent)
    if not state.get("on", True):
        if sent.get("on") is not False:
            out.append(cmd_off())
            new["on"] = False
        return out, new
    if sent.get("on") is not True:
        out.append(cmd_on())
        new["on"] = True
    eff = state.get("effect")
    if eff is not None:
        if sent.get("effect") != eff:
            out.append(cmd_effect(eff))
            new["effect"] = eff
            new.pop("rgb", None)
    elif state.get("rgb") is not None:
        rgb = tuple(state["rgb"])
        if sent.get("rgb") != rgb:
            out.append(cmd_rgb(*rgb))
            new["rgb"] = rgb
            new.pop("effect", None)
    sp = state.get("speed")
    if sp is not None and sent.get("speed") != sp:
        out.append(cmd_speed(sp))
        new["speed"] = sp
    bri = state.get("bri")
    if bri is not None and sent.get("bri") != bri:
        out.append(cmd_brightness(bri))
        new["bri"] = bri
    return out, new


# -------------------------------------------------------------- transport --

class BleakTransport:
    """Real GATT access. bleak is imported here so the module (and its unit
    tests) load without it."""

    def __init__(self) -> None:
        from bleak import BleakClient  # noqa: PLC0415

        self._Client = BleakClient
        self.clients: dict[str, Any] = {}

    def is_connected(self, mac: str) -> bool:
        c = self.clients.get(mac)
        return c is not None and bool(c.is_connected)

    async def connect(self, mac: str) -> None:
        c = self._Client(mac, timeout=CONNECT_TIMEOUT_S)
        await c.connect()
        self.clients[mac] = c

    async def write(self, mac: str, payload: bytes) -> None:
        await self.clients[mac].write_gatt_char(CHAR, payload, response=False)

    async def disconnect(self, mac: str) -> None:
        c = self.clients.pop(mac, None)
        if c is not None:
            await c.disconnect()

    def drop(self, mac: str) -> None:
        self.clients.pop(mac, None)

    async def scan(self, seconds: float) -> list[tuple[str, str | None, int | None]]:
        from bleak import BleakScanner  # noqa: PLC0415

        found = await BleakScanner.discover(timeout=seconds, return_adv=True)
        return [(d.address, adv.local_name or d.name, adv.rssi) for d, adv in found.values()]


# --------------------------------------------------------------------- hub --

@dataclass
class Device:
    mac: str
    protocol: str
    release_s: float
    lock: asyncio.Lock | None = None
    sent: dict = field(default_factory=dict)
    pending: dict | None = None
    waiters: list = field(default_factory=list)
    draining: bool = False
    next_ok: float = 0.0
    last_activity: float = 0.0
    stream_until: float = 0.0
    connected: bool = False
    ambient: bool = False
    latency_ms: int | None = None
    last_error: str | None = None
    last_write_at: int | None = None
    name: str | None = None
    rssi: int | None = None


class BleHub:
    def __init__(self, transport: Any = None) -> None:
        self.transport = transport if transport is not None else BleakTransport()
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self.loop.run_forever, name="ble-hub", daemon=True)
        self._thread.start()
        self.devices: dict[str, Device] = {}
        self._dlock = threading.Lock()
        self.server: ControlServer | None = None
        self._reaper_fut = asyncio.run_coroutine_threadsafe(self._reaper(), self.loop)

    # -- plumbing
    def _run(self, coro, timeout: float):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def device(self, mac: str, protocol: str | None = None) -> Device:
        mac = mac.upper()
        with self._dlock:
            dev = self.devices.get(mac)
            if dev is None:
                dev = Device(mac, protocol or "melk", RELEASE_S if mac in HA_ALIASED else RELEASE_OTHER_S)
                self.devices[mac] = dev
            elif protocol:
                dev.protocol = protocol
            return dev

    async def _drop(self, dev: Device) -> None:
        try:
            await asyncio.wait_for(self.transport.disconnect(dev.mac), 5)
        except Exception:  # noqa: BLE001
            self.transport.drop(dev.mac)
        dev.connected = False
        dev.sent = {}

    async def _locked_write(self, dev: Device, plan: Callable[[dict], tuple[list[bytes], dict | None]]) -> dict:
        if dev.lock is None:
            dev.lock = asyncio.Lock()
        async with dev.lock:
            wait = dev.next_ok - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            t0 = time.monotonic()
            try:
                if not self.transport.is_connected(dev.mac):
                    dev.sent = {}  # fresh connection: strip state unknown
                    await self.transport.connect(dev.mac)
                    dev.connected = True
                    print(f"  ble: connected {dev.mac}", flush=True)
                payloads, new_sent = plan(dev.sent)
                for p in payloads:
                    await self.transport.write(dev.mac, p)
            except Exception as e:  # noqa: BLE001
                dev.last_error = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
                await self._drop(dev)
                raise OSError(f"ble {dev.mac}: {dev.last_error}") from e
            now = time.monotonic()
            if new_sent is not None:
                dev.sent = new_sent
            dev.last_activity = now
            if payloads:
                dev.latency_ms = round((now - t0) * 1000)
                dev.last_error = None
                dev.last_write_at = int(time.time() * 1000)
                dev.next_ok = now + MIN_INTERVAL_S
            return {"ok": True, "mac": dev.mac, "latencyMs": dev.latency_ms, "writes": len(payloads)}

    async def _submit_state(self, dev: Device, state: dict, source: str) -> dict:
        if source == "control" and time.monotonic() < dev.stream_until:
            # Ambilight frames win while they stream; accepted, not written.
            return {"ok": True, "mac": dev.mac, "deferred": True, "reason": "ambilight streaming"}
        fut = self.loop.create_future()
        dev.pending = dict(state)  # latest state wins
        dev.waiters.append(fut)
        if not dev.draining:
            dev.draining = True
            self.loop.create_task(self._drain(dev))
        return await fut

    async def _drain(self, dev: Device) -> None:
        try:
            while dev.pending is not None:
                wait = dev.next_ok - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)  # more sets may land here and coalesce
                state, waiters = dev.pending, dev.waiters
                dev.pending, dev.waiters = None, []
                try:
                    res = await self._locked_write(dev, lambda sent, s=state: plan_writes(s, sent))
                except Exception as e:  # noqa: BLE001
                    res = {"ok": False, "mac": dev.mac, "error": str(e)}
                if len(waiters) > 1:
                    res = dict(res, coalesced=len(waiters))
                for w in waiters:
                    if not w.done():
                        w.set_result(res)
        finally:
            dev.draining = False

    async def _release(self, dev: Device, why: str) -> None:
        if dev.lock is None:
            dev.lock = asyncio.Lock()
        async with dev.lock:
            was = dev.connected or self.transport.is_connected(dev.mac)
            await self._drop(dev)
            dev.ambient = False
            if was:
                tail = " to HA" if dev.mac in HA_ALIASED else ""
                print(f"  ble: released {dev.mac}{tail} ({why})", flush=True)

    async def _reaper(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            now = time.monotonic()
            for dev in list(self.devices.values()):
                if dev.connected and not self.transport.is_connected(dev.mac):
                    dev.connected = False  # peer dropped us
                    dev.sent = {}
                if (
                    dev.connected
                    and not dev.draining
                    and not (dev.lock is not None and dev.lock.locked())
                    and now > dev.stream_until
                    and now - dev.last_activity > dev.release_s
                ):
                    try:
                        await self._release(dev, "idle")
                    except Exception as e:  # noqa: BLE001
                        print(f"  ble: release {dev.mac}: {e}", flush=True)

    # -- public, thread-safe
    def set(self, mac: str, protocol: str, state: dict, source: str = "control") -> dict:
        dev = self.device(mac, protocol)
        try:
            return self._run(self._submit_state(dev, state, source), CONNECT_TIMEOUT_S + 10)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "mac": dev.mac, "error": f"{type(e).__name__}: {e}"}

    def led_count(self, mac: str, protocol: str, count: int) -> dict:
        dev = self.device(mac, protocol)
        payload = cmd_led_count(count)
        try:
            return self._run(self._locked_write(dev, lambda _s: ([payload], None)), CONNECT_TIMEOUT_S + 10)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "mac": dev.mac, "error": str(e)}

    def write_sync(self, mac: str, protocol: str, payloads: list[bytes]) -> None:
        """Raw writes for the ambilight path; raises OSError on failure."""
        dev = self.device(mac, protocol)
        dev.ambient = True
        try:
            self._run(self._locked_write(dev, lambda _s: (payloads, {})), CONNECT_TIMEOUT_S + 5)
        except OSError:
            raise
        except Exception as e:  # noqa: BLE001
            raise OSError(f"ble {dev.mac}: {e}") from e

    def touch_stream(self, mac: str) -> None:
        dev = self.device(mac)
        now = time.monotonic()
        dev.stream_until = now + RELEASE_S
        dev.last_activity = now

    def release(self, mac: str) -> dict:
        dev = self.device(mac)
        dev.stream_until = 0.0
        try:
            self._run(self._release(dev, "requested"), 15)
            return {"ok": True, "mac": dev.mac}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "mac": dev.mac, "error": str(e)}

    def scan(self, seconds: float) -> list[dict]:
        raw = self._run(self.transport.scan(seconds), seconds + 15)
        items = []
        for mac, name, rssi in raw:
            proto = guess_protocol(name)
            if proto is None:
                continue
            mac = mac.upper()
            items.append({"mac": mac, "name": name, "rssi": rssi, "protocol": proto})
            dev = self.devices.get(mac)
            if dev is not None:
                dev.name, dev.rssi = name, rssi
        items.sort(key=lambda i: -(i["rssi"] if i["rssi"] is not None else -999))
        return items

    def status(self) -> list[dict]:
        return [
            {
                "mac": d.mac,
                "protocol": d.protocol,
                "connected": d.connected,
                "latencyMs": d.latency_ms,
                "lastError": d.last_error,
                "lastWriteAt": d.last_write_at,
                "rssi": d.rssi,
                "streaming": time.monotonic() < d.stream_until,
            }
            for d in list(self.devices.values())
        ]

    def serve(self, port: int = CONTROL_PORT, host: str = CONTROL_HOST) -> "ControlServer":
        if self.server is None:
            self.server = ControlServer(self, port, host)
            threading.Thread(target=self.server.serve_forever, name="ble-control", daemon=True).start()
            print(f"  ble control on tcp://{host}:{self.server.server_address[1]}", flush=True)
        return self.server

    def describe(self) -> None:
        print(f"  ble hub: OA10 {OA10_MAC} via PC Bluetooth, <= {1 / MIN_INTERVAL_S:g} Hz, control tcp/{CONTROL_PORT}", flush=True)

    def close(self) -> None:
        if self.server is not None:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:  # noqa: BLE001
                pass
            self.server = None
        for dev in list(self.devices.values()):
            try:
                if dev.ambient and dev.connected:
                    self.write_sync(dev.mac, dev.protocol, [cmd_off()])
            except Exception:  # noqa: BLE001
                pass
            try:
                self._run(self._release(dev, "shutdown"), 10)
            except Exception:  # noqa: BLE001
                pass
        async def _cancel_all() -> None:
            me = asyncio.current_task()
            tasks = [t for t in asyncio.all_tasks() if t is not me]
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        try:
            self._run(_cancel_all(), 5)
        except Exception:  # noqa: BLE001
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(5)


# ---------------------------------------------------------- control server --

def _err(msg: str) -> dict:
    return {"ok": False, "error": msg}


def _mac(v: Any) -> str:
    if not isinstance(v, str) or not MAC_RE.match(v):
        raise ValueError("mac must look like AA:BB:CC:DD:EE:FF")
    return v.upper()


def _proto(v: Any) -> str:
    if v not in PROTOCOLS:
        raise ValueError(f"protocol must be one of {', '.join(PROTOCOLS)}")
    return v


def _int(v: Any, lo: int, hi: int, name: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ValueError(f"{name} must be an integer {lo}..{hi}")
    return v


def _num(v: Any, lo: float, hi: float, name: str) -> int:
    """Number in range, rounded (server-side calibration may yield floats)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"{name} must be a number {lo:g}..{hi:g}")
    return int(round(v))


def _state(v: Any) -> dict:
    if not isinstance(v, dict):
        raise ValueError("state must be an object")
    on = v.get("on", True)
    if not isinstance(on, bool):
        raise ValueError("state.on must be a boolean")
    out: dict = {"on": on}
    rgb = v.get("rgb")
    if rgb is not None:
        if not isinstance(rgb, (list, tuple)) or len(rgb) != 3:
            raise ValueError("state.rgb must be [r,g,b]")
        out["rgb"] = tuple(_num(c, 0, 255, "state.rgb channel") for c in rgb)
    if v.get("bri") is not None:
        out["bri"] = _num(v["bri"], 0, 100, "state.bri")
    eff = v.get("effect")
    if eff is not None:
        if isinstance(eff, str) and eff.isdigit():
            eff = int(eff)
        out["effect"] = _int(eff, 0, 255, "state.effect")
    if v.get("speed") is not None:
        out["speed"] = _num(v["speed"], 0, 100, "state.speed")
    return out


def handle_request(hub: Any, req: Any) -> Any:
    if not isinstance(req, dict):
        return _err("request must be a JSON object")
    op = req.get("op")
    try:
        if op == "status":
            return hub.status()
        if op == "scan":
            return {"ok": True, "items": hub.scan(_num(req.get("seconds", 8), 1, 30, "seconds"))}
        if op not in ("set", "led_count", "effect", "release"):
            return _err(f"unknown op {op!r}")
        mac = _mac(req.get("mac"))
        if op == "release":
            return hub.release(mac)
        proto = _proto(req.get("protocol", "melk"))
        if op == "set":
            return hub.set(mac, proto, _state(req.get("state")))
        if op == "led_count":
            return hub.led_count(mac, proto, _int(req.get("count"), 1, 1000, "count"))
        state: dict = {"on": True, "effect": _int(req.get("id"), 0, 255, "id")}
        if req.get("speed") is not None:
            state["speed"] = _num(req["speed"], 0, 100, "speed")
        return hub.set(mac, proto, state)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:  # noqa: BLE001
        return _err(f"{type(e).__name__}: {e}")


class _Handler(socketserver.StreamRequestHandler):
    timeout = 120

    def handle(self) -> None:
        hub = self.server.hub  # type: ignore[attr-defined]
        while True:
            try:
                line = self.rfile.readline(MAX_LINE + 1)
            except OSError:
                return
            if not line:
                return
            if len(line) > MAX_LINE:
                self._reply(_err("line too long"))
                return
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                resp: Any = _err("invalid json")
            else:
                resp = handle_request(hub, req)
            if not self._reply(resp):
                return

    def _reply(self, resp: Any) -> bool:
        try:
            self.wfile.write((json.dumps(resp) + "\n").encode())
            self.wfile.flush()
            return True
        except OSError:
            return False


class ControlServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False  # Windows SO_REUSEADDR would let a 2nd hub bind too

    def __init__(self, hub: Any, port: int = CONTROL_PORT, host: str = CONTROL_HOST) -> None:
        self.hub = hub
        super().__init__((host, port), _Handler)


# --------------------------------------------------------------- ambilight --

class AmbientDriver:
    """HyperHDR frame -> OA10 writes; the old MelkStrip.set logic, unchanged
    in behaviour, but the bytes of one frame go out as ONE batch."""

    def __init__(self, hub: BleHub, mac: str = OA10_MAC, protocol: str = "melk") -> None:
        self.hub, self.mac, self.protocol = hub, mac, protocol
        self.sent: tuple[int, int, int] | None | str = "unknown"
        self.bri = -999
        self.next_ok = 0.0
        self.fails = 0

    def _write(self, payloads: list[bytes]) -> None:
        try:
            self.hub.write_sync(self.mac, self.protocol, payloads)
            self.fails = 0
        except Exception:
            self.fails += 1
            self.sent = "unknown"
            self.bri = -999
            raise

    def set(self, rgb: tuple[int, int, int], now: float, raw_max: int | None = None) -> None:
        if now < self.next_ok:
            return
        last = self.sent
        if last is None and 0 < max(rgb) < WAKE_MIN:
            rgb = (0, 0, 0)
        mx = max(rgb)
        if mx == 0:
            if last is None:
                return
            self._write([cmd_off()])
            self.sent = None
            self.next_ok = now + MIN_INTERVAL_S
            print("  melk: off", flush=True)
            return
        colour = tuple(int(c * 255 / mx) for c in rgb)
        lvl = raw_max if raw_max is not None else mx
        bri = max(5, min(100, int(lvl * 100 / 255)))
        if isinstance(last, tuple) and all(abs(a - b) < MIN_DELTA for a, b in zip(colour, last)) and abs(bri - self.bri) < MIN_DELTA:
            return
        batch: list[bytes] = []
        if not isinstance(last, tuple):
            batch.append(cmd_on())
        batch.append(cmd_rgb(*colour))
        new_bri = abs(bri - self.bri) >= MIN_DELTA
        if new_bri:
            batch.append(cmd_brightness(bri))
        self._write(batch)
        if new_bri:
            self.bri = bri
        self.sent = colour  # type: ignore[assignment]
        self.next_ok = now + MIN_INTERVAL_S
        if not isinstance(last, tuple):
            print(f"  melk: on {colour} bri {bri}%", flush=True)

    def release(self) -> None:
        self.sent = "unknown"
        self.bri = -999
        self.hub.release(self.mac)


def run_listen(hub: BleHub, port: int) -> None:
    """bridges.py entry: control server + HyperHDR udpraw -> OA10."""
    from openrgb_bridge import ambient  # noqa: PLC0415

    hub.serve(CONTROL_PORT)
    driver = AmbientDriver(hub)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", port))
    sock.settimeout(1.0)
    print(f"  listening udp://127.0.0.1:{port} (1 region = 3 bytes/frame)", flush=True)

    slot: list[tuple | None] = [None]
    wake = threading.Event()
    stop = threading.Event()
    lock = threading.Lock()
    fatal: list[BaseException | None] = [None]

    def worker() -> None:
        while not stop.is_set():
            wake.wait(0.5)
            wake.clear()
            if time.monotonic() < driver.next_ok:
                time.sleep(driver.next_ok - time.monotonic())
            with lock:
                job, slot[0] = slot[0], None
            if job is None:
                continue
            rgb, raw_max = job
            try:
                driver.set(rgb, time.monotonic(), raw_max)
            except Exception as ex:  # noqa: BLE001
                print(f"  melk: {ex}", flush=True)
                if driver.fails >= 5:
                    fatal[0] = ex  # the listener raises it -> supervisor restarts the hub
                    return
                time.sleep(2.0)

    threading.Thread(target=worker, name="melk-writer", daemon=True).start()

    last_rx = time.monotonic()
    streaming = False
    try:
        while True:
            if fatal[0] is not None:
                raise OSError(f"melk: {driver.fails} failed writes in a row") from fatal[0]
            try:
                data, _ = sock.recvfrom(64)
            except socket.timeout:
                data = b""
            now = time.monotonic()
            if len(data) >= 3:
                last_rx = now
                streaming = True
                hub.touch_stream(OA10_MAC)
                raw = bytes(data[:3])
                with lock:
                    slot[0] = (tuple(ambient(raw * 3)[:3]), max(raw))  # type: ignore[arg-type]
                wake.set()
            elif streaming and now - last_rx > RELEASE_S:
                streaming = False
                with lock:
                    slot[0] = None
                driver.release()
    finally:
        stop.set()
        sock.close()


# --------------------------------------------------------------------- CLI --

def client_request(req: dict, port: int = CONTROL_PORT, timeout: float = 30.0) -> Any:
    """One request to a running hub; None when no hub listens."""
    try:
        conn = socket.create_connection((CONTROL_HOST, port), timeout=2)
    except OSError:
        return None
    with conn:
        conn.settimeout(timeout)
        conn.sendall((json.dumps(req) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
    return json.loads(buf) if buf.strip() else None


def udp_port_busy(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        s.close()


def oa10_owned_elsewhere(control_port: int = CONTROL_PORT) -> bool:
    """A bridge (this hub, or the legacy melk_bridge) already holds the OA10."""
    try:
        socket.create_connection((CONTROL_HOST, control_port), timeout=1).close()
        return True
    except OSError:
        pass
    return udp_port_busy(UDP_PORT)


def _print_scan(items: list[dict]) -> None:
    for i in items:
        print(f"{i['name']}  {i['mac']}  rssi={i['rssi']}  protocol={i['protocol']}")
    if not items:
        print("(no BLE lights found)")


def main() -> int:
    ap = argparse.ArgumentParser(description="BLE light hub (MELK / ELK-BLEDOM)")
    ap.add_argument("--scan", type=float, metavar="SECONDS")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--set", nargs=4, metavar=("MAC", "R", "G", "B"))
    ap.add_argument("--off", metavar="MAC")
    ap.add_argument("--led-count", nargs=2, metavar=("MAC", "N"))
    ap.add_argument("--release", metavar="MAC")
    ap.add_argument("--protocol", default="melk", choices=PROTOCOLS)
    ap.add_argument("--listen", type=int, metavar="PORT", help="run the hub standalone (udp port for HyperHDR)")
    a = ap.parse_args()

    if a.listen:
        hub = BleHub()
        hub.describe()
        try:
            run_listen(hub, a.listen)
        finally:
            hub.close()
        return 0

    if a.scan is not None:
        req: dict = {"op": "scan", "seconds": a.scan}
    elif a.status:
        req = {"op": "status"}
    elif a.set:
        req = {"op": "set", "mac": a.set[0], "protocol": a.protocol,
               "state": {"on": True, "rgb": [int(x) for x in a.set[1:]]}}
    elif a.off:
        req = {"op": "set", "mac": a.off, "protocol": a.protocol, "state": {"on": False}}
    elif a.led_count:
        req = {"op": "led_count", "mac": a.led_count[0], "protocol": a.protocol, "count": int(a.led_count[1])}
    elif a.release:
        req = {"op": "release", "mac": a.release}
    else:
        ap.print_help()
        return 2

    resp = client_request(req, timeout=(a.scan or 0) + 30)
    if resp is None:
        if req["op"] == "status":
            print("hub not running (tcp/19460); no status")
            return 1
        mac = str(req.get("mac", "")).upper()
        if mac == OA10_MAC and oa10_owned_elsewhere():
            print(f"refusing: {OA10_MAC} is held by a running bridge (udp/{UDP_PORT} bound); two centrals would fight")
            return 2
        hub = BleHub(BleakTransport())
        try:
            resp = handle_request(hub, req)
            if req["op"] == "set" and isinstance(resp, dict) and resp.get("ok"):
                time.sleep(0.5)  # write-without-response: let the radio flush before disconnect
        finally:
            hub.close()
    if req["op"] == "scan" and isinstance(resp, dict) and resp.get("ok"):
        _print_scan(resp["items"])
    else:
        print(json.dumps(resp, indent=2))
    ok = isinstance(resp, list) or (isinstance(resp, dict) and resp.get("ok"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
