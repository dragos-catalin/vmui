#!/usr/bin/env python3
"""vatra-netsetup: first network for a Vatra hub with no screen and no keyboard (P5-02).

Runs as root under systemd on the Pi image. Every few seconds:
  * /boot/firmware/vatra-wifi.txt (SSID=..., PASSWORD=...) -> a NetworkManager profile, then the
    file is deleted (it holds a password) and the outcome lands in vatra-wifi-result.txt;
  * online (any activated ethernet/wifi profile other than the hotspot) -> hotspot down;
  * offline for GRACE seconds and a wifi device exists -> hotspot "Vatra-XXXX" up (WPA2, the
    password is printed on the boot partition next to the setup code), DNS answers every name
    with the hub (dnsmasq-shared.d) and this process serves the captive portal on :80;
  * hotspot up and saved wifi networks exist -> every RETRY seconds give the radio back to NM for
    a while so it can rejoin a network that came back (router reboot), unless someone is on the
    portal.
The portal listens on the hotspot address only and only while the hotspot is up (the hotspot is
WPA2 with the password printed on the boot partition), so nobody on the home LAN can move the hub
to another network. It only chooses a wifi network; claiming stays behind the setup code.
"""
from __future__ import annotations

import html
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

HOTSPOT = "vatra-setup"
AP_ADDR = "10.42.0.1"
GRACE = 90
RETRY = 600
RETRY_WINDOW = 45
TICK = 5
STATE = Path("/var/lib/vatra")
BOOT = Path("/boot/firmware")

T = {
    "en": {
        "title": "Connect your Vatra hub",
        "lead": "Pick the wifi network the hub should join. Your phone will leave this hotspot afterwards.",
        "network": "Network",
        "other": "Other (type the name)",
        "ssid": "Network name",
        "password": "Password",
        "password_hint": "Leave empty for an open network.",
        "connect": "Connect",
        "ethernet": "Or plug in a network cable: the hotspot turns off by itself.",
        "joining": "Joining {ssid}…",
        "joining_lead": "Reconnect your phone to {ssid}, then open the Vatra app or http://{host}.local:3737 to claim the hub with the setup code.",
        "failed": "Could not join {ssid}. Check the password and try again.",
        "missing": "Choose a network.",
        "weak": "A wifi password has at least 8 characters.",
    },
    "ro": {
        "title": "Conectează hubul Vatra",
        "lead": "Alege rețeaua wifi la care să se conecteze hubul. Telefonul tău va părăsi apoi acest hotspot.",
        "network": "Rețea",
        "other": "Alta (scrie numele)",
        "ssid": "Numele rețelei",
        "password": "Parolă",
        "password_hint": "Lasă gol pentru o rețea deschisă.",
        "connect": "Conectează",
        "ethernet": "Sau conectează un cablu de rețea: hotspotul se oprește singur.",
        "joining": "Se conectează la {ssid}…",
        "joining_lead": "Reconectează telefonul la {ssid}, apoi deschide aplicația Vatra sau http://{host}.local:3737 ca să revendici hubul cu codul de configurare.",
        "failed": "Nu s-a putut conecta la {ssid}. Verifică parola și încearcă din nou.",
        "missing": "Alege o rețea.",
        "weak": "O parolă wifi are cel puțin 8 caractere.",
    },
}


def lang_of(accept: str | None) -> str:
    for part in (accept or "").split(","):
        tag = part.split(";")[0].strip().lower()
        if tag.startswith("ro"):
            return "ro"
        if tag.startswith("en"):
            return "en"
    return "en"


def parse_wifi_file(text: str) -> tuple[str, str] | None:
    """SSID=... / PASSWORD=... (also PSK=), one per line, # comments; values taken verbatim."""
    vals: dict[str, str] = {}
    for line in text.splitlines():
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        vals[k.strip().upper()] = v
    ssid = vals.get("SSID", "").strip()
    if not ssid or len(ssid.encode()) > 32:
        return None
    return ssid, vals.get("PASSWORD", vals.get("PSK", ""))


def split_terse(line: str) -> list[str]:
    """nmcli -t output: ':' separated, '\\:' and '\\\\' escaped."""
    out, cur, esc = [], [], False
    for ch in line:
        if esc:
            cur.append(ch)
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


Runner = Callable[[list[str]], subprocess.CompletedProcess]


def default_runner(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)


def log(msg: str) -> None:
    print(f"[vatra-netsetup] {msg}", flush=True)


class Nm:
    def __init__(self, run: Runner = default_runner):
        self.run = run

    def nmcli(self, *args: str) -> subprocess.CompletedProcess:
        return self.run(["nmcli", *args])

    def active(self) -> list[tuple[str, str, str]]:
        r = self.nmcli("-t", "-f", "NAME,TYPE,STATE", "connection", "show", "--active")
        rows = [split_terse(l) for l in (r.stdout or "").splitlines() if l]
        return [(x[0], x[1], x[2]) for x in rows if len(x) >= 3]

    def online(self) -> bool:
        return any(
            name != HOTSPOT and state == "activated" and kind in ("802-3-ethernet", "802-11-wireless")
            for name, kind, state in self.active()
        )

    def hotspot_active(self) -> bool:
        return any(name == HOTSPOT for name, _, _ in self.active())

    def wifi_device(self) -> str | None:
        r = self.nmcli("-t", "-f", "DEVICE,TYPE,STATE", "device")
        for row in (split_terse(l) for l in (r.stdout or "").splitlines() if l):
            if len(row) >= 3 and row[1] == "wifi" and row[2] != "unmanaged":
                return row[0]
        return None

    def saved_wifi(self) -> list[str]:
        r = self.nmcli("-t", "-f", "NAME,TYPE", "connection", "show")
        rows = [split_terse(l) for l in (r.stdout or "").splitlines() if l]
        return [x[0] for x in rows if len(x) >= 2 and x[1] == "802-11-wireless" and x[0] != HOTSPOT]

    def scan(self, dev: str) -> list[dict]:
        r = self.nmcli("-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", dev, "--rescan", "yes")
        best: dict[str, dict] = {}
        for row in (split_terse(l) for l in (r.stdout or "").splitlines() if l):
            if len(row) < 3 or not row[0]:
                continue
            sig = int(row[1]) if row[1].isdigit() else 0
            if row[0] not in best or best[row[0]]["signal"] < sig:
                best[row[0]] = {"ssid": row[0], "signal": sig, "secure": row[2] not in ("", "--")}
        return sorted(best.values(), key=lambda n: -n["signal"])[:20]

    def hotspot_up(self, dev: str, ssid: str, psk: str) -> bool:
        self.nmcli("connection", "delete", HOTSPOT)
        r = self.nmcli(
            "connection", "add", "type", "wifi", "ifname", dev, "con-name", HOTSPOT, "autoconnect", "no",
            "ssid", ssid, "mode", "ap", "802-11-wireless.band", "bg",
            "ipv4.method", "shared", "ipv4.addresses", f"{AP_ADDR}/24", "ipv6.method", "disabled",
            "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.proto", "rsn", "wifi-sec.pairwise", "ccmp",
            "wifi-sec.group", "ccmp", "wifi-sec.psk", psk,
        )
        if r.returncode != 0:
            log(f"hotspot profile failed: {(r.stderr or r.stdout).strip()[-200:]}")
            return False
        r = self.nmcli("connection", "up", HOTSPOT)
        if r.returncode != 0:
            log(f"hotspot up failed: {(r.stderr or r.stdout).strip()[-200:]}")
            return False
        log(f"hotspot {ssid} up on {dev}")
        return True

    def hotspot_down(self) -> None:
        self.nmcli("connection", "down", HOTSPOT)
        log("hotspot down")

    def save_wifi(self, ssid: str, psk: str) -> bool:
        name = f"wifi-{re.sub(r'[^A-Za-z0-9_.-]', '_', ssid)[:40]}"
        self.nmcli("connection", "delete", name)
        args = ["connection", "add", "type", "wifi", "con-name", name, "ssid", ssid, "autoconnect", "yes",
                "connection.autoconnect-priority", "10"]
        if psk:
            args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", psk]
        r = self.nmcli(*args)
        if r.returncode != 0:
            log(f"saving {ssid} failed: {(r.stderr or r.stdout).strip()[-200:]}")
        return r.returncode == 0

    def connect(self, ssid: str) -> bool:
        name = f"wifi-{re.sub(r'[^A-Za-z0-9_.-]', '_', ssid)[:40]}"
        return self.nmcli("--wait", "40", "connection", "up", name).returncode == 0


@dataclass
class Setup:
    nm: Nm
    hostname: str = "vatra"
    boot: Path = BOOT
    state: Path = STATE
    clock: Callable[[], float] = time.monotonic
    offline_since: float | None = None
    last_retry: float = 0.0
    hotspot_since: float = 0.0
    last_portal: float = -1e9
    networks: list[dict] = field(default_factory=list)
    result: dict = field(default_factory=dict)
    pending: tuple[str, str] | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    # -------- identity ---------------------------------------------------------------------
    def ssid(self) -> str:
        suffix = self.hostname.rsplit("-", 1)[-1].upper() if "-" in self.hostname else self.hostname[-4:].upper()
        return f"Vatra-{suffix}"

    def psk(self) -> str:
        f = self.state / "hotspot-psk"
        if f.exists():
            v = f.read_text().strip()
            if len(v) >= 8:
                return v
        alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
        v = "".join(secrets.choice(alphabet) for _ in range(10))
        self.state.mkdir(parents=True, exist_ok=True)
        f.write_text(v + "\n")
        os.chmod(f, 0o600)
        return v

    # -------- the loop ---------------------------------------------------------------------
    def apply_wifi_file(self) -> None:
        f = self.boot / "vatra-wifi.txt"
        if not self.boot.is_dir() or not f.exists():
            return
        try:
            parsed = parse_wifi_file(f.read_text(errors="replace"))
        finally:
            try:
                f.unlink()
            except OSError:
                pass
        out = self.boot / "vatra-wifi-result.txt"
        if not parsed:
            out.write_text("error: vatra-wifi.txt needs SSID=<name> (and PASSWORD=<password>)\n")
            return
        ssid, psk = parsed
        if psk and len(psk) < 8:
            out.write_text(f"error: the password for {ssid} is shorter than 8 characters\n")
            return
        ok = self.nm.save_wifi(ssid, psk)
        out.write_text(f"{'saved' if ok else 'error: could not save'} {ssid}\n")
        if ok and self.nm.hotspot_active():
            self.nm.hotspot_down()
            self.last_retry = self.clock()

    def tick(self) -> None:
        self.apply_wifi_file()
        with self.lock:
            pending, self.pending = self.pending, None
        if pending:
            self.join(*pending)
            return
        now = self.clock()
        if self.nm.online():
            self.offline_since = None
            if self.nm.hotspot_active():
                self.nm.hotspot_down()
            return
        if self.offline_since is None:
            self.offline_since = now
        hot = self.nm.hotspot_active()
        if hot:
            idle = now - self.last_portal > 120
            if idle and self.nm.saved_wifi() and now - self.hotspot_since >= RETRY:
                log("giving the radio back to saved networks for a while")
                self.nm.hotspot_down()
                self.last_retry = now
            return
        if now - self.last_retry < RETRY_WINDOW:
            return
        if now - self.offline_since < GRACE:
            return
        dev = self.nm.wifi_device()
        if not dev:
            return
        self.networks = self.nm.scan(dev)
        if self.nm.hotspot_up(dev, self.ssid(), self.psk()):
            self.hotspot_since = now

    def join(self, ssid: str, psk: str) -> None:
        if not self.nm.save_wifi(ssid, psk):
            self.result = {"state": "failed", "ssid": ssid}
            return
        self.nm.hotspot_down()
        ok = self.nm.connect(ssid)
        self.result = {"state": "joined" if ok else "failed", "ssid": ssid}
        log(f"join {ssid}: {'ok' if ok else 'failed'}")
        self.last_retry = self.clock()
        if not ok:
            # back to the hotspot on the next ticks, with the error on the portal
            self.offline_since = self.clock() - GRACE

    # -------- portal -----------------------------------------------------------------------
    def submit(self, form: dict[str, str]) -> str | None:
        """Validates a portal POST and queues the join. Returns an error key or None."""
        ssid = (form.get("ssid_other") or "").strip() if form.get("ssid") == "__other__" else (form.get("ssid") or "").strip()
        psk = form.get("password") or ""
        if not ssid or len(ssid.encode()) > 32:
            return "missing"
        if psk and not 8 <= len(psk) <= 63:
            return "weak"
        with self.lock:
            self.pending = (ssid, psk)
            self.result = {"state": "joining", "ssid": ssid}
        return None

    def page(self, lang: str, error: str | None = None) -> str:
        t = T[lang]
        e = html.escape
        res = self.result
        if res.get("state") == "joining":
            body = (f"<h1>{e(t['joining'].format(ssid=res['ssid']))}</h1>"
                    f"<p>{e(t['joining_lead'].format(ssid=res['ssid'], host=self.hostname))}</p>")
        else:
            msg = error and t[error]
            if not msg and res.get("state") == "failed":
                msg = t["failed"].format(ssid=res["ssid"])
            opts = "".join(
                f'<option value="{e(n["ssid"])}">{e(n["ssid"])}{" 🔒" if n["secure"] else ""}</option>' for n in self.networks
            )
            body = (
                f"<h1>{e(t['title'])}</h1><p>{e(t['lead'])}</p>"
                + (f'<p class="err" role="alert">{e(msg)}</p>' if msg else "")
                + f'<form method="post" action="/connect"><label for="ssid">{e(t["network"])}</label>'
                f'<select id="ssid" name="ssid">{opts}<option value="__other__">{e(t["other"])}</option></select>'
                f'<label for="ssid_other">{e(t["ssid"])}</label><input id="ssid_other" name="ssid_other" maxlength="32" autocomplete="off">'
                f'<label for="password">{e(t["password"])}</label>'
                f'<input id="password" name="password" type="password" maxlength="63" aria-describedby="ph" autocomplete="off">'
                f'<p id="ph" class="hint">{e(t["password_hint"])}</p><button type="submit">{e(t["connect"])}</button></form>'
                f'<p class="hint">{e(t["ethernet"])}</p>'
            )
        return (
            f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{e(t['title'])}</title><style>"
            "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#1b1714;color:#f4ede6}"
            "main{max-width:420px;margin:auto}h1{font-size:1.4rem}label{display:block;margin-top:16px;font-weight:600}"
            "select,input{width:100%;box-sizing:border-box;padding:12px;margin-top:6px;border-radius:10px;border:1px solid #6b5d52;"
            "background:#2a241f;color:inherit;font:inherit}button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:10px;"
            "background:#e8833a;color:#1b1714;font:inherit;font-weight:700}button:focus-visible,select:focus-visible,input:focus-visible"
            "{outline:3px solid #ffd2a8;outline-offset:2px}.hint{color:#cbbdb1;font-size:.9rem}.err{color:#ffb4a8;font-weight:600}"
            f"</style></head><body><main>{body}</main></body></html>"
        )


def make_handler(setup: Setup):
    class Portal(BaseHTTPRequestHandler):
        server_version = "vatra-portal"

        def log_message(self, *_a):  # quiet: no request lines with client data in the journal
            pass

        def _send(self, code: int, body: str = "", ctype="text/html; charset=utf-8", headers: dict | None = None):
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            setup.last_portal = setup.clock()
            host = (self.headers.get("Host") or "").split(":")[0]
            path = urllib.parse.urlsplit(self.path).path
            if path == "/status.json":
                return self._send(200, json.dumps({"result": setup.result, "networks": len(setup.networks)}), "application/json")
            # Any other host = an OS connectivity probe or a typed URL: send it to the portal,
            # which makes Android / iOS / Windows open the captive sign-in sheet.
            if host not in (AP_ADDR, f"{setup.hostname}.local") or path != "/":
                return self._send(302, "", headers={"Location": f"http://{AP_ADDR}/"})
            self._send(200, setup.page(lang_of(self.headers.get("Accept-Language"))))

        def do_POST(self):
            setup.last_portal = setup.clock()
            n = min(int(self.headers.get("Content-Length") or 0), 4096)
            form = {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(n).decode(errors="replace")).items()}
            lang = lang_of(self.headers.get("Accept-Language"))
            err = setup.submit(form)
            self._send(400 if err else 200, setup.page(lang, err))

    return Portal


def serve(setup: Setup, addr: str = AP_ADDR, port: int = 80) -> ThreadingHTTPServer | None:
    try:
        srv = ThreadingHTTPServer((addr, port), make_handler(setup))
    except OSError as e:
        log(f"portal not served yet: {e}")
        return None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"portal on http://{addr}:{port}/")
    return srv


def portal_follow(setup: Setup, srv: ThreadingHTTPServer | None) -> ThreadingHTTPServer | None:
    """Portal up exactly while the hotspot is."""
    hot = setup.nm.hotspot_active()
    if hot and srv is None:
        return serve(setup)
    if not hot and srv is not None:
        srv.shutdown()
        srv.server_close()
        log("portal closed")
        return None
    return srv


CODE_FILE = Path("/srv/vatra/data/vatra-setup-code.txt")

NOTE = {
    "en": (
        "VATRA HUB {host}\n"
        "{claim}\n"
        "Find it: the Vatra app on the same network, or http://{host}.local:3737\n"
        "No network cable and no wifi yet? After 90 seconds the hub opens the wifi hotspot\n"
        "  {ssid}  password  {psk}\n"
        "Join it from your phone and pick your home wifi on the page that opens.\n"
        "Or put a file vatra-wifi.txt next to this one with two lines: SSID=<name> and\n"
        "PASSWORD=<password>. The hub reads it at boot, deletes it and writes vatra-wifi-result.txt.\n"
    ),
    "ro": (
        "HUB VATRA {host}\n"
        "{claim}\n"
        "Îl găsești: aplicația Vatra în aceeași rețea, sau http://{host}.local:3737\n"
        "Fără cablu de rețea și fără wifi? După 90 de secunde hubul deschide hotspotul wifi\n"
        "  {ssid}  parola  {psk}\n"
        "Conectează-te din telefon și alege wifi-ul de acasă pe pagina care se deschide.\n"
        "Sau pune lângă acest fișier un fișier vatra-wifi.txt cu două rânduri: SSID=<nume> și\n"
        "PASSWORD=<parolă>. Hubul îl citește la pornire, îl șterge și scrie vatra-wifi-result.txt.\n"
    ),
}
CLAIM = {
    "en": (
        "Setup code: {code}  (the app asks for it when you claim the hub)",
        "Claimed: this hub already has an owner.",
        "Starting: the setup code appears in this file a few minutes after the first boot.",
    ),
    "ro": (
        "Cod de configurare: {code}  (aplicația îl cere când revendici hubul)",
        "Revendicat: acest hub are deja un proprietar.",
        "Pornește: codul de configurare apare în acest fișier la câteva minute după prima pornire.",
    ),
}


def bootnote(setup: Setup, code_file: Path = CODE_FILE) -> str:
    try:
        code = code_file.read_text().strip()
    except OSError:
        code = ""
    ident = {"host": setup.hostname, "ssid": setup.ssid(), "psk": setup.psk()}
    parts = []
    for lang in ("en", "ro"):
        fresh, done, pending = CLAIM[lang]
        if re.fullmatch(r"\d{6}", code):
            claim = fresh.format(code=f"{code[:3]} {code[3:]}")
        else:
            claim = done if code == "claimed" else pending
        parts.append(NOTE[lang].format(claim=claim, **ident))
    return "\n".join(parts)


ISSUE = {
    "en": "Vatra hub \\n  http://\\n.local:3737  (or http://\\4:3737)\n{claim}\n",
    "ro": "Hub Vatra \\n  http://\\n.local:3737  (sau http://\\4:3737)\n{claim}\n",
}


def issue(code_file: Path = CODE_FILE) -> str:
    """agetty /etc/issue.d snippet for VM / monitor consoles (x86 image): \\n host, \\4 IPv4."""
    try:
        code = code_file.read_text().strip()
    except OSError:
        code = ""
    out = []
    for lang in ("en", "ro"):
        fresh, done, pending = CLAIM[lang]
        if re.fullmatch(r"\d{6}", code):
            claim = fresh.format(code=f"{code[:3]} {code[3:]}")
        else:
            claim = done if code == "claimed" else pending
        out.append(ISSUE[lang].format(claim=claim))
    return "\n" + "\n".join(out) + "\n"


def write_bootnote(setup: Setup, code_file: Path = CODE_FILE) -> None:
    out = setup.boot / "vatra-setup.txt"
    tmp = setup.boot / "vatra-setup.tmp"
    tmp.write_text(bootnote(setup, code_file).replace("\n", "\r\n"))
    os.replace(tmp, out)


def main() -> int:
    host = os.uname().nodename
    setup = Setup(nm=Nm(), hostname=host)
    if "--identity" in sys.argv:
        # hotspot name + password for the boot-partition note (creates the password once)
        print(json.dumps({"ssid": setup.ssid(), "psk": setup.psk()}))
        return 0
    if "--bootnote" in sys.argv:
        write_bootnote(setup)
        return 0
    if "--issue" in sys.argv:
        out = Path("/etc/issue.d/vatra.issue")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(issue())
        return 0
    log(f"started on {host}, hotspot {setup.ssid()} after {GRACE}s offline")
    srv = None
    while True:
        try:
            setup.tick()
            srv = portal_follow(setup, srv)
        except Exception as e:  # noqa: BLE001 (never die: this is the only way in without a cable)
            log(f"tick failed: {e}")
        time.sleep(TICK)


if __name__ == "__main__":
    raise SystemExit(main())
