"""Turzx desk-screen renderer.

  pythonw turzx.py            # logon task vmui-turzx
  python  turzx.py --once    # render each view (every skin) to .copilot-tmp/turzx/*.png, no hardware
  python  turzx.py --once --skin glass

Loop: poll vmui /api/turzx/state every 3 s (settings + HA + feeds), sample
PC metrics locally, tick the active view at `fps`, rotate after the view's
own dwell with a strip-wipe transition, and send only changed pixels over
USB within a per-frame byte budget (link ≈ 365 KB/s). Photo backgrounds are
swapped only at view entry, so the one 300 KB repaint coincides with the
transition that repaints everything anyway.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import psutil
import serial
from PIL import Image, ImageChops, ImageDraw

import audit

sys.path.insert(0, str(Path(__file__).parent))
from anim import Clock, dirty_rects, transition  # noqa: E402
from backgrounds import Backgrounds  # noqa: E402
from lcd import TurzxLcd  # noqa: E402
from overlay import NotificationOverlay  # noqa: E402
from skins import build as build_skin, font  # noqa: E402
from views import BG, TZ, VIEWS, H, W, hex_rgb  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / ".copilot-tmp" / "service-logs" / "turzx.log"
VMUI = os.environ.get("VMUI_URL", "http://127.0.0.1:3737").rstrip("/")
MIRROR = ROOT / ".copilot-tmp" / "turzx" / "mirror.png"
MIRROR_TMP = MIRROR.with_suffix(".tmp")
DEBUG = bool(os.environ.get("TURZX_DEBUG"))
LINK_BPS = 365_000  # measured 2026-09-14: 300 KB in 0.823 s, linear down to 3 KB
MIN_DWELL = 5

try:  # 1 ms scheduler tick; default ~15.6 ms makes 20 fps pacing jitter by a whole frame
    import ctypes

    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

try:
    import pynvml  # type: ignore

    pynvml.nvmlInit()
    _GPU = pynvml.nvmlDeviceGetHandleByIndex(0)
except Exception:  # no NVIDIA / driver mid-update
    _GPU = None


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")


def token() -> str:
    if t := os.environ.get("ESP_DISPLAY_TOKEN"):
        return t
    for line in (ROOT / ".private" / "credentials.env").read_text(encoding="utf-8").splitlines():
        if line.startswith("ESP_DISPLAY_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("ESP_DISPLAY_TOKEN missing")


DEFAULT_BG = {"mode": "none", "sources": [], "folder": "", "dim": 0.45, "blur": 0}
DEFAULT_SETTINGS = {
    "version": 2,
    "views": [{"id": k, "enabled": k in ("clock", "weather", "home", "pc", "media"), "dwellSec": 12, "skin": "minimal", "background": None, "options": {}} for k in VIEWS],
    "fps": 20, "transitionMs": 600, "brightness": 60, "nightBrightness": 15, "nightFrom": "23:00", "nightTo": "07:30",
    "accent": "#7c9cff", "flip": False, "background": DEFAULT_BG, "bgRotateMin": 30,
}


class State:
    """Shared between the poller thread and the render loop."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.data: dict = {"settings": DEFAULT_SETTINGS, "haOnline": False}
        self.online = False
        # album art per player, keyed by the raw `art` value the API gives us
        self.arts: dict[str, Image.Image | None] = {}

    def snapshot(self) -> dict:
        with self.lock:
            d = dict(self.data)
            d["_arts"] = dict(self.arts)
        # On the PC the renderer samples the host itself. On the Pi the PC runs
        # `turzx.py --publish`, which posts the same dict to vmui, and the state
        # payload carries it back as `pc`.
        d["pc"] = pc_metrics() if _LOCAL_PC else (self.data.get("pc") or {})
        d["pi"] = pi_metrics()
        return d


_pc: dict = {}


def _pc_worker() -> None:
    """All host sampling on one thread; the render loop just reads `_pc`.
    Reason: psutil.process_iter(cpu_percent) takes ~7 s here and, even on a
    thread, held the GIL enough to drag pc_metrics() from 1 ms to 80 ms and
    the panel to 7 fps. So the expensive scan runs rarely and the cheap
    samples are refreshed in between, all off the frame path."""
    global _pc
    ncpu = psutil.cpu_count() or 1
    last_scan = 0.0
    top = ""
    disks_at = 0.0
    disks: list[dict] = []
    while True:
        out = {"cpu": psutil.cpu_percent(interval=None), "ram": psutil.virtual_memory().percent, "uptime": time.time() - psutil.boot_time()}
        if _GPU is not None:
            try:
                out["gpu"] = pynvml.nvmlDeviceGetUtilizationRates(_GPU).gpu
                out["gpuTemp"] = pynvml.nvmlDeviceGetTemperature(_GPU, 0)
                m = pynvml.nvmlDeviceGetMemoryInfo(_GPU)
                out["vram"] = m.used * 100 / m.total
            except Exception:
                pass
        out["top"] = top
        out["focus"] = _focus.sample()
        if time.perf_counter() - disks_at > 60:
            disks_at = time.perf_counter()
            disks = []
            for p in psutil.disk_partitions(all=False):
                try:
                    u = psutil.disk_usage(p.mountpoint)
                    disks.append({"drive": p.device.rstrip("\\"), "pct": u.percent, "freeGb": u.free / 2**30, "totalGb": u.total / 2**30})
                except Exception:
                    pass
        out["disks"] = disks
        _pc = out
        if time.perf_counter() - last_scan > 20:
            last_scan = time.perf_counter()
            # A thread was not enough: process_iter holds the GIL so much that
            # the render loop fell to 1.6 fps. A child interpreter has its own
            # GIL; we pay one process spawn every 20 s instead.
            try:
                r = subprocess.run(
                    [sys.executable, "-c", _TOP_SNIPPET], capture_output=True, text=True, timeout=15,
                    creationflags=0x08000000 if sys.platform == "win32" else 0, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                )
                name, _, pct = r.stdout.strip().partition("|")
                top = f"{name.removesuffix('.exe')} {float(pct) / ncpu:.0f}%" if name and float(pct or 0) >= 5 else ""
            except Exception:
                top = ""
        time.sleep(1.0)


class _Focus:
    """Foreground window + idle time via user32; buckets the day into
    code / browser / terminal / media / other so the focus view can show
    where the hours went. Sampled once a second on the host thread."""

    BUCKETS = {
        "code": ("code", "code - insiders", "cursor", "devenv", "rider", "pycharm", "idea", "windsurf"),
        "browser": ("chrome", "msedge", "firefox", "brave", "arc", "opera", "vivaldi"),
        "terminal": ("windowsterminal", "pwsh", "powershell", "cmd", "wt", "alacritty", "conhost"),
        "media": ("spotify", "vlc", "mpc-hc", "musicbee", "foobar2000", "youtube", "netflix", "obs64", "mixxx", "rekordbox"),
        "chat": ("discord", "slack", "teams", "ms-teams", "telegram", "whatsapp", "signal", "zoom"),
    }

    def __init__(self) -> None:
        self.title = ""
        self.proc = ""
        self.since = time.time()
        self.day = datetime.now(TZ).date()
        self.buckets: dict[str, float] = {}
        self.idle_s = 0.0
        self.last = time.perf_counter()
        try:
            import ctypes
            import ctypes.wintypes as w

            self.u32 = ctypes.windll.user32
            self.k32 = ctypes.windll.kernel32
            self.w = w
            self.ctypes = ctypes
        except Exception:
            self.u32 = None

    def _fg(self) -> tuple[str, str]:
        h = self.u32.GetForegroundWindow()
        buf = self.ctypes.create_unicode_buffer(512)
        self.u32.GetWindowTextW(h, buf, 512)
        pid = self.w.DWORD()
        self.u32.GetWindowThreadProcessId(h, self.ctypes.byref(pid))
        try:
            name = psutil.Process(pid.value).name().removesuffix(".exe") if pid.value else ""
        except Exception:
            name = ""
        return buf.value, name

    def _idle(self) -> float:
        class LASTINPUTINFO(self.ctypes.Structure):
            _fields_ = [("cbSize", self.w.UINT), ("dwTime", self.w.DWORD)]

        li = LASTINPUTINFO()
        li.cbSize = self.ctypes.sizeof(LASTINPUTINFO)
        if not self.u32.GetLastInputInfo(self.ctypes.byref(li)):
            return 0.0
        return (self.k32.GetTickCount() - li.dwTime) / 1000.0

    def bucket(self, proc: str, title: str) -> str:
        p, t = proc.lower(), title.lower()
        for b, names in self.BUCKETS.items():
            if p in names or any(n in t for n in names if b == "media"):
                return b
        return "other"

    def sample(self) -> dict:
        if not self.u32:
            return {}
        now = time.perf_counter()
        dt, self.last = now - self.last, now
        today = datetime.now(TZ).date()
        if today != self.day:
            self.day, self.buckets = today, {}
        try:
            title, proc = self._fg()
            self.idle_s = self._idle()
        except Exception:
            return {}
        if proc != self.proc or (title != self.title and proc in ("chrome", "msedge", "firefox")):
            self.proc, self.title, self.since = proc, title, time.time()
        else:
            self.title = title
        if self.idle_s < 60:
            b = self.bucket(proc, title)
            self.buckets[b] = self.buckets.get(b, 0.0) + dt
        # Strip the app suffix VS Code / browsers append: "file - repo - Visual Studio Code"
        short = re.sub(r"\s[-–—]\s[^-–—]*$", "", title).strip() or proc
        return {"proc": proc, "title": short[:80], "since": self.since, "idle": self.idle_s, "buckets": dict(self.buckets)}


_focus = _Focus()


_TOP_SNIPPET = (
    "import psutil,time\n"
    "ps=[p for p in psutil.process_iter(['name'])]\n"
    "for p in ps:\n"
    "    try: p.cpu_percent(None)\n"
    "    except Exception: pass\n"
    "time.sleep(1.0)\n"
    "best,name=0.0,''\n"
    "for p in ps:\n"
    "    try:\n"
    "        v=p.cpu_percent(None)\n"
    "        if v>best and p.info['name'] not in ('System Idle Process','Idle'): best,name=v,p.info['name'] or ''\n"
    "    except Exception: pass\n"
    "print(f'{name}|{best}')\n"
)


_LOCAL_PC = sys.platform == "win32"
if _LOCAL_PC:
    threading.Thread(target=_pc_worker, daemon=True).start()


def pc_metrics() -> dict:
    return _pc


_pi: dict = {}


def _pi_worker() -> None:
    """Metrics of the machine the renderer runs on (the Pi). Cheap /proc and
    vcgencmd reads, once a second, off the frame path like `_pc_worker`."""
    global _pi
    last_net = (0, 0, time.perf_counter())
    dips = 0
    was_low = False
    while True:
        out: dict = {"cpu": psutil.cpu_percent(interval=None), "ram": psutil.virtual_memory().percent, "uptime": time.time() - psutil.boot_time()}
        try:
            out["temp"] = int(open("/sys/class/thermal/thermal_zone0/temp").read()) / 1000
        except Exception:
            pass
        try:
            out["load"] = os.getloadavg()[0]
        except Exception:
            pass
        try:
            du = psutil.disk_usage("/")
            out["disk"] = {"pct": du.percent, "freeGb": du.free / 2**30, "totalGb": du.total / 2**30}
        except Exception:
            pass
        try:
            io = psutil.net_io_counters()
            rx, tx, at = io.bytes_recv, io.bytes_sent, time.perf_counter()
            dtn = max(at - last_net[2], 0.001)
            if last_net[0]:
                out["rxKbps"] = max(0.0, (rx - last_net[0]) * 8 / 1000 / dtn)
                out["txKbps"] = max(0.0, (tx - last_net[1]) * 8 / 1000 / dtn)
            else:
                out["rxKbps"] = out["txKbps"] = 0.0
            last_net = (rx, tx, at)
        except Exception:
            pass
        try:
            r = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=2)
            v = int(r.stdout.strip().split("=")[1], 16)
            # bit 0 under-voltage now, 1 freq capped now, 2 throttled now, 3 soft temp limit now; 16-19 = ever
            out["throttled"] = {"undervolt": bool(v & 1), "capped": bool(v & 2), "throttled": bool(v & 4), "softTemp": bool(v & 8), "ever": bool(v & 0xF0000)}
            r = subprocess.run(["vcgencmd", "measure_clock", "arm"], capture_output=True, text=True, timeout=2)
            out["mhz"] = int(r.stdout.strip().split("=")[1]) // 1_000_000
            # The Pi 4 has no ADC on the 5 V rail (pmic_read_adc is a Pi 5 command);
            # core voltage + the under-voltage bit are what the firmware exposes.
            r = subprocess.run(["vcgencmd", "measure_volts", "core"], capture_output=True, text=True, timeout=2)
            out["coreV"] = float(r.stdout.strip().split("=")[1].rstrip("V"))
            low = bool(v & 1)
            if low and not was_low:
                dips += 1
            was_low = low
            out["dips"] = dips
        except Exception:
            pass
        try:
            r = subprocess.run(["vcgencmd", "measure_temp", "pmic"], capture_output=True, text=True, timeout=2)
            if "=" in r.stdout:
                out["pmicTemp"] = float(r.stdout.strip().split("=")[1].rstrip("'C"))
        except Exception:
            pass
        try:
            out["containers"] = len([p for p in os.listdir("/sys/fs/cgroup/system.slice") if p.startswith("docker-")])
        except Exception:
            pass
        _pi = out
        # The Nest Hub kiosk reads the Pi panel from vmui, not from this process:
        # mirror the dict into the same store the PCs publish to.
        try:
            body = json.dumps(out).encode()
            req = urllib.request.Request(f"{VMUI}/api/turzx/pc?k={_PI_TOKEN}&host=homepi&kind=pi", data=body, method="POST", headers={"content-type": "application/json"})
            urllib.request.urlopen(req, timeout=3).read()
        except Exception:
            pass
        time.sleep(1.0)


if sys.platform.startswith("linux"):
    try:
        _PI_TOKEN = token()
    except Exception:
        _PI_TOKEN = ""
    threading.Thread(target=_pi_worker, daemon=True).start()


def pi_metrics() -> dict:
    return _pi


def publish_pc(tok: str, every: float = 2.0) -> None:
    """PC-side agent: push host metrics to vmui (running on the Pi) forever."""
    import socket
    host = socket.gethostname().lower()
    while True:
        url = f"{VMUI}/api/turzx/pc?k={tok}&host={host}"
        body = json.dumps(pc_metrics()).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={"content-type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=5).read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                # token rotated in .private/credentials.env while we were running
                try:
                    tok = token()
                except Exception:
                    pass
                time.sleep(10)
                continue
        except Exception:
            pass
        time.sleep(every)


def poller(st: State, tok: str, stop: threading.Event, bgs: Backgrounds | None) -> None:
    interval = 3.0
    while not stop.is_set():
        try:
            with urllib.request.urlopen(f"{VMUI}/api/turzx/state?k={tok}", timeout=6) as r:
                data = json.loads(r.read())
            with st.lock:
                st.data = data
                st.online = True
            # Adaptive cadence: 2 s while something plays (lyrics/position stay
            # tight), 3 s by day, 10 s in the night window when the ambient
            # screen shows and nothing on the panel changes per poll anyway.
            playing = any(m.get("state") == "playing" for m in data.get("media") or [])
            interval = 2.0 if playing else 10.0 if night(data.get("settings") or {}) else 3.0
            if bgs is not None:
                bgs.set_online(data.get("photos") or [])
            ha = (data.get("haUrl") or "").rstrip("/")
            keys = {x["art"] for x in data.get("media") or [] if x.get("art")}
            for key in keys - set(st.arts):
                url = f"{ha}{key}" if key.startswith("/") else key
                img = None
                if not key.startswith("/") or ha:
                    try:
                        with urllib.request.urlopen(url, timeout=4) as r:
                            img = Image.open(io.BytesIO(r.read())).convert("RGB")
                    except Exception:
                        img = None
                with st.lock:
                    st.arts[key] = img
            # HA rotates the entity_picture token per track, so stale keys just fall out
            with st.lock:
                for k in [k for k in st.arts if k not in keys]:
                    del st.arts[k]
        except Exception as e:
            with st.lock:
                st.online = False
            log(f"poll: {e.__class__.__name__}: {e}")
            interval = 3.0
        stop.wait(interval)


def night(settings: dict) -> bool:
    now = datetime.now(TZ).strftime("%H:%M")
    a, b = settings.get("nightFrom", "23:00"), settings.get("nightTo", "07:30")
    return (a <= now or now < b) if a > b else (a <= now < b)


_F_TINY = font(15, "r")


def offline_badge(c: Image.Image, online: bool) -> None:
    if online:
        return
    d = ImageDraw.Draw(c)
    d.rounded_rectangle((W - 118, H - 30, W - 8, H - 8), radius=8, fill=(60, 24, 24))
    d.text((W - 63, H - 19), "vmui offline", font=_F_TINY, fill=(252, 165, 165), anchor="mm")


def merge_rects(rects: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """Greedily merge pairs whose bounding union costs < 25% more bytes than
    sending them apart. Fewer commands, same pixels."""
    rs = list(rects)
    changed = True
    while changed and len(rs) > 1:
        changed = False
        for i in range(len(rs)):
            for j in range(i + 1, len(rs)):
                a, b = rs[i], rs[j]
                u = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                area = lambda r: (r[2] - r[0]) * (r[3] - r[1])
                if area(u) <= (area(a) + area(b)) * 1.25:
                    rs[i] = u
                    del rs[j]
                    changed = True
                    break
            if changed:
                break
    return rs


def dots(c: Image.Image, i: int, n: int, accent, muted) -> None:
    if n <= 1:
        return
    d = ImageDraw.Draw(c)
    x0 = W // 2 - (n * 12) // 2
    for k in range(n):
        r = 4 if k == i else 2
        d.ellipse((x0 + k * 12 - r, H - 6 - r, x0 + k * 12 + r, H - 6 + r), fill=accent if k == i else muted)


class Renderer:
    def __init__(self, st: State, lcd: TurzxLcd | None, bgs: Backgrounds | None) -> None:
        self.st = st
        self.lcd = lcd
        self.bgs = bgs
        self.settings: dict = {}
        self.accent = hex_rgb(DEFAULT_SETTINGS["accent"])
        self.views = {k: V(self.accent) for k, V in VIEWS.items()}
        self.cfg: dict[str, dict] = {}  # view id -> its config block
        self.order: list[str] = []  # enabled ids in order
        self.base_order: list[str] = []  # from settings, before pc fan-out
        self.idx = 0
        self.dwell_t = time.perf_counter()
        self.trans: tuple[Image.Image, float, str] | None = None
        self.prev: Image.Image | None = None
        self.bright = -1
        self.clock = Clock()
        # background state for the current view
        self.bg_img: Image.Image | None = None
        self.bg_meta: dict = {}
        self.bg_at = 0.0
        self.bg_key: str | None = None
        # remembered per view so passing through a flat view does not reset the photo timer
        self.bg_by_view: dict[str, tuple[Image.Image, dict, str, float]] = {}
        self.overlay = NotificationOverlay()
        self.last_full = time.perf_counter()
        self.since_sync: Image.Image | None = None
        self.stalls = 0
        self.full_push_pending = True
        self.apply_settings(DEFAULT_SETTINGS)

    # ---- settings
    def apply_settings(self, s: dict) -> None:
        if s == self.settings:
            return
        if s.get("version") != 2:  # a stale/old-format row: keep defaults
            s = DEFAULT_SETTINGS
        self.settings = {**DEFAULT_SETTINGS, **s}
        self.accent = hex_rgb(self.settings["accent"])
        cfgs = [c for c in self.settings["views"] if c.get("id") in self.views]
        self.cfg = {c["id"]: c for c in cfgs}
        for vid, c in self.cfg.items():
            self.views[vid].configure(c.get("skin") or "minimal", self.accent, c.get("options") or {})
        self.base_order = [c["id"] for c in cfgs if c.get("enabled")] or ["clock"]
        self.set_order(self.expand_order())
        flip = bool(self.settings.get("flip"))
        if self.lcd and flip != self.lcd.flip:
            self.lcd.set_orientation(True, flip)
            self.prev = None
        self.overlay.configure(self.settings.get("notify") or {})

    def set_order(self, order: list[str]) -> None:
        if order != self.order:
            cur = self.order[self.idx % len(self.order)] if self.order else None
            self.order = order
            self.idx = order.index(cur) if cur in order else 0

    def expand_order(self) -> list[str]:
        """The `pc` slot fans out into one view per machine currently publishing
        (`pc:<host>`), in the same position; with no publishers it stays the
        single legacy view so the slot never vanishes silently."""
        hosts = sorted(k for k in self.views if k.startswith("pc:"))
        out: list[str] = []
        for vid in self.base_order:
            if vid == "pc" and hosts:
                out.extend(hosts)
            else:
                out.append(vid)
        return out

    def sync_pc_hosts(self, data: dict) -> None:
        """Create/destroy per-machine PC views to mirror `pcs` from vmui."""
        hosts = set((data.get("pcs") or {}).keys())
        have = {k[3:] for k in self.views if k.startswith("pc:")}
        if hosts == have:
            return
        pc_cfg = self.cfg.get("pc", {})
        for h in hosts - have:
            v = VIEWS["pc"](self.accent)
            v.id = f"pc:{h}"
            v.host = h
            v.configure(pc_cfg.get("skin") or "minimal", self.accent, pc_cfg.get("options") or {})
            self.views[v.id] = v
            self.cfg[v.id] = {**pc_cfg, "id": v.id, "options": {k: val for k, val in (pc_cfg.get("options") or {}).items() if k != "hostname"}}
            self.bg_by_view.pop(v.id, None)
        for h in have - hosts:
            self.views.pop(f"pc:{h}", None)
            self.cfg.pop(f"pc:{h}", None)
        self.set_order(self.expand_order())
        if DEBUG:
            log(f"pc hosts: {sorted(hosts) or 'none'}")

    def current(self):
        return self.views[self.order[self.idx % len(self.order)]]

    def dwell_of(self, vid: str, data: dict | None = None) -> float:
        base = float(self.cfg.get(vid, {}).get("dwellSec") or 12)
        scale = 1.0
        v = self.views.get(vid)
        if v is not None and data is not None:
            try:
                scale = max(0.3, min(1.5, float(v.dwell_scale(data))))
            except Exception:
                scale = 1.0
        return max(MIN_DWELL, base * scale)

    def bg_cfg(self, vid: str) -> dict:
        own = self.cfg.get(vid, {}).get("background")
        g = own or self.settings.get("background") or DEFAULT_BG
        if vid == "photo" and g.get("mode") != "photo":
            # the photo view IS the photo; with no photo config it still shows the online pool
            return {**g, "mode": "photo", "sources": g.get("sources") or ["apod", "met", "artic", "commons"]}
        return g

    # ---- rotation
    def advance(self, data: dict) -> None:
        """Next enabled view whose visible() says yes; may stay on the same one."""
        n = len(self.order)
        for k in range(1, n + 1):
            j = (self.idx + k) % n
            if self.views[self.order[j]].visible(data):
                self.idx = j
                return
        self.idx = (self.idx + 1) % n

    def enter_view(self, data: dict, now: float) -> None:
        v = self.current()
        v.enter()
        v.update(data, 0.0)
        self.dwell_t = now
        self.refresh_background(v, force_new=(v.id == "photo"))

    def refresh_background(self, v, force_new: bool = False) -> None:
        cfg = self.bg_cfg(v.id)
        want_photo = cfg.get("mode") == "photo" and (v.wants_photo or v.id == "photo") and v.sk.photo_ok and self.bgs is not None
        if not want_photo:
            self.bg_img, self.bg_meta, self.bg_key = None, {}, None
            return
        rotate_s = max(60.0, float(self.settings.get("bgRotateMin") or 30) * 60)
        remembered = self.bg_by_view.get(v.id)
        if remembered and not force_new and time.time() - remembered[3] < rotate_s:
            self.bg_img, self.bg_meta, self.bg_key, self.bg_at = remembered
            return
        if self.bg_img is not None and not force_new and time.time() - self.bg_at < rotate_s and self.bg_key == (remembered or (None, None, None))[2]:
            return
        srcs = list(cfg.get("sources") or [])
        if self.bgs is not None:
            self.bgs.set_folder(str(cfg.get("folder") or ""))
            got = self.bgs.pick(srcs, exclude=self.bg_key)
            if got:
                self.bg_img, self.bg_meta = got
                self.bg_key = self.bg_meta.get("key")
                self.bg_at = time.time()
                self.bg_by_view[v.id] = (self.bg_img, self.bg_meta, self.bg_key, self.bg_at)

    # ---- frame
    def render(self, now: float, dt: float, data: dict) -> Image.Image:
        v = self.current()
        cfg = self.bg_cfg(v.id)
        photo = self.bg_img if (cfg.get("mode") == "photo" and (v.wants_photo or v.id == "photo")) else None
        if photo is not None and v.id == "photo" and (v.options or {}).get("kenBurns", True):
            photo = self.ken_burns(photo, now - self.dwell_t, self.dwell_of(v.id, data))
        dim = float(cfg.get("dim") or 0) if v.id != "photo" else 0.0
        blur = int(cfg.get("blur") or 0) if v.id != "photo" else 0
        c = v.sk.base((W, H), photo, dim, blur)
        data["_bgmeta"] = self.bg_meta
        data["_night"] = night(self.settings)
        v.update(data, dt)
        progress = 1.0 - min(1.0, (now - self.dwell_t) / self.dwell_of(v.id, data))
        v.draw(c, now - v.t0, progress)
        dots(c, self.idx % len(self.order), len(self.order), v.sk.accent, v.sk.track)
        offline_badge(c, self.st.online)
        return c

    _kb_cache: tuple[int, Image.Image] | None = None

    def ken_burns(self, photo: Image.Image, elapsed: float, dwell: float) -> Image.Image:
        """Slow push-in over the dwell. A whole-frame change costs 300 KB on this
        link, so the crop is quantised to move once per ~2 s: 0.5 frame/s of
        traffic, and the panel still reads as a gentle drift rather than a jump."""
        key = id(photo)
        if not self._kb_cache or self._kb_cache[0] != key:
            self._kb_cache = (key, photo.resize((int(W * 1.12), int(H * 1.12)), Image.LANCZOS))
        big = self._kb_cache[1]
        steps = max(1, int(dwell // 2))
        p = min(1.0, (int(elapsed // 2)) / steps)
        scale = 1.12 - 0.12 * p  # 1.12 → 1.0 : zoom out while drifting
        cw, ch = int(W * scale), int(H * scale)
        x = int((big.width - cw) * (0.5 + 0.5 * p))
        y = int((big.height - ch) * 0.5)
        return big.crop((x, y, x + cw, y + ch)).resize((W, H), Image.BILINEAR)

    def step(self) -> Image.Image:
        dt = self.clock.tick()
        now = time.perf_counter()
        data = self.st.snapshot()
        self.apply_settings(data.get("settings") or {})
        self.sync_pc_hosts(data)
        v = self.current()
        due = now - self.dwell_t >= self.dwell_of(v.id, data)
        # a view that became invisible mid-dwell (pomodoro stopped) leaves early
        gone = not v.visible(data) and len(self.order) > 1
        if (due or gone) and len(self.order) > 1 and self.trans is None:
            # No animated wipe: on this link a 300 KB frame takes 0.8 s, so any
            # transition renders as a visible scan (a vertical bar, then bands).
            # Switch cleanly: the whole new frame goes out in one push and the
            # dwell clock starts only once it is fully on the panel.
            self.advance(data)
            self.enter_view(data, now)
            self.full_push_pending = True
        elif self.bg_img is None and self.bg_cfg(v.id).get("mode") == "photo":
            self.refresh_background(v)  # a photo became ready after we entered
        frame = self.render(now, dt, data)
        if self.trans is not None:
            old, t0, kind = self.trans
            tm = max(1, self.settings["transitionMs"]) / 1000
            p = (now - t0) / tm
            if p >= 1.0:
                self.trans = None
            else:
                frame = transition(old, frame, p, kind)
        # phone notifications ride on top of everything
        # only an explicit "off" means nobody is here; unavailable/unknown sensor = assume present
        present = ((data.get("home") or {}).get("presence") or {}).get("state") != "off"
        self.overlay.offer(data.get("notification"), present)
        self.overlay.offer_copilot(data.get("copilot"))
        # meal-saved card: same path as copilot (not gated by presence/allow-list)
        if data.get("nutritionEvent"):
            self.overlay.offer_copilot(data.get("nutritionEvent"))
        self.overlay.step(now, dt)
        if self.overlay.active:
            self.dwell_t += dt  # pause the rotation while a card is up
            drew = self.overlay.draw(frame, now)
            if DEBUG and drew and not getattr(self, "_ov_logged", False):
                self._ov_logged = True
                log(f"overlay: showing {self.overlay.cur.get('pkg')} / {self.overlay.cur.get('title')}")
        elif getattr(self, "_ov_logged", False):
            self._ov_logged = False
        want = self.settings["nightBrightness"] if night(self.settings) else self.settings["brightness"]
        if self.lcd and want != self.bright:
            self.lcd.set_brightness(int(want))
            self.bright = want
        return frame

    def push(self, frame: Image.Image) -> int:
        """Send what changed, capped at what the link moves in one frame period.
        Rects that do not fit are sliced into row bands and finished on later
        frames; `self.prev` tracks what is actually on the panel, so nothing is lost."""
        if not self.lcd:
            return 0
        t0 = time.perf_counter()
        budget = int(LINK_BPS / max(5, min(30, self.settings["fps"])))
        rects = dirty_rects(self.prev, frame)
        # Fewer commands per frame: merge rects whose union is barely bigger
        # than their sum. The panel occasionally drops a command header when
        # they come densely; every merged pair is one fewer chance to desync.
        rects = merge_rects(rects)
        # View switch: one full frame, whole, ignoring the per-frame budget.
        # Doing it in one go (~0.8 s) reads as a clean cut; slicing it over 17
        # frames read as a scan. The 60 s periodic re-init was removed: it
        # cleared the panel mid-view and ate the dwell. Recovery now happens
        # only when a write actually times out (see below).
        if getattr(self, "full_push_pending", False):
            self.full_push_pending = False
            self.prev = None
            rects = [(0, 0, W, H)]
            budget = W * H * 2
            self.dwell_t = time.perf_counter() + 0.85  # dwell starts after the frame lands
            # One fast vertical sweep (~0.8 s) is the accepted look. Dimming the
            # backlight during it was tried and rejected as more distracting.
        total = sum((x1 - x0) * (y1 - y0) * 2 for x0, y0, x1, y1 in rects)
        rects.sort(key=lambda r: (r[2] - r[0]) * (r[3] - r[1]), reverse=total <= budget)
        # a notification card must land whole and first, whatever else is dirty
        ov = self.overlay.rect if self.overlay.active else None
        if ov:
            def hits(r):
                return not (r[2] <= ov[0] or r[0] >= ov[2] or r[3] <= ov[1] or r[1] >= ov[3])
            rects.sort(key=lambda r: 0 if hits(r) else 1)
        if self.prev is None:
            self.prev = Image.new("RGB", frame.size, (1, 2, 3))
        shown = self.prev.copy()
        sent = 0
        for (x0, y0, x1, y1) in rects:
            size = (x1 - x0) * (y1 - y0) * 2
            if sent + size > budget:
                rows = (budget - sent) // ((x1 - x0) * 2)
                if rows < 4:
                    break
                y1 = y0 + rows
            region = frame.crop((x0, y0, x1, y1))
            try:
                sent += self.lcd.blit(region, x0, y0)
            except serial.SerialTimeoutException:
                # Panel stopped ACKing: resync its parser and mark everything
                # dirty so the next frames repaint it. Counted so a panel that
                # never comes back still escalates to a full reconnect.
                self.stalls += 1
                log(f"panel stall #{self.stalls}: resync")
                self.lcd.resync()
                self.prev = None
                self.last_full = time.perf_counter()
                self.full_push_pending = True  # repaint whole, and give the view its dwell back
                if self.stalls >= 5:
                    raise
                return sent
            shown.paste(region, (x0, y0))
            if sent >= budget:
                break
            self.prev = shown
        self.stalls = 0
        if DEBUG and rects:
            log(f"t={t0:.3f} push {len(rects)} rects {sent/1024:.1f} KB in {(time.perf_counter()-t0)*1000:.0f} ms")
        return sent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="render each view to PNG, no hardware")
    ap.add_argument("--skin", help="with --once: force this skin for every view")
    ap.add_argument("--all-skins", action="store_true", help="with --once: one PNG per view per skin")
    ap.add_argument("--port")
    ap.add_argument("--demo-notify", action="store_true", help="pop a fake WhatsApp card 5 s after start (hardware test)")
    ap.add_argument("--audit", action="store_true", help="with --once: flag off-screen/overlapping text, write *-audit.png, exit 1 if any")
    ap.add_argument("--publish", action="store_true", help="PC agent: no panel, just push host metrics to vmui for a renderer elsewhere")
    ap.add_argument("--vmui", help="vmui base URL (default $VMUI_URL or http://127.0.0.1:3737)")
    args = ap.parse_args()

    if args.vmui:
        global VMUI
        VMUI = args.vmui.rstrip("/")
    if args.publish:
        publish_pc(token())
        return 0

    st = State()
    stop = threading.Event()
    bgs = Backgrounds(ROOT / ".copilot-tmp" / "turzx" / "bg")
    threading.Thread(target=poller, args=(st, token(), stop, bgs), daemon=True).start()
    time.sleep(1.5)

    if args.once:
        out = ROOT / ".copilot-tmp" / "turzx"
        out.mkdir(parents=True, exist_ok=True)
        r = Renderer(st, None, bgs)
        r.apply_settings((st.snapshot().get("settings") or {}))
        skins = ["minimal", "glass", "neon", "editorial", "terminal", "paper"] if args.all_skins else [args.skin] if args.skin else [None]
        problems = 0
        time.sleep(6)  # let a couple of backgrounds download
        for vid in VIEWS:
            for sk in skins:
                v = r.views[vid]
                if sk:
                    v.configure(sk, r.accent, r.cfg.get(vid, {}).get("options") or {})
                r.idx = r.order.index(vid) if vid in r.order else 0
                r.order = list(dict.fromkeys([*r.order, vid]))
                r.idx = r.order.index(vid)
                data = st.snapshot()
                data["pomodoro"] = data.get("pomodoro") if (data.get("pomodoro") or {}).get("phase", "idle") != "idle" else {"phase": "work", "startedAt": time.time() * 1000 - 300000, "endsAt": time.time() * 1000 + 1200000, "round": 2}
                r.enter_view(data, time.perf_counter())
                if r.bg_img is None and r.bg_cfg(vid).get("mode") == "photo":
                    r.refresh_background(v, force_new=True)
                for _ in range(30):
                    v.update(data, 0.1)
                r.dwell_t = time.perf_counter() - r.dwell_of(vid) * 0.35
                col = audit.begin() if args.audit else None
                c = r.render(time.perf_counter(), 0.1, data)
                audit.end()
                name = f"{vid}{'-' + sk if sk else ''}.png"
                c.save(out / name)
                print("wrote", out / name)
                if col is not None:
                    fs = audit.report(col)
                    if fs:
                        problems += len(fs)
                        audit.overlay(c, fs, col).save(out / name.replace(".png", "-audit.png"))
                        for f in fs:
                            print(f"  !! {vid}/{sk or 'default'}: {f}")
        if args.audit:
            print(f"audit: {problems} problem(s)")
            return 1 if problems else 0
        return 0

    while True:
        try:
            lcd = TurzxLcd(args.port, landscape=True, flip=bool((st.snapshot().get("settings") or {}).get("flip")))
            lcd.init(60)
            log(f"connected {lcd.ser.port} (rev A protocol)")
            r = Renderer(st, lcd, bgs)
            r.enter_view(st.snapshot(), time.perf_counter())
            if args.demo_notify:
                r.overlay.primed = True
                r.overlay.presence_only = False
                r.overlay.packages = set()
                threading.Timer(5.0, lambda: r.overlay.queue.append({"id": "demo", "pkg": "com.whatsapp", "app": "whatsapp", "title": "Mama", "text": "Ai mâncat ceva azi? Sună-mă când poți, vreau să te întreb ceva despre weekend."})).start()
            frames = 0
            t_stat = time.perf_counter()
            px = 0
            next_t = time.perf_counter()
            t_mirror = 0.0
            while True:
                t = time.perf_counter()
                frame = r.step()
                px += r.push(frame)
                frames += 1
                # Mirror: what the panel actually shows (r.prev, not the
                # composed frame), for /home and for layout debugging.
                if t - t_mirror >= 1.0 and r.prev is not None:
                    t_mirror = t
                    try:
                        r.prev.save(MIRROR_TMP, format="PNG", compress_level=1)
                        MIRROR_TMP.replace(MIRROR)
                    except OSError:
                        pass
                if t - t_stat >= 60:
                    log(f"{frames/60:.1f} fps, {px/60/1024:.0f} KB/s, view={r.current().id} skin={r.current().sk.id}")
                    frames, px, t_stat = 0, 0, t
                budget = 1.0 / max(5, min(30, r.settings["fps"]))
                next_t += budget
                now = time.perf_counter()
                if now > next_t + budget:
                    next_t = now
                rem = next_t - now
                if rem > 0.003:
                    time.sleep(rem - 0.002)
                while time.perf_counter() < next_t:
                    pass
        except KeyboardInterrupt:
            return 0
        except Exception as e:
            tb = traceback.extract_tb(e.__traceback__)[-1]
            log(f"lcd: {e.__class__.__name__}: {e} @ {Path(tb.filename).name}:{tb.lineno}; reconnecting in 5 s")
            try:
                lcd.close()  # type: ignore[possibly-undefined]
            except Exception:
                pass
            time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
