"""Unit tests for ble_lights (no Bluetooth needed).

  python ambilight/test_ble_lights.py
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ble_lights as bl  # noqa: E402

OC21 = "BE:16:2F:00:05:29"


class FakeTransport:
    def __init__(self, write_delay: float = 0.0, fail_connect: bool = False) -> None:
        self.connected: set[str] = set()
        self.writes: list[tuple[str, bytes]] = []
        self.connects = 0
        self.write_delay = write_delay
        self.fail_connect = fail_connect
        self.scan_result: list[tuple[str, str | None, int | None]] = []

    def is_connected(self, mac: str) -> bool:
        return mac in self.connected

    async def connect(self, mac: str) -> None:
        self.connects += 1
        if self.fail_connect:
            raise TimeoutError("no answer")
        self.connected.add(mac)

    async def write(self, mac: str, payload: bytes) -> None:
        if self.write_delay:
            await asyncio.sleep(self.write_delay)
        self.writes.append((mac, payload))

    async def disconnect(self, mac: str) -> None:
        self.connected.discard(mac)

    def drop(self, mac: str) -> None:
        self.connected.discard(mac)

    async def scan(self, seconds: float):
        return list(self.scan_result)


class ProtocolTests(unittest.TestCase):
    def test_bytes(self) -> None:
        self.assertEqual(bl.cmd_on().hex(), "7e0004010000ff00ef")
        self.assertEqual(bl.cmd_off().hex(), "7e0004000000ff00ef")
        self.assertEqual(bl.cmd_rgb(255, 16, 1).hex(), "7e000503ff100100ef")
        self.assertEqual(bl.cmd_brightness(64).hex(), "7e00014000000000ef")
        self.assertEqual(bl.cmd_brightness(150).hex(), "7e00016400000000ef")
        self.assertEqual(bl.cmd_effect(0x87).hex(), "7e05038706ffff00ef")
        self.assertEqual(bl.cmd_speed(50).hex(), "7e040232ffffff00ef")
        self.assertEqual(bl.cmd_led_count(27).hex(), "7e07211b0000ff00ef")
        self.assertEqual(bl.cmd_led_count(300).hex(), "7e07212c0100ff00ef")
        self.assertEqual(bl.cmd_led_count(1000).hex(), "7e0721e80300ff00ef")
        for b in (bl.cmd_on(), bl.cmd_rgb(1, 2, 3), bl.cmd_effect(1), bl.cmd_speed(1), bl.cmd_led_count(1)):
            self.assertEqual(len(b), 9)

    def test_ranges(self) -> None:
        for bad in (0, 1001):
            with self.assertRaises(ValueError):
                bl.cmd_led_count(bad)
        with self.assertRaises(ValueError):
            bl.cmd_effect(256)
        with self.assertRaises(ValueError):
            bl.cmd_rgb(256, 0, 0)

    def test_guess_protocol(self) -> None:
        self.assertEqual(bl.guess_protocol("MELK-OC21"), "melk")
        self.assertEqual(bl.guess_protocol("MELK-OA10   "), "melk")
        self.assertEqual(bl.guess_protocol("ELK-BLEDOM0D"), "elk")
        self.assertEqual(bl.guess_protocol("ELK-BLEDOB"), "elk")
        self.assertEqual(bl.guess_protocol("duoCo Strip"), "unknown")
        self.assertEqual(bl.guess_protocol("Triones-1234"), "unknown")
        self.assertEqual(bl.guess_protocol("LEDnetWF"), "unknown")
        self.assertIsNone(bl.guess_protocol("Galaxy Buds"))
        self.assertIsNone(bl.guess_protocol(None))
        self.assertIsNone(bl.guess_protocol(""))

    def test_plan_writes_minimal(self) -> None:
        p, s = bl.plan_writes({"on": True, "rgb": (1, 2, 3), "bri": 50}, {})
        self.assertEqual([x.hex() for x in p], [bl.cmd_on().hex(), bl.cmd_rgb(1, 2, 3).hex(), bl.cmd_brightness(50).hex()])
        p2, s2 = bl.plan_writes({"on": True, "rgb": (1, 2, 3), "bri": 50}, s)
        self.assertEqual(p2, [])
        p3, _ = bl.plan_writes({"on": True, "rgb": (9, 2, 3), "bri": 50}, s2)
        self.assertEqual(p3, [bl.cmd_rgb(9, 2, 3)])
        p4, s4 = bl.plan_writes({"on": False}, s2)
        self.assertEqual(p4, [bl.cmd_off()])
        self.assertEqual(bl.plan_writes({"on": False}, s4)[0], [])
        p5, _ = bl.plan_writes({"on": True, "effect": 3, "speed": 80}, s2)
        self.assertEqual(p5, [bl.cmd_effect(3), bl.cmd_speed(80)])


class ScanTests(unittest.TestCase):
    def test_scan_filters_and_guesses(self) -> None:
        t = FakeTransport()
        t.scan_result = [
            ("be:16:2f:00:05:29", "MELK-OC21", -60),
            ("AA:BB:CC:DD:EE:01", "ELK-BLEDOM", -80),
            ("AA:BB:CC:DD:EE:02", "Phone", -40),
            ("AA:BB:CC:DD:EE:03", None, -30),
            ("AA:BB:CC:DD:EE:04", "Triones-X", -70),
        ]
        hub = bl.BleHub(t)
        try:
            hub.device(bl.OA10_MAC)
            t.connected.add(bl.OA10_MAC)
            items = hub.scan(1)
            self.assertEqual([i["mac"] for i in items], [OC21, "AA:BB:CC:DD:EE:04", "AA:BB:CC:DD:EE:01"])
            self.assertEqual([i["protocol"] for i in items], ["melk", "unknown", "elk"])
            self.assertIn(bl.OA10_MAC, t.connected)  # scanning must not disconnect anything
        finally:
            hub.close()


class HubTests(unittest.TestCase):
    def test_coalescing_latest_wins(self) -> None:
        t = FakeTransport(write_delay=0.05)
        hub = bl.BleHub(t)
        try:
            results: list[dict] = []
            first = threading.Thread(target=lambda: results.append(hub.set(OC21, "melk", {"on": True, "rgb": (1, 0, 0)})))
            first.start()
            time.sleep(0.02)  # first write in flight; the next ones queue up
            others = [
                threading.Thread(target=lambda c=c: results.append(hub.set(OC21, "melk", {"on": True, "rgb": (c, 0, 0)})))
                for c in (2, 3, 4, 5)
            ]
            for th in others:
                th.start()
                time.sleep(0.005)
            for th in [first, *others]:
                th.join(10)
            rgb_writes = [p for _m, p in t.writes if p[2] == 0x05]
            self.assertEqual(rgb_writes[0], bl.cmd_rgb(1, 0, 0))
            self.assertEqual(rgb_writes[-1], bl.cmd_rgb(5, 0, 0))
            self.assertLessEqual(len(rgb_writes), 3, [p.hex() for p in rgb_writes])
            self.assertTrue(all(r["ok"] for r in results), results)
            self.assertEqual(t.connects, 1)
            self.assertTrue(any(r.get("coalesced") for r in results), results)
        finally:
            hub.close()

    def test_min_interval(self) -> None:
        t = FakeTransport()
        hub = bl.BleHub(t)
        try:
            t0 = time.monotonic()
            hub.set(OC21, "melk", {"on": True, "rgb": (1, 0, 0)})
            hub.set(OC21, "melk", {"on": True, "rgb": (2, 0, 0)})
            self.assertGreaterEqual(time.monotonic() - t0, bl.MIN_INTERVAL_S * 0.9)
        finally:
            hub.close()

    def test_status_and_errors(self) -> None:
        t = FakeTransport(fail_connect=True)
        hub = bl.BleHub(t)
        try:
            r = hub.set(OC21, "melk", {"on": True})
            self.assertFalse(r["ok"])
            st = hub.status()[0]
            self.assertEqual(st["mac"], OC21)
            self.assertFalse(st["connected"])
            self.assertIn("TimeoutError", st["lastError"])
            t.fail_connect = False
            self.assertTrue(hub.set(OC21, "melk", {"on": True})["ok"])
            st = hub.status()[0]
            self.assertTrue(st["connected"])
            self.assertIsNone(st["lastError"])
            self.assertIsInstance(st["latencyMs"], int)
            self.assertIsInstance(st["lastWriteAt"], int)
        finally:
            hub.close()

    def test_stream_wins_over_control(self) -> None:
        t = FakeTransport()
        hub = bl.BleHub(t)
        try:
            hub.touch_stream(bl.OA10_MAC)
            r = hub.set(bl.OA10_MAC, "melk", {"on": True, "rgb": (1, 2, 3)})
            self.assertTrue(r["ok"])
            self.assertTrue(r.get("deferred"))
            self.assertEqual(t.writes, [])
        finally:
            hub.close()

    def test_release_policy(self) -> None:
        hub = bl.BleHub(FakeTransport())
        try:
            self.assertEqual(hub.device(bl.OA10_MAC).release_s, bl.RELEASE_S)
            self.assertEqual(hub.device(OC21).release_s, bl.RELEASE_OTHER_S)
            hub.set(OC21, "melk", {"on": True})
            self.assertTrue(hub.release(OC21)["ok"])
            self.assertFalse(hub.status()[0]["connected"])
        finally:
            hub.close()


class FakeHub:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def status(self):
        return [{"mac": OC21, "connected": False, "latencyMs": None, "lastError": None, "lastWriteAt": None}]

    def scan(self, seconds):
        self.calls.append(("scan", seconds))
        return [{"mac": OC21, "name": "MELK-OC21", "rssi": -60, "protocol": "melk"}]

    def set(self, mac, protocol, state):
        self.calls.append(("set", mac, protocol, state))
        return {"ok": True, "mac": mac}

    def led_count(self, mac, protocol, count):
        self.calls.append(("led_count", mac, protocol, count))
        return {"ok": True, "mac": mac}

    def release(self, mac):
        self.calls.append(("release", mac))
        return {"ok": True, "mac": mac}


class ControlServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.hub = FakeHub()
        cls.server = bl.ControlServer(cls.hub, 0)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def ask(self, lines: list[str]) -> list:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            s.sendall(("\n".join(lines) + "\n").encode())
            f = s.makefile("rb")
            return [json.loads(f.readline()) for _ in lines]

    def test_bad_requests(self) -> None:
        bad = [
            "not json",
            "[1,2]",
            json.dumps({"op": "nope"}),
            json.dumps({"op": "set", "mac": "zz", "state": {"on": True}}),
            json.dumps({"op": "set", "mac": OC21, "protocol": "x", "state": {"on": True}}),
            json.dumps({"op": "set", "mac": OC21, "state": {"on": True, "rgb": [300, 0, 0]}}),
            json.dumps({"op": "set", "mac": OC21, "state": {"on": "yes"}}),
            json.dumps({"op": "set", "mac": OC21, "state": {"on": True, "bri": 101}}),
            json.dumps({"op": "set", "mac": OC21}),
            json.dumps({"op": "led_count", "mac": OC21, "count": 0}),
            json.dumps({"op": "led_count", "mac": OC21, "count": 1001}),
            json.dumps({"op": "led_count", "mac": OC21, "count": "27"}),
            json.dumps({"op": "effect", "mac": OC21, "id": 256}),
            json.dumps({"op": "scan", "seconds": 600}),
            json.dumps({"op": "release"}),
        ]
        before = len(self.hub.calls)
        for resp in self.ask(bad):
            self.assertIs(resp["ok"], False, resp)
            self.assertIsInstance(resp["error"], str)
        self.assertEqual(len(self.hub.calls), before)  # nothing reached the hub

    def test_good_requests(self) -> None:
        good = [
            json.dumps({"op": "status"}),
            json.dumps({"op": "set", "mac": OC21.lower(), "protocol": "melk", "state": {"on": True, "rgb": [255, 80.4, 0], "bri": 60}}),
            json.dumps({"op": "led_count", "mac": OC21, "protocol": "melk", "count": 27}),
            json.dumps({"op": "effect", "mac": OC21, "id": 135, "speed": 50}),
            json.dumps({"op": "scan", "seconds": 2}),
            json.dumps({"op": "release", "mac": OC21}),
        ]
        r = self.ask(good)
        self.assertEqual(r[0][0]["mac"], OC21)
        self.assertTrue(all(x["ok"] for x in r[1:]), r)
        self.assertEqual(r[4]["items"][0]["protocol"], "melk")
        calls = self.hub.calls[-5:]
        self.assertEqual(calls[0], ("set", OC21, "melk", {"on": True, "rgb": (255, 80, 0), "bri": 60}))
        self.assertEqual(calls[1], ("led_count", OC21, "melk", 27))
        self.assertEqual(calls[2], ("set", OC21, "melk", {"on": True, "effect": 135, "speed": 50}))
        self.assertEqual(calls[3], ("scan", 2))
        self.assertEqual(calls[4], ("release", OC21))


class AmbientDriverTests(unittest.TestCase):
    def test_frame_batches_and_hysteresis(self) -> None:
        t = FakeTransport()
        hub = bl.BleHub(t)
        try:
            d = bl.AmbientDriver(hub, OC21)
            d.set((200, 100, 0), 0.0, 200)
            self.assertEqual([p for _m, p in t.writes], [bl.cmd_on(), bl.cmd_rgb(255, 127, 0), bl.cmd_brightness(78)])
            n = len(t.writes)
            d.set((201, 101, 0), 1.0, 201)  # below MIN_DELTA: nothing
            self.assertEqual(len(t.writes), n)
            d.set((0, 0, 0), 2.0, 0)
            self.assertEqual(t.writes[-1][1], bl.cmd_off())
            n = len(t.writes)
            d.set((20, 0, 0), 3.0, 20)  # below WAKE_MIN after off: stays off
            self.assertEqual(len(t.writes), n)
        finally:
            hub.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
