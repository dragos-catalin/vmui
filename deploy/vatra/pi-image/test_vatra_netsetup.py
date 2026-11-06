"""vatra-netsetup behaviour against a fake nmcli.

  python -m unittest deploy/vatra/pi-image/test_vatra_netsetup.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "layer", "vatra-hub.d", "customize.overlay", "opt", "vatra", "bin"))
import vatra_netsetup as ns  # noqa: E402


class FakeNm:
    """nmcli stand-in keeping just enough state: profiles, active profiles, a wifi radio."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.profiles: dict[str, dict] = {}
        self.active: set[str] = set()
        self.ethernet = False
        self.wifi_dev = "wlan0"
        self.reachable: set[str] = set()
        self.scan = "Home\\:Net:80:WPA2\nCafe:40:\nHome\\:Net:30:WPA2\n:20:WPA2\n"

    def __call__(self, cmd: list[str]) -> subprocess.CompletedProcess:
        self.calls.append(cmd)
        ok = lambda out="": subprocess.CompletedProcess(cmd, 0, out, "")  # noqa: E731
        fail = lambda: subprocess.CompletedProcess(cmd, 4, "", "error")  # noqa: E731
        a = cmd[1:]
        if a[:1] == ["--wait"]:
            a = a[2:]
        if a[-2:] == ["show", "--active"]:
            rows = [f"{n}:{p['type']}:activated" for n, p in self.profiles.items() if n in self.active]
            if self.ethernet:
                rows.append("Wired:802-3-ethernet:activated")
            return ok("\n".join(rows))
        if a[:4] == ["-t", "-f", "NAME,TYPE", "connection"]:
            return ok("\n".join(f"{n}:{p['type']}" for n, p in self.profiles.items()))
        if a[:3] == ["-t", "-f", "DEVICE,TYPE,STATE"]:
            return ok(("wlan0:wifi:disconnected\n" if self.wifi_dev else "") + "eth0:ethernet:unavailable")
        if a[:3] == ["-t", "-f", "SSID,SIGNAL,SECURITY"]:
            return ok(self.scan)
        if a[:2] == ["connection", "delete"]:
            self.profiles.pop(a[2], None)
            self.active.discard(a[2])
            return ok()
        if a[:2] == ["connection", "add"]:
            kv = dict(zip(a[2::2], a[3::2]))
            self.profiles[kv["con-name"]] = {"type": "802-11-wireless", **kv}
            return ok()
        if a[:2] == ["connection", "up"]:
            name = a[2]
            p = self.profiles.get(name)
            if not p:
                return fail()
            if p.get("mode") != "ap" and p["ssid"] not in self.reachable:
                return fail()
            self.active = {name}
            return ok()
        if a[:2] == ["connection", "down"]:
            self.active.discard(a[2])
            return ok()
        return fail()


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make(tmp: Path, fake: FakeNm | None = None) -> tuple[ns.Setup, FakeNm, Clock]:
    fake = fake or FakeNm()
    clock = Clock()
    boot = tmp / "boot"
    boot.mkdir()
    s = ns.Setup(nm=ns.Nm(fake), hostname="vatra-3f9a", boot=boot, state=tmp / "state", clock=clock)
    return s, fake, clock


class NetsetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_terse_split_and_wifi_file(self):
        self.assertEqual(ns.split_terse("Home\\:Net:80:WPA2"), ["Home:Net", "80", "WPA2"])
        self.assertEqual(ns.parse_wifi_file("# x\r\nSSID=My Net\r\nPASSWORD=p=ss word\r\n"), ("My Net", "p=ss word"))
        self.assertEqual(ns.parse_wifi_file("PSK=abc\nSSID=a\n"), ("a", "abc"))
        self.assertIsNone(ns.parse_wifi_file("PASSWORD=x"))
        self.assertIsNone(ns.parse_wifi_file("SSID=" + "x" * 33))
        self.assertEqual(ns.lang_of("ro-RO,ro;q=0.9,en;q=0.8"), "ro")
        self.assertEqual(ns.lang_of("de-DE,en;q=0.5"), "en")
        self.assertEqual(ns.lang_of(None), "en")

    def test_hotspot_only_after_grace_and_only_offline(self):
        s, fake, clock = make(self.tmp)
        s.tick()
        self.assertNotIn(ns.HOTSPOT, fake.active)
        clock.t += ns.GRACE - 1
        s.tick()
        self.assertNotIn(ns.HOTSPOT, fake.active)
        clock.t += 2
        s.tick()
        self.assertIn(ns.HOTSPOT, fake.active)
        p = fake.profiles[ns.HOTSPOT]
        self.assertEqual(p["ssid"], "Vatra-3F9A")
        self.assertEqual(p["mode"], "ap")
        self.assertEqual(p["wifi-sec.key-mgmt"], "wpa-psk")
        self.assertEqual(p["wifi-sec.psk"], s.psk())
        self.assertGreaterEqual(len(s.psk()), 8)
        if os.name != "nt":
            self.assertEqual((self.tmp / "state" / "hotspot-psk").stat().st_mode & 0o777, 0o600)
        self.assertEqual([n["ssid"] for n in s.networks], ["Home:Net", "Cafe"])
        self.assertEqual(s.networks[0]["signal"], 80)
        self.assertFalse(s.networks[1]["secure"])
        # a cable comes in -> the hotspot goes away
        fake.ethernet = True
        s.tick()
        self.assertNotIn(ns.HOTSPOT, fake.active)

    def test_no_wifi_device_no_hotspot(self):
        fake = FakeNm()
        fake.wifi_dev = None
        s, _, clock = make(self.tmp, fake)
        s.tick()
        clock.t += ns.GRACE + 1
        s.tick()
        self.assertNotIn(ns.HOTSPOT, fake.profiles)

    def test_portal_join_success_and_failure(self):
        s, fake, clock = make(self.tmp)
        s.tick()
        clock.t += ns.GRACE + 1
        s.tick()
        self.assertEqual(s.submit({"ssid": "Home:Net", "password": "short"}), "weak")
        self.assertEqual(s.submit({"ssid": "__other__", "ssid_other": " "}), "missing")
        # wrong network -> failed, hotspot comes back on the next tick
        self.assertIsNone(s.submit({"ssid": "Cafe", "password": ""}))
        self.assertEqual(s.result["state"], "joining")
        s.tick()
        self.assertEqual(s.result, {"state": "failed", "ssid": "Cafe"})
        self.assertNotIn("wifi-sec.psk", fake.profiles["wifi-Cafe"])
        clock.t += ns.RETRY_WINDOW + 1
        s.tick()
        self.assertIn(ns.HOTSPOT, fake.active)
        self.assertIn("Could not join Cafe", s.page("en"))
        self.assertIn("Nu s-a putut conecta la Cafe", s.page("ro"))
        # the right one
        fake.reachable.add("Home:Net")
        self.assertIsNone(s.submit({"ssid": "Home:Net", "password": "correct horse"}))
        s.tick()
        self.assertEqual(s.result, {"state": "joined", "ssid": "Home:Net"})
        self.assertEqual(fake.active, {"wifi-Home_Net"})
        self.assertEqual(fake.profiles["wifi-Home_Net"]["wifi-sec.psk"], "correct horse")
        s.tick()
        self.assertNotIn(ns.HOTSPOT, fake.active)

    def test_wifi_file_on_boot_partition(self):
        s, fake, _ = make(self.tmp)
        (s.boot / "vatra-wifi.txt").write_text("SSID=Home\nPASSWORD=supersecret\n")
        s.tick()
        self.assertFalse((s.boot / "vatra-wifi.txt").exists(), "the password file must be deleted")
        self.assertEqual((s.boot / "vatra-wifi-result.txt").read_text(), "saved Home\n")
        self.assertEqual(fake.profiles["wifi-Home"]["wifi-sec.psk"], "supersecret")
        (s.boot / "vatra-wifi.txt").write_text("SSID=Home\nPASSWORD=short\n")
        s.tick()
        self.assertIn("shorter than 8", (s.boot / "vatra-wifi-result.txt").read_text())
        self.assertFalse((s.boot / "vatra-wifi.txt").exists())

    def test_saved_network_retry_gives_radio_back(self):
        s, fake, clock = make(self.tmp)
        fake.profiles["wifi-Home"] = {"type": "802-11-wireless", "ssid": "Home"}
        s.tick()
        clock.t += ns.GRACE + 1
        s.tick()
        self.assertIn(ns.HOTSPOT, fake.active)
        clock.t += ns.RETRY - 10
        s.tick()
        self.assertIn(ns.HOTSPOT, fake.active)
        # someone on the portal: no retry even when due
        clock.t += 20
        s.last_portal = clock.t
        s.tick()
        self.assertIn(ns.HOTSPOT, fake.active)
        clock.t += 200
        s.tick()
        self.assertNotIn(ns.HOTSPOT, fake.active)
        # the window for NM to rejoin, then the hotspot again
        clock.t += ns.RETRY_WINDOW - 5
        s.tick()
        self.assertNotIn(ns.HOTSPOT, fake.active)
        clock.t += 10
        s.tick()
        self.assertIn(ns.HOTSPOT, fake.active)

    def test_portal_http_escapes_and_redirects_probes(self):
        s, fake, _ = make(self.tmp)
        s.networks = [{"ssid": "<script>x</script>", "signal": 50, "secure": True}]
        srv = ThreadingHTTPServer(("127.0.0.1", 0), ns.make_handler(s))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        port = srv.server_address[1]

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None

        opener = urllib.request.build_opener(NoRedirect)
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/generate_204", headers={"Host": "connectivitycheck.gstatic.com"})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                opener.open(req)
            self.assertEqual(cm.exception.code, 302)
            self.assertEqual(cm.exception.headers["Location"], f"http://{ns.AP_ADDR}/")
            cm.exception.close()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/", headers={"Host": ns.AP_ADDR, "Accept-Language": "ro"})
            body = opener.open(req).read().decode()
            self.assertIn('lang="ro"', body)
            self.assertIn("Conectează hubul Vatra", body)
            self.assertNotIn("<script>x", body)
            self.assertIn("&lt;script&gt;", body)
            req = urllib.request.Request(f"http://127.0.0.1:{port}/connect", data=b"ssid=Home&password=abc",
                                         headers={"Host": ns.AP_ADDR}, method="POST")
            with self.assertRaises(urllib.error.HTTPError) as cm:
                opener.open(req)
            self.assertEqual(cm.exception.code, 400)
            self.assertIn("at least 8 characters", cm.exception.read().decode())
            cm.exception.close()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/connect", data=b"ssid=Home&password=abcdefgh",
                                         headers={"Host": ns.AP_ADDR}, method="POST")
            self.assertIn("Joining Home", opener.open(req).read().decode())
            self.assertEqual(s.pending, ("Home", "abcdefgh"))
        finally:
            srv.shutdown()
            srv.server_close()

    def test_portal_only_while_hotspot_up(self):
        s, fake, clock = make(self.tmp)
        served = []
        real = ns.serve
        ns.serve = lambda setup: served.append(1) or real(setup, "127.0.0.1", 0)
        try:
            srv = ns.portal_follow(s, None)
            self.assertIsNone(srv)
            s.tick()
            clock.t += ns.GRACE + 1
            s.tick()
            srv = ns.portal_follow(s, None)
            self.assertIsNotNone(srv)
            self.assertIs(ns.portal_follow(s, srv), srv)
            fake.ethernet = True
            s.tick()
            self.assertIsNone(ns.portal_follow(s, srv))
            self.assertEqual(len(served), 1)
        finally:
            ns.serve = real

    def test_bootnote_shows_code_until_claimed(self):
        s, _, _ = make(self.tmp)
        code = self.tmp / "code.txt"
        ns.write_bootnote(s, code)
        note = (s.boot / "vatra-setup.txt").read_text()
        self.assertIn("Starting: the setup code appears", note)
        self.assertNotIn("Claimed", note)
        code.write_text("042917\n")
        ns.write_bootnote(s, code)
        note = (s.boot / "vatra-setup.txt").read_text()
        self.assertIn("Setup code: 042 917", note)
        self.assertIn("Cod de configurare: 042 917", note)
        self.assertIn(f"Vatra-3F9A  password  {s.psk()}", note)
        self.assertIn("http://vatra-3f9a.local:3737", note)
        self.assertFalse((s.boot / "vatra-setup.tmp").exists())
        code.write_text("claimed\n")
        ns.write_bootnote(s, code)
        note = (s.boot / "vatra-setup.txt").read_text()
        self.assertNotIn("042", note)
        self.assertIn("Claimed: this hub already has an owner.", note)
        self.assertIn("Revendicat", note)

    def test_console_issue(self):
        code = self.tmp / "code.txt"
        code.write_text("123456\n")
        text = ns.issue(code)
        self.assertIn("Setup code: 123 456", text)
        self.assertIn("Cod de configurare: 123 456", text)
        self.assertIn("http://\\n.local:3737", text)
        self.assertIn("http://\\4:3737", text)
        code.write_text("claimed\n")
        self.assertNotIn("123", ns.issue(code))


if __name__ == "__main__":
    unittest.main()
