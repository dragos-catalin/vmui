"""Turzx views — base class, shared painters and the eight core views.
Extra views live in views_extra.py; both register into VIEWS.

Contract: `update(state, dt)` moves tweens, `draw(canvas, t, progress)` paints
onto a canvas the renderer already prepared (skin base + optional photo).
Every colour/font comes from `self.sk` (skins.Skin). Long strings go through
`self.box(...)` (a Marquee) so they scroll inside their slot instead of
overlapping the neighbour."""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from anim import Marquee, MorphText, Pulse, Tween, ease_out_back, ease_out_cubic, lerp_rgb, qsin
from skins import RGB, Skin, build as build_skin

W, H = 480, 320
TZ = ZoneInfo("Europe/Bucharest")
BG = (14, 15, 22)  # renderer fallback before a skin exists

DAYS = ["Luni", "Marți", "Miercuri", "Joi", "Vineri", "Sâmbătă", "Duminică"]
DAYS_SHORT = ["Lu", "Ma", "Mi", "Jo", "Vi", "Sâ", "Du"]
MONTHS = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"]


def hex_rgb(h: str) -> RGB:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def num(x, default=None):
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def celsius(v, unit=None):
    n = num(v)
    if n is None:
        return None
    return (n - 32) / 1.8 if unit == "°F" else n


def since(ent) -> str:
    """'de 3 h' / 'de 12 min' / 'de 2 z' from a state's `since` (HA last_changed)."""
    raw = (ent or {}).get("since")
    if not isinstance(raw, str):
        return ""
    try:
        secs = (datetime.now(timezone.utc) - datetime.fromisoformat(raw.replace("Z", "+00:00"))).total_seconds()
    except ValueError:
        return ""
    if secs < 90:
        return "acum"
    if secs < 3600:
        return f"de {int(secs // 60)} min"
    if secs < 86400:
        return f"de {int(secs // 3600)} h"
    return f"de {int(secs // 86400)} z"


def fit_text(d: ImageDraw.ImageDraw, s: str, f: ImageFont.FreeTypeFont, max_w: int) -> str:
    if d.textlength(s, font=f) <= max_w:
        return s
    while s and d.textlength(s + "…", font=f) > max_w:
        s = s[:-1]
    return s + "…"


# ---------------------------------------------------------------- shared painters
def gauge_arc(d: ImageDraw.ImageDraw, cx: int, cy: int, r: int, value01: float, color, track, width=12) -> None:
    box = (cx - r, cy - r, cx + r, cy + r)
    d.arc(box, 135, 405, fill=track, width=width)
    if value01 > 0:
        d.arc(box, 135, 135 + int(270 * max(0.0, min(1.0, value01))), fill=color, width=width)


def bar(d: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, value01: float, color, track) -> None:
    d.rounded_rectangle((x, y, x + w, y + h), radius=h // 2, fill=track)
    fw = int(w * max(0.0, min(1.0, value01)))
    if fw > h:
        d.rounded_rectangle((x, y, x + fw, y + h), radius=h // 2, fill=color)


def sparkline(d: ImageDraw.ImageDraw, box: tuple[int, int, int, int], values: list[float], color, width=2, fill_to=None) -> None:
    x0, y0, x1, y1 = box
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1.0
    pts = [(x0 + i * (x1 - x0) / (len(vals) - 1), y1 - (v - lo) / span * (y1 - y0)) for i, v in enumerate(vals)]
    if fill_to is not None:
        d.polygon([(x0, y1), *pts, (x1, y1)], fill=fill_to)
    d.line(pts, fill=color, width=width, joint="curve")


_GLOW_CACHE: dict[tuple, Image.Image] = {}


def glow(canvas: Image.Image, cx: int, cy: int, r: int, color, alpha: int = 90) -> None:
    """Soft radial glow; quantised inputs + cached sprite so a steady glow is free."""
    r = max(8, int(r) // 4 * 4)
    alpha = int(alpha) // 8 * 8
    color = tuple(int(c) // 8 * 8 for c in tuple(color)[:3])
    key = (r, color, alpha)
    sprite = _GLOW_CACHE.get(key)
    if sprite is None:
        pad = r * 2
        sprite = Image.new("RGBA", (pad * 2, pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(sprite).ellipse((pad - r, pad - r, pad + r, pad + r), fill=(*color, alpha))
        sprite = sprite.filter(ImageFilter.GaussianBlur(r // 2))
        if len(_GLOW_CACHE) > 64:
            _GLOW_CACHE.clear()
        _GLOW_CACHE[key] = sprite
    pad = sprite.width // 2
    canvas.paste(sprite, (cx - pad, cy - pad), sprite)


def morph_text(d: ImageDraw.ImageDraw, x: int, y: int, mt: MorphText, f: ImageFont.FreeTypeFont, fill, bg, advance: int) -> None:
    """Each slot: old glyph slides up & fades, new glyph slides in from below."""
    for i, s in enumerate(mt.slots):
        sx = x + i * advance
        if s.t >= 1.0:
            d.text((sx, y), s.char, font=f, fill=fill)
            continue
        e = ease_out_cubic(s.t)
        rise = int(28 * e)
        d.text((sx, y - rise), s.prev, font=f, fill=lerp_rgb(fill, bg, e))
        d.text((sx, y + 28 - rise), s.char, font=f, fill=lerp_rgb(bg, fill, e))


# ---------------------------------------------------------------- base
class View:
    id = "view"
    title = ""
    transition = "wipe"
    wants_photo = True  # False: view is unreadable over a photo (dense numbers)

    def __init__(self, accent: RGB) -> None:
        self.accent = accent
        self.sk: Skin = build_skin("minimal", accent)
        self.options: dict = {}
        self.t0 = time.perf_counter()
        self.dt = 0.0
        self._boxes: dict[str, Marquee] = {}

    # renderer hooks
    def configure(self, skin_id: str, accent: RGB, options: dict) -> None:
        self.accent = accent
        self.sk = build_skin(skin_id, accent)
        self.options = options or {}

    def enter(self) -> None:
        self.t0 = time.perf_counter()
        for m in self._boxes.values():
            m.t = 0.0

    def visible(self, st: dict) -> bool:
        """False = skip this view in the rotation right now (e.g. media idle)."""
        return True

    def dwell_scale(self, st: dict) -> float:
        """Multiplier on the configured dwell. Views with little to say return
        <1 so the rotation spends its time where the content is."""
        return 1.0

    def update(self, st: dict, dt: float) -> None: ...

    def draw(self, c: Image.Image, t: float, progress: float) -> None: ...

    # helpers
    def box(self, key: str, text: str, speed: float = 36.0) -> Marquee:
        m = self._boxes.get(key)
        if m is None:
            m = self._boxes[key] = Marquee(speed=speed)
        m.set(text)
        m.step(self.dt)
        return m

    def tick(self, dt: float) -> None:
        self.dt = dt

    def header(self, c: Image.Image, title: str, right: str, progress: float) -> None:
        self.sk.header(c, title, right, progress)

    # background colour under text: panel colour if we are on a panel, else skin bg.
    def bgc(self) -> RGB:
        return self.sk.bg


# ---------------------------------------------------------------- 1. clock
class ClockView(View):
    id, title = "clock", "Ceas"

    def __init__(self, accent):
        super().__init__(accent)
        self.hhmm = MorphText(5)
        self.sec = MorphText(2)
        self.temp_in = Tween(speed=2.5); self.temp_out = Tween(speed=2.5); self.hum = Tween(speed=2.5)
        self.now = datetime.now(TZ)
        self.next_ev = ""
        self.sun_rise = None; self.sun_set = None; self.moon: dict = {}

    def _moon_glyph(self, d, cx, cy, r, phase, sk):
        """Lit disc, dark half + terminator ellipse. phase 0 new → 0.5 full → 1 new;
        waxing lights the right side (northern hemisphere)."""
        lit = lerp_rgb(sk.fg, sk.bg, 0.15)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=lit)
        k = math.cos(phase * 2 * math.pi)  # 1 new, 0 quarter, -1 full
        waxing = phase < 0.5
        # dark half on the unlit side
        d.chord((cx - r, cy - r, cx + r, cy + r), 90 if waxing else 270, 270 if waxing else 450, fill=sk.bg)
        # terminator: an ellipse of half-width r*|k|, dark when crescent, lit when gibbous
        w = max(1, int(r * abs(k)))
        d.ellipse((cx - w, cy - r, cx + w, cy + r), fill=sk.bg if k > 0 else lit)

    def update(self, st, dt):
        self.tick(dt)
        self.now = datetime.now(TZ)
        self.moon = st.get("moon") or {}
        sa = (st.get("sun") or {}).get("attributes") or {}
        for key, attr in (("sun_rise", "next_rising"), ("sun_set", "next_setting")):
            v = sa.get(attr)
            try:
                setattr(self, key, datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(TZ) if isinstance(v, str) else None)
            except ValueError:
                setattr(self, key, None)
        self.hhmm.set(self.now.strftime("%H:%M")); self.sec.set(self.now.strftime("%S"))
        self.hhmm.step(dt); self.sec.step(dt)
        i = st.get("inside") or {}
        ti = celsius((i.get("temp") or {}).get("state"), ((i.get("temp") or {}).get("attributes") or {}).get("unit_of_measurement"))
        hu = num((i.get("hum") or {}).get("state"))
        w = st.get("weather") or {}
        to = celsius((w.get("attributes") or {}).get("temperature"), (w.get("attributes") or {}).get("temperature_unit"))
        if ti is not None: self.temp_in.set(ti)
        if hu is not None: self.hum.set(hu)
        if to is not None: self.temp_out.set(to)
        for tw in (self.temp_in, self.temp_out, self.hum): tw.step(dt)
        # the next thing on the calendar, if any — the clock is where you look for it
        cal = st.get("calendar") or []
        nxt = cal[0] if cal else None
        self.next_ev = ""
        if nxt and nxt.get("start"):
            left = (nxt["start"] / 1000 - time.time())
            if 0 <= left < 12 * 3600:
                hh, mm = int(left // 3600), int(left % 3600 // 60)
                when = f"în {hh} h {mm:02d}" if hh else f"în {mm} min"
                self.next_ev = f"{when} · {nxt.get('summary') or ''}"

    def draw(self, c, t, progress):
        sk = self.sk
        d = ImageDraw.Draw(c)
        n = self.now
        show_sec = self.options.get("seconds", True)
        if sk.id == "editorial":
            # one dominant number, date as a caption, temps as a footer line
            sk.text(d, (22, 16), sk.label(DAYS[n.weekday()]), sk.small, sk.muted)
            morph_text(d, 18, 60, self.hhmm, sk.huge, sk.fg, self.bgc(), advance=92)
            sk.text(d, (22, 214), f"{n.day} {MONTHS[n.month-1]} {n.year}", sk.mid, sk.accent)
            sk.text(d, (22, 262), f"{self.temp_in.value:.1f}°C · {self.hum.value:.0f}% înăuntru      {self.temp_out.value:.0f}°C afară", sk.small, sk.muted)
            d.rounded_rectangle((22, 52, 22 + int(120 * progress), 55), radius=2, fill=sk.accent)
            return
        if sk.id == "glass":
            sk.panel(c, (16, 70, 464, 232))
        sk.text(d, (22, 18), DAYS[n.weekday()], sk.mid, sk.fg)
        sk.text(d, (22, 52), f"{n.day} {MONTHS[n.month-1]} {n.year}", sk.small, sk.muted)
        if self.next_ev:
            self.box("nextev", self.next_ev, speed=30).draw(c, (200, 50, W - 22, 70), sk.tiny, sk.accent, self.bgc(), anchor_left=False)
        # slot width from the widest digit so glyphs never collide, then fit 5 slots + seconds in 436 px
        adv = int(max(d.textlength(ch, font=sk.huge) for ch in "0123456789")) + 2
        adv = min(adv, (W - 44 - 64) // 5)
        tbg = self.bgc() if sk.panel_alpha == 0 else lerp_rgb(sk.bg, sk.card, 0.15)
        morph_text(d, 22, 84, self.hhmm, sk.huge, sk.fg, tbg, advance=adv)
        if show_sec:
            sub = n.microsecond / 1e6
            secfill = lerp_rgb(sk.accent, sk.muted, round((0.5 + 0.5 * math.cos(2 * math.pi * sub)) * 4) / 4)
            morph_text(d, 22 + 5 * adv + 4, 150, self.sec, sk.big, secfill, tbg, advance=28)
        y = 262
        sk.text(d, (22, y), sk.label("înăuntru"), sk.tiny, sk.muted)
        sk.text(d, (22, y + 18), f"{self.temp_in.value:.1f}°C  {self.hum.value:.0f}%", sk.mid, sk.fg)
        sk.text(d, (W - 22, y), sk.label("afară"), sk.tiny, sk.muted, anchor="ra")
        sk.text(d, (W - 22, y + 18), f"{self.temp_out.value:.0f}°C", sk.mid, sk.fg, anchor="ra")
        frac = (n.hour * 3600 + n.minute * 60 + n.second) / 86400
        bar(d, 22, H - 8, W - 44, 4, frac, sk.accent, sk.track)
        # sunrise / sunset ticks on the day bar, so the bar says where daylight is
        for iso, col in ((self.sun_rise, (250, 204, 21)), (self.sun_set, (251, 146, 60))):
            if iso:
                sf = (iso.hour * 3600 + iso.minute * 60) / 86400
                x = 22 + int((W - 44) * sf)
                d.rectangle((x - 1, H - 12, x + 1, H - 3), fill=col)
        if self.moon and (n.hour >= 21 or n.hour < 5):
            self._moon_glyph(d, W - 22 - 12, 30, 9, float(self.moon.get("phase") or 0), sk)
        # dwell progress replaces the old breathing underline
        d.rounded_rectangle((22, 44, 22 + int(120 * progress), 46), radius=1, fill=sk.accent)


# ---------------------------------------------------------------- 2. weather
class WeatherView(View):
    id, title = "weather", "Vremea"
    RO = {"clear-night": "senin", "sunny": "soare", "cloudy": "înnorat", "partlycloudy": "parțial noros", "fog": "ceață", "hail": "grindină",
          "lightning": "furtună", "lightning-rainy": "furtună cu ploaie", "pouring": "ploaie torențială", "rainy": "ploaie", "snowy": "ninsoare",
          "snowy-rainy": "lapoviță", "windy": "vânt", "windy-variant": "vânt", "exceptional": "extrem"}

    def __init__(self, accent):
        super().__init__(accent)
        self.temp = Tween(speed=2.0); self.hum = Tween(speed=2.0); self.wind = Tween(speed=2.0); self.pres = Tween(speed=2.0)
        self.cond = "unknown"; self.sun = None; self.forecast: list[dict] = []
        self.hourly: list[dict] = []; self.moon: dict = {}; self.dew: float | None = None; self.uv: float | None = None

    def update(self, st, dt):
        self.tick(dt)
        w = st.get("weather") or {}
        a = w.get("attributes") or {}
        self.cond = w.get("state") or "unknown"
        self.dew = celsius(a.get("dew_point"), a.get("temperature_unit"))
        self.uv = num(a.get("uv_index"))
        self.moon = st.get("moon") or {}
        now_ms = time.time() * 1000
        self.hourly = [h for h in (st.get("hourly") or []) if (h.get("t") or 0) > now_ms - 1800_000][:6]
        t = celsius(a.get("temperature"), a.get("temperature_unit"))
        if t is not None: self.temp.set(t)
        if (h := num(a.get("humidity"))) is not None: self.hum.set(h)
        if (ws := num(a.get("wind_speed"))) is not None:
            u = a.get("wind_speed_unit")
            self.wind.set(ws * 1.609 if u == "mph" else ws * 3.6 if u == "m/s" else ws)
        if (p := num(a.get("pressure"))) is not None:
            self.pres.set(p * 33.8639 if a.get("pressure_unit") == "inHg" else p)
        self.sun = st.get("sun")
        fc = st.get("forecast") or []
        # skip today when the list starts with it — the big number already says today
        today = datetime.now(TZ).date()
        self.forecast = [f for f in fc if datetime.fromtimestamp((f.get("t") or 0) / 1000, TZ).date() != today][:4]
        for tw in (self.temp, self.hum, self.wind, self.pres): tw.step(dt)

    def _icon(self, c, cx, cy, t):
        d = ImageDraw.Draw(c)
        cond = self.cond
        sunny = cond in ("sunny", "clear-night", "partlycloudy")
        rainy = cond in ("rainy", "pouring", "lightning-rainy", "snowy-rainy")
        cloudy = cond in ("cloudy", "partlycloudy", "fog", "rainy", "pouring", "lightning", "lightning-rainy", "snowy", "snowy-rainy")
        if sunny:
            r = 30 + 3 * Pulse(3.0, steps=3).at(t)
            col = (250, 204, 21) if cond != "clear-night" else (203, 213, 225)
            if self.sk.glow or self.sk.id in ("minimal", "glass"):
                glow(c, cx - 14, cy - 10, 56, col, 70)
            d = ImageDraw.Draw(c)
            d.ellipse((cx - 14 - r, cy - 10 - r, cx - 14 + r, cy - 10 + r), fill=col)
            if cond != "clear-night":
                for k in range(8):
                    ang = round(t * 0.6 * 16) / 16 + k * math.pi / 4
                    x0, y0 = cx - 14 + math.cos(ang) * (r + 10), cy - 10 + math.sin(ang) * (r + 10)
                    x1, y1 = cx - 14 + math.cos(ang) * (r + 20), cy - 10 + math.sin(ang) * (r + 20)
                    d.line((x0, y0, x1, y1), fill=col, width=4)
        if cloudy:
            drift = qsin(t * 0.8, 6) * 6
            ox = cx + 8 + drift
            col = (226, 232, 240) if cond == "partlycloudy" else (148, 163, 184)
            if self.sk.id == "paper": col = (120, 128, 140)
            for (dx, dy, rr) in ((-22, 14, 20), (0, 2, 28), (24, 14, 20)):
                d.ellipse((ox + dx - rr, cy + dy - rr, ox + dx + rr, cy + dy + rr), fill=col)
            d.rounded_rectangle((ox - 40, cy + 12, ox + 42, cy + 34), radius=10, fill=col)
        if rainy:
            for k in range(7):
                ph = (t * 1.6 + k * 0.37) % 1.0
                x = cx - 26 + k * 12 + (k % 2) * 3
                y = cy + 40 + ph * 40
                d.line((x, y, x - 3, y + 10), fill=(96, 165, 250), width=3)
        if cond in ("snowy", "snowy-rainy"):
            for k in range(8):
                ph = (t * 0.6 + k * 0.29) % 1.0
                x = cx - 30 + k * 10 + qsin(t * 2 + k, 4) * 4
                y = cy + 40 + ph * 40
                d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(241, 245, 249))
        if cond in ("lightning", "lightning-rainy") and (t * 2) % 3 < 0.25:
            d.polygon([(cx + 6, cy + 30), (cx - 8, cy + 62), (cx + 2, cy + 60), (cx - 6, cy + 90), (cx + 14, cy + 52), (cx + 4, cy + 54)], fill=(253, 224, 71))

    def draw(self, c, t, progress):
        sk = self.sk
        self.header(c, "Vremea", "Acasă", progress)
        if sk.panel_alpha:
            sk.panel(c, (220, 70, 464, 300))
        self._icon(c, 110, 140 if self.forecast else 160, t)
        d = ImageDraw.Draw(c)
        if self.forecast:
            # four columns under the icon: weekday, hi/lo, rain chance when known
            cw = 204 // len(self.forecast)
            for i, f in enumerate(self.forecast):
                x = 12 + i * cw + cw // 2
                day = datetime.fromtimestamp((f.get("t") or 0) / 1000, TZ)
                sk.text(d, (x, 232), sk.label(DAYS_SHORT[day.weekday()]), sk.tiny, sk.muted, anchor="ma")
                hi, lo = num(f.get("hi")), num(f.get("lo"))
                # hi on top in fg, lo underneath in muted: two short tokens fit
                # a 51 px column where "26°/12°" in `small` did not
                sk.text(d, (x, 246), f"{hi:.0f}°" if hi is not None else "—", sk.small, sk.fg, anchor="ma")
                if lo is not None:
                    sk.text(d, (x, 246 + sk.small.size + 2), f"{lo:.0f}°", sk.tiny, sk.muted, anchor="ma")
                rain = num(f.get("rain"))
                if rain is not None and rain >= 20:
                    sk.text(d, (x, 246 + sk.small.size + sk.tiny.size + 6), f"{rain:.0f}%", sk.tiny, (56, 189, 248), anchor="ma")
                else:
                    # a coloured dot says sunny/cloudy/rain faster than a clipped word
                    cond = str(f.get("cond") or "")
                    dot = (250, 204, 21) if cond in ("sunny", "clear-night") else (56, 189, 248) if "rain" in cond or cond in ("pouring", "snowy", "snowy-rainy") else sk.muted
                    cy = 246 + sk.small.size + sk.tiny.size + 11
                    d.ellipse((x - 3, cy - 3, x + 3, cy + 3), fill=dot)
        tv = f"{self.temp.value:.0f}"
        sk.text(d, (236, 78), tv, sk.huge, sk.fg)
        sk.text(d, (236 + d.textlength(tv, font=sk.huge) + 6, 96), "°C", sk.mid, sk.muted)
        # Layout from the bottom up: three metric rows anchored to the panel
        # floor, then the condition in whatever space is left under the big
        # number — shrunk if a tall skin font would otherwise collide.
        rows = [("umiditate", f"{self.hum.value:.0f}%"), ("vânt", f"{self.wind.value:.0f} km/h"), ("presiune", f"{self.pres.value:.0f} hPa")]
        rh = max(sk.small.size, sk.tiny.size) + 6
        y0 = 296 - 3 * rh
        # condition goes between the big number's baseline and the rows; if a
        # skin's huge font leaves no room, it moves right of the number instead
        big_bottom = d.textbbox((236, 78), tv, font=sk.huge, anchor="la")[3]
        cond = self.RO.get(self.cond, self.cond)
        if big_bottom + 4 + sk.small.size + 4 <= y0:
            sk.text(d, (236, big_bottom + 4), fit_text(d, cond, sk.small, 464 - 236 - 8), sk.small, sk.accent)
        else:
            x = int(236 + d.textlength(tv, font=sk.huge) + 6)
            sk.text(d, (x, 96 + sk.mid.size + 6), fit_text(d, cond, sk.tiny, 464 - x - 8), sk.tiny, sk.accent)
        for i, (k, v) in enumerate(rows):
            y = y0 + i * rh
            # label + value share a row: right-align the value, and clip the
            # label so a wide-font skin cannot run into it
            vw = d.textlength(v, font=sk.small)
            sk.text(d, (236, y), fit_text(d, sk.label(k), sk.tiny, int(130 - vw - 6)), sk.tiny, sk.muted)
            sk.text(d, (236 + 130, y), v, sk.small, sk.fg, anchor="ra")
        # right column, one line per row: sun time, then UV or dew point, then moon on clear nights
        side: list[tuple[str, RGB]] = []
        if self.sun:
            a = self.sun.get("attributes") or {}
            up = self.sun.get("state") == "above_horizon"
            nxt = a.get("next_setting" if up else "next_rising")
            if isinstance(nxt, str):
                try:
                    hh = datetime.fromisoformat(nxt.replace("Z", "+00:00")).astimezone(TZ).strftime("%H:%M")
                    side.append((("apus " if up else "răsărit ") + hh, sk.muted))
                except ValueError:
                    pass
        if self.uv is not None and self.uv >= 3 and (self.sun or {}).get("state") == "above_horizon":
            side.append((f"UV {self.uv:.0f}", sk.warn if self.uv >= 6 else sk.muted))
        elif self.dew is not None and self.dew >= 16:
            side.append((f"roă {self.dew:.0f}°", sk.muted))
        if self.cond == "clear-night" and self.moon:
            side.append((f"lună {int(self.moon.get('illumination') or 0)}%", sk.muted))
        for i, (s, col) in enumerate(side[:3]):
            sk.text(d, (W - 24, y0 + i * rh), fit_text(d, s, sk.tiny, 84), sk.tiny, col, anchor="ra")
        # next hours as a thin strip under the panel header: temperature + a rain tint
        if self.hourly and sk.panel_alpha == 0:
            hx0, hy = 236, 62
            cw = (464 - hx0) // len(self.hourly)
            for i, h in enumerate(self.hourly):
                x = hx0 + i * cw + cw // 2
                hh = datetime.fromtimestamp((h.get("t") or 0) / 1000, TZ).strftime("%H")
                rain = num(h.get("rain")) or 0
                tv2 = num(h.get("temp"))
                col = (56, 189, 248) if rain >= 40 else sk.muted
                sk.text(d, (x, hy), hh, sk.tiny, col, anchor="ma")
                if tv2 is not None:
                    sk.text(d, (x, hy + sk.tiny.size + 1), f"{tv2:.0f}°", sk.tiny, sk.fg, anchor="ma")


# ---------------------------------------------------------------- 3. home
class HomeView(View):
    id, title = "home", "Acasă"

    def __init__(self, accent):
        super().__init__(accent)
        self.lights = Tween(speed=3); self.total = 1
        self.rows: list[tuple[str, str, str]] = []
        self.ac = []
        self.low_batt: list[dict] = []
        self.door_open_s = 0.0

    def update(self, st, dt):
        self.tick(dt)
        h = st.get("home") or {}
        self.low_batt = [b for b in (st.get("batteries") or []) if float(b.get("pct") or 100) < 25 and not b.get("charging")]
        dr = h.get("door") or {}
        self.door_open_s = 0.0
        if dr.get("state") == "on" and isinstance(dr.get("since"), str):
            try:
                self.door_open_s = time.time() - datetime.fromisoformat(dr["since"].replace("Z", "+00:00")).timestamp()
            except ValueError:
                pass
        self.lights.set(h.get("lightsOn") or 0); self.lights.step(dt)
        self.total = max(1, h.get("lightsTotal") or 1)
        def s(x): return (x or {}).get("state")
        door = s(h.get("door")); person = s(h.get("person"))
        self.rows = [
            ("Ușa", "DESCHISĂ" if door == "on" else "închisă" if door == "off" else "—", "bad" if door == "on" else "ok", since(h.get("door"))),
            ("Dragoș", "acasă" if person == "home" else "plecat" if person == "not_home" else (person or "—"), "ok" if person == "home" else "muted", since(h.get("person"))),
        ]
        self.ac = []
        for label, key in (("AC dormitor", "acBedroom"), ("AC living", "acLiving")):
            cst = h.get(key)
            if not cst: self.ac.append((label, "—", None, None)); continue
            a = cst.get("attributes") or {}
            if cst.get("state") == "off": self.ac.append((label, "oprit", None, None)); continue
            self.ac.append((label, cst["state"], celsius(a.get("temperature"), a.get("temperature_unit")), celsius(a.get("current_temperature"), a.get("temperature_unit"))))

    def draw(self, c, t, progress):
        sk = self.sk
        right = ""
        if self.low_batt:
            b = self.low_batt[0]
            right = f"baterie {b.get('pct'):.0f}% · {b.get('name')}"
        self.header(c, "Acasă", fit_text(ImageDraw.Draw(c), right, sk.tiny, 220), progress)
        d = ImageDraw.Draw(c)
        col_of = {"bad": sk.bad, "ok": sk.ok, "accent": sk.accent, "muted": sk.muted}
        # door left open for a while: a slow red wash on the panel edge, hard to miss
        if self.door_open_s > 120:
            p = Pulse(1.6).at(t)
            d.rectangle((0, 0, W, 3), fill=lerp_rgb(sk.bad, sk.bg, 0.6 * (1 - p)))
            d.rectangle((0, H - 3, W, H), fill=lerp_rgb(sk.bad, sk.bg, 0.6 * (1 - p)))
        if sk.panel_alpha:
            sk.panel(c, (16, 70, 180, 230)); sk.panel(c, (190, 70, 464, 230))
        gauge_arc(d, 92, 150, 52, self.lights.value / self.total, sk.warn if self.lights.value > 0 else sk.muted, sk.track)
        sk.text(d, (92, 142), f"{self.lights.value:.0f}", sk.big, sk.fg, anchor="mm")
        sk.text(d, (92, 176), sk.label(f"din {self.total} lumini"), sk.tiny, sk.muted, anchor="mm")
        y = 78
        for i, (k, v, cn, ago) in enumerate(self.rows):
            col = col_of[cn]
            p = Pulse(2.0, i, steps=6).at(t)
            r = 5 + 2 * p if cn != "muted" else 5
            d.ellipse((208 - r, y + 12 - r, 208 + r, y + 12 + r), fill=col)
            sk.text(d, (224, y), sk.label(k), sk.tiny, sk.muted)
            sk.text(d, (224, y + 16), v, sk.mid if k == "Ușa" else sk.small, sk.fg)
            # "closed" is only reassuring if you know for how long
            if ago:
                sk.text(d, (W - 24, y + 18), fit_text(d, ago, sk.tiny, 110), sk.tiny, sk.muted, anchor="ra")
            y += 50
        for i, (label, mode, target, cur) in enumerate(self.ac):
            x = 200 + i * 140
            sk.panel(c, (x, 238, x + 128, 306))
            d = ImageDraw.Draw(c)
            sk.text(d, (x + 12, 246), sk.label(label), sk.tiny, sk.muted)
            if target is None:
                sk.text(d, (x + 12, 266), mode, sk.small, sk.muted)
            else:
                sk.text(d, (x + 12, 262), f"{target:.0f}°C", sk.mid, (96, 165, 250) if mode == "cool" else (251, 146, 60))
                if cur is not None:
                    # green once the room has reached the setpoint, amber while working
                    reached = (cur <= target + 0.4) if mode == "cool" else (cur >= target - 0.4)
                    sk.text(d, (x + 116, 284), f"acum {cur:.1f}°", sk.tiny, sk.ok if reached else sk.warn, anchor="ra")


# ---------------------------------------------------------------- 4. ambilight
class AmbilightView(View):
    id, title = "ambilight", "Ambilight"
    wants_photo = False

    def __init__(self, accent):
        super().__init__(accent)
        self.col = [Tween(speed=5) for _ in range(3)]
        self.bri = Tween(speed=4); self.mode = "—"; self.wall = (255, 255, 255); self.wall_s = 0.0; self.bar_on = False

    def update(self, st, dt):
        self.tick(dt)
        a = st.get("ambilight") or {}
        strip = a.get("strip") or {}
        rgb = (strip.get("attributes") or {}).get("rgb_color")
        if strip.get("state") == "on" and isinstance(rgb, list) and len(rgb) == 3:
            for tw, v in zip(self.col, rgb): tw.set(v)
            self.bri.set((strip.get("attributes") or {}).get("brightness") or 0)
        else:
            for tw in self.col: tw.set(20)
            self.bri.set(0)
        for tw in self.col: tw.step(dt)
        self.bri.step(dt)
        # `ambilight` is derived server-side from HyperHDR's active component;
        # light.hyperhdr's own state is 'off' during a film (grabber owns it).
        st = a.get("ambilight")
        self.mode = {"movie": "film", "music": "muzica", "idle": "idle", "unreachable": "oprit"}.get(st, "—")
        self.wall = hex_rgb(a.get("wallHex") or "#ffffff"); self.wall_s = a.get("wallStrength") or 0
        self.bar_on = (a.get("bar") or {}).get("state") == "on"

    def draw(self, c, t, progress):
        sk = self.sk
        rgb = tuple(int(tw.value) for tw in self.col)
        if sk.id != "paper":
            glow(c, 150, 150, 120, rgb, int(40 + 60 * (self.bri.value / 255)))
        self.header(c, "Ambilight", self.mode, progress)
        d = ImageDraw.Draw(c)
        d.rounded_rectangle((60, 92, 240, 208), radius=8, fill=(8, 8, 12) if sk.id != "paper" else (30, 30, 34), outline=rgb, width=3)
        d.rounded_rectangle((136, 208, 164, 222), radius=3, fill=sk.track)
        d.rounded_rectangle((104, 222, 196, 228), radius=3, fill=sk.track)
        sk.text(d, (276, 84), sk.label("perete"), sk.tiny, sk.muted)
        d.rounded_rectangle((276, 102, 336, 134), radius=8, fill=self.wall)
        sk.text(d, (346, 104), sk.label("compensare"), sk.tiny, sk.muted)
        sk.text(d, (346, 118), f"{int(self.wall_s*100)}%", sk.small, sk.fg)
        sk.text(d, (276, 150), sk.label("bandă MELK"), sk.tiny, sk.muted)
        d.rounded_rectangle((276, 168, 336, 200), radius=8, fill=rgb)
        sk.text(d, (346, 166), f"{rgb[0]},{rgb[1]},{rgb[2]}", sk.mono, sk.fg)
        sk.text(d, (346, 186), f"{self.bri.value/2.55:.0f}%", sk.small, sk.muted)
        sk.text(d, (276, 216), sk.label("bară birou"), sk.tiny, sk.muted)
        sk.text(d, (276, 234), "aprinsă" if self.bar_on else "stinsă", sk.small, sk.ok if self.bar_on else sk.muted)
        for i in range(24):
            hgt = 6 + 14 * (0.5 + 0.5 * qsin(t * 3 + i * 0.5, 4)) * (round(self.bri.value / 255, 1) + 0.15)
            x = 22 + i * 18
            d.rounded_rectangle((x, 300 - hgt, x + 10, 300), radius=3, fill=lerp_rgb(rgb, sk.bg, 0.25))


# ---------------------------------------------------------------- 5. pc
class PcView(View):
    id, title = "pc", "PC"
    # set by the renderer for per-machine clones (id "pc:<host>"); None = legacy single `pc`
    host: str | None = None

    def __init__(self, accent):
        super().__init__(accent)
        self.cpu = Tween(speed=4); self.ram = Tween(speed=3); self.gpu = Tween(speed=4); self.gtemp = Tween(speed=2); self.vram = Tween(speed=3)
        self.hist: list[float] = [0.0] * 60
        self.acc = 0.0
        self.top = ""; self.up_str = ""; self.disks: list[dict] = []

    def visible(self, st):
        # a machine that stopped publishing (asleep / shut down) leaves the rotation
        return self.host is None or self.host in (st.get("pcs") or {})

    def update(self, st, dt):
        self.tick(dt)
        pc = ((st.get("pcs") or {}).get(self.host) if self.host else st.get("pc")) or {}
        for tw, k in ((self.cpu, "cpu"), (self.ram, "ram"), (self.gpu, "gpu"), (self.gtemp, "gpuTemp"), (self.vram, "vram")):
            if (v := num(pc.get(k))) is not None: tw.set(v)
            tw.step(dt)
        self.acc += dt
        if self.acc >= 0.5:
            self.acc = 0
            self.hist = self.hist[1:] + [self.cpu.value]
        self.top = str(pc.get("top") or "")
        want = [x.upper().rstrip(":") for x in str(self.options.get("disks") or "").split() if x]
        self.disks = [dk for dk in (pc.get("disks") or []) if not want or str(dk.get("drive", "")).upper().rstrip(":") in want][:4]
        up = num(pc.get("uptime")) or 0
        self.up_str = f"{int(up // 86400)} z {int(up % 86400 // 3600)} h" if up >= 86400 else f"{int(up // 3600)} h {int(up % 3600 // 60):02d} m"

    def draw(self, c, t, progress):
        sk = self.sk
        self.header(c, "PC", str(self.options.get("hostname") or self.host or "dragos-pc"), progress)
        d = ImageDraw.Draw(c)
        if sk.panel_alpha:
            sk.panel(c, (16, 70, 464, 232)); d = ImageDraw.Draw(c)
        if sk.id == "editorial":
            # dominant CPU figure, others as a row
            v = self.cpu.value
            sk.text(d, (22, 56), f"{v:.0f}", sk.huge, sk.fg if v < 85 else sk.bad)
            sk.text(d, (22 + d.textlength(f"{v:.0f}", font=sk.huge) + 8, 100), "% CPU", sk.mid, sk.muted)
            for i, (label, tw, suf) in enumerate((("GPU", self.gpu, "%"), ("RAM", self.ram, "%"), ("GPU °C", self.gtemp, "°"), ("VRAM", self.vram, "%"))):
                x = 22 + i * 112
                sk.text(d, (x, 214), sk.label(label), sk.tiny, sk.muted)
                sk.text(d, (x, 230), f"{tw.value:.0f}{suf}", sk.big, sk.fg)
            sparkline(d, (22, 290, W - 22, 312), self.hist, sk.accent)
            return
        cols = (sk.accent, (168, 85, 247), (34, 211, 238)) if sk.id != "terminal" else (sk.accent, sk.accent, sk.accent)
        for i, (label, tw, col, suf) in enumerate((("CPU", self.cpu, cols[0], "%"), ("GPU", self.gpu, cols[1], "%"), ("RAM", self.ram, cols[2], "%"))):
            cx = 90 + i * 150
            v = tw.value
            gauge_arc(d, cx, 150, 54, v / 100, col if v < 85 else sk.bad, sk.track)
            sk.text(d, (cx, 144), f"{v:.0f}", sk.big, sk.fg, anchor="mm")
            sk.text(d, (cx, 176), suf, sk.tiny, sk.muted, anchor="mm")
            sk.text(d, (cx, 214), sk.label(label), sk.small, sk.muted, anchor="mm")
        sparkline(d, (22, 262, W - 22, 300), self.hist, lerp_rgb(sk.accent, sk.bg, 0.2))
        gt = self.gtemp.value
        gcol = sk.muted if gt < 65 else sk.warn if gt < 80 else sk.bad
        sk.text(d, (22, 236), f"GPU {gt:.0f}°C", sk.tiny, gcol)
        sk.text(d, (96, 236), f"· VRAM {self.vram.value:.0f}%", sk.tiny, sk.muted)
        # what is actually eating the CPU — the number alone never answers that
        if self.top:
            sk.text(d, (W - 22, 236), fit_text(d, self.top, sk.tiny, 220), sk.tiny, sk.accent, anchor="ra")
        sk.text(d, (W - 22, 236 + sk.tiny.size + 4), f"pornit de {self.up_str}", sk.tiny, sk.muted, anchor="ra")
        # disks along the bottom edge, under the sparkline: letter + fill bar + free GB
        if self.disks:
            n = len(self.disks)
            cw = (W - 44) // n
            for i, dk in enumerate(self.disks):
                x = 22 + i * cw
                pct = float(dk.get("pct") or 0)
                col = sk.bad if pct > 92 else sk.warn if pct > 80 else lerp_rgb(sk.accent, sk.fg, 0.3)
                lab = str(dk.get("drive") or "")
                lw = int(d.textlength(lab, font=sk.tiny)) + 6
                free = f"{float(dk.get('freeGb') or 0):.0f} GB"
                fw = int(d.textlength(free, font=sk.tiny)) + 6
                sk.text(d, (x, H - 8), lab, sk.tiny, sk.muted, anchor="ld")
                if cw - 8 - lw - fw > 20:
                    bar(d, x + lw, H - 8 - sk.tiny.size // 2 - 2, cw - 8 - lw - fw, 4, pct / 100, col, sk.track)
                sk.text(d, (x + cw - 8, H - 8), free, sk.tiny, sk.muted, anchor="rd")


# ---------------------------------------------------------------- 6. activity
class PiView(View):
    """The Raspberry Pi the renderer runs on: same three-arc language as PC,
    but temperature replaces GPU (there is none) and the bottom row carries
    the things that actually kill a Pi: throttling, under-voltage, disk."""

    id, title = "pi", "Raspberry Pi"

    def __init__(self, accent):
        super().__init__(accent)
        self.cpu = Tween(speed=4); self.temp = Tween(speed=2); self.ram = Tween(speed=3)
        self.hist: list[float] = [0.0] * 60
        self.acc = 0.0
        self.pi: dict = {}

    def update(self, st, dt):
        self.tick(dt)
        self.pi = st.get("pi") or {}
        for tw, k in ((self.cpu, "cpu"), (self.temp, "temp"), (self.ram, "ram")):
            if (v := num(self.pi.get(k))) is not None: tw.set(v)
            tw.step(dt)
        self.acc += dt
        if self.acc >= 0.5:
            self.acc = 0
            self.hist = self.hist[1:] + [self.cpu.value]

    def draw(self, c, t, progress):
        sk = self.sk
        pi = self.pi
        up = num(pi.get("uptime")) or 0
        up_str = f"{int(up // 86400)} z {int(up % 86400 // 3600)} h" if up >= 86400 else f"{int(up // 3600)} h {int(up % 3600 // 60):02d} m"
        self.header(c, "Raspberry Pi", str(self.options.get("hostname") or "homepi"), progress)
        d = ImageDraw.Draw(c)
        if sk.panel_alpha:
            sk.panel(c, (16, 70, 464, 232)); d = ImageDraw.Draw(c)
        tv = self.temp.value
        tcol = sk.accent if tv < 65 else sk.warn if tv < 80 else sk.bad
        if sk.id == "editorial":
            v = self.cpu.value
            sk.text(d, (22, 56), f"{v:.0f}", sk.huge, sk.fg if v < 85 else sk.bad)
            sk.text(d, (22 + d.textlength(f"{v:.0f}", font=sk.huge) + 8, 100), "% CPU", sk.mid, sk.muted)
            dk = pi.get("disk") or {}
            mhz = int(num(pi.get("mhz")) or 0)
            cv = num(pi.get("coreV"))
            for i, (label, val) in enumerate((("TEMP", f"{tv:.0f}°"), ("RAM", f"{self.ram.value:.0f}%"), ("GHZ", f"{mhz / 1000:.1f}"), ("CORE", f"{cv:.2f}V" if cv else "—"), ("DISC", f"{float(dk.get('pct') or 0):.0f}%"))):
                x = 22 + i * 90
                sk.text(d, (x, 214), sk.label(label), sk.tiny, sk.muted)
                sk.text(d, (x, 230), fit_text(d, val, sk.big, 82), sk.big, sk.fg)
            sparkline(d, (22, 290, W - 22, 312), self.hist, sk.accent)
            return
        cols = (sk.accent, tcol, (34, 211, 238)) if sk.id != "terminal" else (sk.accent, sk.accent, sk.accent)
        for i, (label, val, frac, col, suf) in enumerate((("CPU", self.cpu.value, self.cpu.value / 100, cols[0], "%"), ("TEMP", tv, min(tv / 90, 1.0), cols[1], "°C"), ("RAM", self.ram.value, self.ram.value / 100, cols[2], "%"))):
            cx = 90 + i * 150
            gauge_arc(d, cx, 150, 54, frac, col if (label != "CPU" or val < 85) else sk.bad, sk.track)
            sk.text(d, (cx, 144), f"{val:.0f}", sk.big, sk.fg, anchor="mm")
            sk.text(d, (cx, 176), suf, sk.tiny, sk.muted, anchor="mm")
            sk.text(d, (cx, 214), sk.label(label), sk.small, sk.muted, anchor="mm")
        sparkline(d, (22, 262, W - 22, 300), self.hist, lerp_rgb(sk.accent, sk.bg, 0.2))
        mhz = int(num(pi.get("mhz")) or 0)
        load = num(pi.get("load"))
        th = pi.get("throttled") or {}
        # the firmware parks the ARM at 600 MHz while the rail is low — show the
        # clock in the warning colour then, so a "slow panel" reads as power
        left = f"{mhz} MHz" if mhz else ""
        if load is not None:
            left += f"{' · ' if left else ''}load {load:.2f}"
        cv = num(pi.get("coreV"))
        if cv:
            left += f"{' · ' if left else ''}core {cv:.2f} V"
        dips = int(num(pi.get("dips")) or 0)
        if dips:
            left += f" · {dips} căderi"
        sk.text(d, (22, 236), fit_text(d, left, sk.tiny, W - 44 - 130), sk.tiny, sk.warn if (mhz and mhz <= 600 and th.get("undervolt")) else sk.muted)
        flag = "SUB-TENSIUNE" if th.get("undervolt") else "THROTTLED" if th.get("throttled") or th.get("capped") else "LIMITĂ TEMP" if th.get("softTemp") else ""
        if flag:
            sk.text(d, (W - 22, 236), flag, sk.tiny, sk.bad, anchor="ra")
        elif th.get("ever"):
            sk.text(d, (W - 22, 236), "a fost throttled", sk.tiny, sk.warn, anchor="ra")
        else:
            n = pi.get("containers")
            sk.text(d, (W - 22, 236), f"{n} containere" if n is not None else "", sk.tiny, sk.muted, anchor="ra")
        sk.text(d, (W - 22, 236 + sk.tiny.size + 4), f"pornit de {up_str}", sk.tiny, sk.muted, anchor="ra")
        # bottom row: root disk bar + network rate, same geometry as the PC disks
        # bottom row is split by measured text, not by a fixed half: the wide
        # terminal/paper fonts pushed the net rate into the disk label.
        rx, tx = num(pi.get("rxKbps")) or 0.0, num(pi.get("txKbps")) or 0.0
        fmt = lambda k: f"{k / 1000:.1f} Mb/s" if k >= 1000 else f"{k:.0f} kb/s"
        net = f"↓ {fmt(rx)}  ↑ {fmt(tx)}"
        net_w = int(d.textlength(net, font=sk.tiny))
        sk.text(d, (W - 22, H - 8), net, sk.tiny, sk.muted, anchor="rd")
        dk = pi.get("disk") or {}
        if dk:
            pct = float(dk.get("pct") or 0)
            col = sk.bad if pct > 92 else sk.warn if pct > 80 else lerp_rgb(sk.accent, sk.fg, 0.3)
            free = f"{float(dk.get('freeGb') or 0):.0f} GB liber"
            right = W - 22 - net_w - 18
            lw = int(d.textlength("disc", font=sk.tiny)) + 6
            fw = int(d.textlength(free, font=sk.tiny)) + 6
            sk.text(d, (22, H - 8), "disc", sk.tiny, sk.muted, anchor="ld")
            bw = right - 22 - lw - fw
            if bw > 24:
                bar(d, 22 + lw, H - 8 - sk.tiny.size // 2 - 2, bw, 4, pct / 100, col, sk.track)
                sk.text(d, (right, H - 8), free, sk.tiny, sk.muted, anchor="rd")
            else:
                sk.text(d, (22 + lw, H - 8), f"{pct:.0f}%", sk.tiny, sk.muted, anchor="ld")


class ActivityView(View):
    id, title = "activity", "Activitate"

    def __init__(self, accent):
        super().__init__(accent)
        self.items: list[dict] = []
        self.seen: dict[str, float] = {}

    def update(self, st, dt):
        self.tick(dt)
        n = int(self.options.get("max") or 6)
        self.items = (st.get("activity") or [])[:n]
        # first-seen stamp drives the slide-in; a row that is never stamped
        # keeps age 0 → alpha 0 → text in the background colour (invisible).
        now = time.perf_counter()
        for it in self.items:
            self.seen.setdefault(f"{it.get('at')}|{it.get('text')}", now)
        if len(self.seen) > 200:
            keep = {f"{it.get('at')}|{it.get('text')}" for it in self.items}
            self.seen = {k: v for k, v in self.seen.items() if k in keep}

    def dwell_scale(self, st):
        n = len(st.get("activity") or [])
        return 0.5 if n == 0 else 0.75 if n <= 2 else 1.0

    def draw(self, c, t, progress):
        sk = self.sk
        self.header(c, "Activitate", f"{len(self.items)} evenimente", progress)
        d = ImageDraw.Draw(c)
        y = 74
        now = time.perf_counter()
        for it in self.items:
            key = f"{it.get('at')}|{it.get('text')}"
            age = now - self.seen.get(key, now)
            if age >= 0.6:
                e, alpha = 1.0, 1.0
            else:
                e = ease_out_back(age / 0.6); alpha = min(1.0, age / 0.4)
            x = int(22 + (1 - e) * 60)
            hh = datetime.fromtimestamp((it.get("at") or 0) / 1000, TZ).strftime("%H:%M")
            kind = it.get("kind") or ""
            col = {"assist": (168, 85, 247), "door": sk.warn, "light": (250, 204, 21)}.get(kind, sk.accent)
            if sk.panel_alpha:
                sk.panel(c, (x - 6, y - 6, W - 16, y + 34), radius=8); d = ImageDraw.Draw(c)
            d.rounded_rectangle((x, y, x + 6, y + 34), radius=3, fill=lerp_rgb(sk.bg, col, alpha))
            # time in a fixed-width column on the left, message to its right —
            # stacking them vertically overlapped by 5 px on every skin
            sk.text(d, (x + 16, y + 10), hh, sk.tiny, lerp_rgb(sk.bg, sk.muted, alpha))
            self.box(key, str(it.get("text") or "")).draw(c, (x + 60, y + 4, W - 30, y + 30), sk.small, lerp_rgb(sk.bg, sk.fg, alpha), self.bgc() if not sk.panel_alpha else lerp_rgb(sk.bg, sk.card, 0.15))
            y += 40
        if not self.items:
            sk.text(d, (W // 2, 180), "nimic recent", sk.mid, sk.muted, anchor="mm")


# ---------------------------------------------------------------- 7. media
class MediaView(View):
    id, title = "media", "Redare"

    def __init__(self, accent):
        super().__init__(accent)
        self.m = None; self.others: list[dict] = []; self.pos = Tween(speed=8); self.art = None
        self.lyrics: list[dict] = []; self.lyric_idx = -1; self.lyric_at = 0.0

    def visible(self, st):
        if not self.options.get("skipIdle"):
            return True
        return any(x.get("state") == "playing" for x in (st.get("media") or []))

    @staticmethod
    def _rank(x: dict) -> tuple:
        # playing beats paused; a real title beats a bare "playing" (TVs on an input)
        return (x.get("state") != "playing", not (x.get("title") or x.get("artist")), str(x.get("id")))

    def update(self, st, dt):
        self.tick(dt)
        ms = sorted((st.get("media") or []), key=self._rank)
        self.m = ms[0] if ms else None
        self.others = ms[1:5]
        if self.m and self.m.get("duration"):
            p = num(self.m.get("position")) or 0
            at = self.m.get("positionAt")
            if self.m.get("state") == "playing" and isinstance(at, str):
                try:
                    p += (datetime.now(timezone.utc) - datetime.fromisoformat(at.replace("Z", "+00:00"))).total_seconds()
                except ValueError:
                    pass
            self.pos.set(min(p, num(self.m.get("duration")) or p))
        self.pos.step(dt)
        arts = st.get("_arts") or {}
        self.art = arts.get((self.m or {}).get("art")) if self.m else None
        ly = st.get("lyrics") or {}
        self.lyrics = ly.get("lines") or [] if self.m and ly.get("player") == self.m.get("id") and self.options.get("lyrics", True) else []
        if self.lyrics:
            pos = self.pos.value
            idx = -1
            for i, ln in enumerate(self.lyrics):
                if (ln.get("t") or 0) <= pos:
                    idx = i
                else:
                    break
            if idx != self.lyric_idx:
                self.lyric_idx, self.lyric_at = idx, time.perf_counter()

    def draw(self, c, t, progress):
        sk = self.sk
        n = 1 + len(self.others) if self.m else 0
        self.header(c, "Redare", f"{n} dispozitive" if n > 1 else ((self.m or {}).get("app") or ""), progress)
        d = ImageDraw.Draw(c)
        if not self.m:
            sk.text(d, (W // 2, 180), "nimic în redare", sk.mid, sk.muted, anchor="mm")
            return
        compact = bool(self.others)
        art_sz = 96 if compact else 150
        top = 70 if compact else 80
        if sk.panel_alpha:
            sk.panel(c, (22 + art_sz + 10, top + 4, 464, top + art_sz)); d = ImageDraw.Draw(c)
        if self.art is not None:
            c.paste(self.art.resize((art_sz, art_sz)), (22, top))
        else:
            sk.panel(c, (22, top, 22 + art_sz, top + art_sz), radius=14); d = ImageDraw.Draw(c)
            cx, cy = 22 + art_sz // 2, top + art_sz // 2
            for k in range(3):
                r = (10 if compact else 22) + k * (12 if compact else 18)
                a0 = (int(t * 90) // 10 * 10) % 360
                d.arc((cx - r, cy - r, cx + r, cy + r), a0, a0 + 200, fill=lerp_rgb(sk.accent, sk.bg, 0.3 + k * 0.2), width=4)
        tb = self.bgc() if not sk.panel_alpha else lerp_rgb(sk.bg, sk.card, 0.15)
        tx = 22 + art_sz + 24
        name = str(self.m.get("name") or self.m.get("id", "").replace("media_player.", "").replace("_", " "))
        self.box("title", str(self.m.get("title") or ("pornit" if self.m.get("state") == "playing" else "—")), speed=40).draw(c, (tx, top + 8, W - 22, top + 40), sk.mid, sk.fg, tb)
        self.box("artist", str(self.m.get("artist") or ""), speed=30).draw(c, (tx, top + 44, W - 22, top + 66), sk.small, sk.muted, tb)
        sk.text(d, (tx, top + 72), fit_text(d, name + ((" · " + str(self.m.get("app"))) if self.m.get("app") else ""), sk.tiny, W - 22 - tx), sk.tiny, sk.muted)
        dur = num(self.m.get("duration")) or 0
        by = top + art_sz - 4 if compact else 210
        if dur:
            bar(d, tx, by, W - tx - 22, 6, self.pos.value / dur, sk.accent, sk.track)
            if not compact:
                sk.text(d, (tx, by + 12), f"{int(self.pos.value)//60}:{int(self.pos.value)%60:02d}", sk.tiny, sk.muted)
                sk.text(d, (W - 22, by + 12), f"{int(dur)//60}:{int(dur)%60:02d}", sk.tiny, sk.muted, anchor="ra")
        if not compact:
            if self.lyrics and self.m.get("state") == "playing":
                # current line big, next line faded; each new line slides up
                age = min(1.0, (time.perf_counter() - self.lyric_at) / 0.35)
                e = ease_out_cubic(age)
                cur = self.lyrics[self.lyric_idx].get("text", "") if self.lyric_idx >= 0 else "♪"
                nxt = self.lyrics[self.lyric_idx + 1].get("text", "") if 0 <= self.lyric_idx + 1 < len(self.lyrics) else ""
                ly = 262 + int(10 * (1 - e))
                sk.text(d, (22, ly), fit_text(d, cur, sk.small, W - 44), sk.small, lerp_rgb(sk.bg, sk.fg, e))
                sk.text(d, (22, ly + sk.small.size + 6), fit_text(d, nxt, sk.tiny, W - 44), sk.tiny, lerp_rgb(sk.muted, sk.bg, 0.3))
            elif self.m.get("state") == "playing":
                for i in range(5):
                    h = 8 + 18 * (0.5 + 0.5 * qsin(t * 5 + i * 1.1, 4))
                    d.rounded_rectangle((tx + i * 12, 290 - h, tx + i * 12 + 7, 290), radius=2, fill=sk.accent)
            else:
                d.rectangle((tx + 2, 268, tx + 8, 290), fill=sk.muted); d.rectangle((tx + 14, 268, tx + 20, 290), fill=sk.muted)
            return
        # the other players, one row each: state dot · name · what they play
        y = top + art_sz + 14
        rh = min(40, (H - 12 - y) // max(1, len(self.others)))
        arts = {}
        for i, o in enumerate(self.others):
            playing = o.get("state") == "playing"
            col = sk.ok if playing else sk.muted
            if playing:
                col = lerp_rgb(sk.ok, sk.bg, 0.3 * Pulse(1.6, i, steps=4).at(t))
            d.ellipse((26, y + rh // 2 - 9, 36, y + rh // 2 + 1), fill=col)
            oname = str(o.get("name") or o.get("id", "").replace("media_player.", "").replace("_", " "))
            sk.text(d, (46, y + 2), fit_text(d, oname, sk.tiny, 150), sk.tiny, sk.muted)
            what = str(o.get("title") or ("redă" if playing else "pauză"))
            if o.get("artist"):
                what += " — " + str(o.get("artist"))
            self.box(f"other{i}", what, speed=30).draw(c, (200, y - 2, W - 22, y + rh - 8), sk.small, sk.fg if playing else sk.muted, tb)
            y += rh


# ---------------------------------------------------------------- 8. lists
class ListsView(View):
    id, title = "lists", "Liste"

    def __init__(self, accent):
        super().__init__(accent)
        self.shop: list[str] = []; self.actions: list[dict] = []

    def dwell_scale(self, st):
        return 0.5 if not (st.get("shopping") or []) else 1.0

    def update(self, st, dt):
        self.tick(dt)
        self.shop = (st.get("shopping") or [])[:6]
        self.actions = (st.get("actions") or [])[:5]

    def draw(self, c, t, progress):
        sk = self.sk
        self.header(c, "Cumpărături", f"{len(self.shop)}", progress)
        d = ImageDraw.Draw(c)
        if sk.panel_alpha:
            sk.panel(c, (16, 66, 250, 300)); sk.panel(c, (260, 66, 464, 300)); d = ImageDraw.Draw(c)
        tb = self.bgc() if not sk.panel_alpha else lerp_rgb(sk.bg, sk.card, 0.15)
        y = 74
        for i, s in enumerate(self.shop):
            p = Pulse(2.5, i * 0.6, steps=6).at(t)
            d.rounded_rectangle((22, y + 4, 34, y + 16), radius=3, outline=lerp_rgb(sk.muted, sk.accent, p), width=2)
            self.box(f"shop{i}", s).draw(c, (44, y - 4, 240, y + 22), sk.small, sk.fg, tb)
            y += 30
        if not self.shop:
            sk.text(d, (22, 80), "lista e goală", sk.small, sk.muted)
        sk.text(d, (268, 74), sk.label("ultimele acțiuni vmui"), sk.tiny, sk.muted)
        y = 100
        for i, a in enumerate(self.actions):
            hh = datetime.fromtimestamp((a.get("at") or 0) / 1000, TZ).strftime("%H:%M") if a.get("at") else ""
            sk.text(d, (268, y), hh, sk.tiny, sk.muted)
            self.box(f"act{i}", f"{a.get('action')} {a.get('target')}", speed=28).draw(c, (312, y - 2, W - 22, y + 16), sk.tiny, sk.fg, tb)
            y += 24


VIEWS: dict[str, type[View]] = {v.id: v for v in (ClockView, WeatherView, HomeView, AmbilightView, PcView, PiView, ActivityView, MediaView, ListsView)}

from views_extra import EXTRA_VIEWS  # noqa: E402  (registers the 11 additional views)

VIEWS.update(EXTRA_VIEWS)
from views_more import MORE_VIEWS  # noqa: E402

VIEWS.update(MORE_VIEWS)
