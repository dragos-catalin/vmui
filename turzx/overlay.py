"""Phone-notification overlay: a card that slides in over whatever view is
showing, stays a few seconds, slides out. Independent of the view rotation.

Bandwidth: the card is ~440x110 px = 97 KB, so its entry/exit travel is
capped at 8 frames each (quantised y) and the body is static while it
holds — the marquee scrolls only if the text does not fit.
"""

from __future__ import annotations

import time

from PIL import Image, ImageDraw, ImageFilter

from anim import Marquee, ease_in_out, ease_out_back
from skins import font

W, H = 480, 320
CARD_W = 448
CARD_MIN_H, CARD_MAX_H = 108, 292
MAX_LINES = 7
LINE_H = 24
IN_S, OUT_S = 0.45, 0.35

# package -> (label, colour). Mirrors NOTIFY_APPS in src/lib/turzx/catalog.ts.
APPS: dict[str, tuple[str, tuple[int, int, int]]] = {
    "com.whatsapp": ("WhatsApp", (37, 211, 102)),
    "com.instagram.android": ("Instagram", (225, 48, 108)),
    "com.samsung.android.messaging": ("Messages", (120, 80, 255)),
    "com.google.android.apps.messaging": ("Messages", (26, 115, 232)),
    "org.telegram.messenger": ("Telegram", (34, 158, 217)),
    "com.facebook.orca": ("Messenger", (0, 132, 255)),
    "org.thoughtcrime.securesms": ("Signal", (58, 118, 240)),
    "com.google.android.gm": ("Gmail", (234, 67, 53)),
    "com.discord": ("Discord", (88, 101, 242)),
    "com.Slack": ("Slack", (74, 21, 75)),
    "com.samsung.android.dialer": ("Telefon", (0, 120, 255)),
    "io.homeassistant.companion.android": ("Home Assistant", (3, 169, 244)),
}

F_APP = font(15, "sb")
F_TITLE = font(22, "sb")
F_TEXT = font(18, "r")
F_AVATAR = font(30, "b")
F_BADGE = font(13, "b")


def wrap(text: str, f, max_w: int) -> list[str]:
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    out: list[str] = []
    for para in text.replace("\r", "").split("\n"):
        cur = ""
        for w in para.split():
            cand = (cur + " " + w).strip()
            if probe.textlength(cand, font=f) <= max_w or not cur:
                cur = cand
            else:
                out.append(cur)
                cur = w
        out.append(cur)
    return out or [""]


class NotificationOverlay:
    def __init__(self) -> None:
        self.seen: set[str] = set()
        self.queue: list[dict] = []
        self.cur: dict | None = None
        self.t0 = 0.0
        self.hold = 6.0
        self.show_text = True
        self.position = "top"
        self.rect: tuple[int, int, int, int] | None = None  # last painted card box, for push priority
        self.title_m = Marquee(speed=40, pause=1.0)
        self.lines: list[str] = []
        self.body: Image.Image | None = None  # pre-rendered wrapped text
        self.card_h = CARD_MIN_H
        self._card: Image.Image | None = None
        self._card_key: tuple | None = None
        self.primed = False

    # ---- feed
    def configure(self, cfg: dict) -> None:
        self.hold = float(cfg.get("durationSec") or 6)
        self.position = str(cfg.get("position") or "top")
        self.show_text = bool(cfg.get("showText", True))
        self.enabled = bool(cfg.get("enabled", True))
        self.presence_only = bool(cfg.get("presenceOnly", True))
        self.packages = set(cfg.get("packages") or [])

    def offer(self, n: dict | None, present: bool) -> None:
        """Called every poll with the latest notification (or None).

        `present` is False only when the presence sensor positively says nobody is
        at the desk; an unavailable sensor must not swallow every notification
        (2026-10: sensor dead for 12 days, Turzx showed nothing). Every drop is
        logged once with its reason so the next "no notifications" is one grep.
        """
        if not self.primed:
            # whatever is already on the phone when we start is old news; prime on the
            # first poll even when it carries nothing, so the first real one is shown
            self.primed = True
            if n and n.get("id"):
                self.seen.add(n["id"])
            return
        if not n or not n.get("id"):
            return
        nid = n["id"]
        if nid in self.seen:
            return
        self.seen.add(nid)
        if len(self.seen) > 500:
            self.seen = set(list(self.seen)[-200:])
        reason = None
        if not getattr(self, "enabled", True):
            reason = "disabled"
        elif n.get("ongoing"):
            reason = "ongoing"
        elif n.get("group"):
            reason = "group-summary"
        elif self.packages and n.get("pkg") not in self.packages:
            reason = "not-allowed-app"
        elif getattr(self, "presence_only", True) and not present:
            reason = "nobody-at-desk"
        if reason:
            print(f"notify drop {reason} pkg={n.get('pkg')}", flush=True)
            return
        print(f"notify show pkg={n.get('pkg')}", flush=True)
        self.queue.append(n)
        self.queue = self.queue[-5:]

    def offer_copilot(self, n: dict | None) -> None:
        """Agent-harness signal from vmui (/api/copilot/event). Not subject to
        the phone allow-list or presence: it is addressed to whoever sits at
        this PC. An `ask` stays on screen while `ongoing` is true and drops the
        moment the hook cancels it (next tool call).
        vmui keeps ONE current signal, so anything other than *this* ask still
        being active means the ask is over: a null, a different id (the Stop
        hook's `done` replaces it), or the same id with ongoing=false. All
        three release the hold; before this only the first and third did and
        a `done` arriving with a new id left "Copilot așteaptă răspuns" stuck."""
        holding = self.cur is not None and str(self.cur.get("pkg", "")).startswith("copilot.") and self.cur.get("ongoing")
        if holding and (not n or not n.get("id") or n.get("id") != self.cur.get("id") or not n.get("ongoing")):
            self.cur["ongoing"] = False
            self.t0 = min(self.t0, time.monotonic() - IN_S - self.hold + 1.0)  # short tail, then out
        if not n or not n.get("id"):
            return
        nid = n["id"]
        if nid in self.seen:
            return
        self.seen.add(nid)
        if not getattr(self, "enabled", True):
            return
        n = dict(n)
        col = n.get("color")
        if isinstance(col, str) and len(col) == 7:
            n["_col"] = tuple(int(col[i : i + 2], 16) for i in (1, 3, 5))
        # jump the queue: a waiting agent beats a WhatsApp
        self.queue.insert(0, n)
        self.queue = self.queue[:5]
        if self.cur is not None and not str(self.cur.get("pkg", "")).startswith("copilot."):
            self.t0 = -1e9

    # ---- state machine
    @property
    def active(self) -> bool:
        return self.cur is not None

    def _phase(self, now: float) -> tuple[str, float]:
        el = now - self.t0
        if el < IN_S:
            return "in", el / IN_S
        if self.cur is not None and self.cur.get("ongoing") and str(self.cur.get("pkg", "")).startswith("copilot.") and el < 90:
            return "hold", 0.0
        if el < IN_S + self.hold:
            return "hold", (el - IN_S) / self.hold
        if el < IN_S + self.hold + OUT_S:
            return "out", (el - IN_S - self.hold) / OUT_S
        return "done", 1.0

    def step(self, now: float, dt: float) -> None:
        if self.cur is None and self.queue:
            self.cur = self.queue.pop(0)
            self.t0 = now
            self._card = None
            self.title_m.set(str(self.cur.get("title") or ""))
            self.title_m.t = 0.0
            self._layout(self.cur)
        if self.cur is not None:
            ph, _ = self._phase(now)
            if ph == "done":
                self.cur = None
                self._card = None
            else:
                self.title_m.step(dt)

    def _layout(self, n: dict) -> None:
        """Wrap the body; the card grows to fit up to MAX_LINES lines. Longer
        bodies keep all their lines in `self.body` and scroll vertically."""
        text_w = CARD_W - 96 - 16
        self.lines = wrap(str(n.get("text") or ""), F_TEXT, text_w) if self.show_text else ["mesaj nou"]
        shown = min(MAX_LINES, len(self.lines))
        self.card_h = max(CARD_MIN_H, min(CARD_MAX_H, 64 + shown * LINE_H + 12))
        body = Image.new("RGBA", (text_w, len(self.lines) * LINE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(body)
        for i, ln in enumerate(self.lines):
            d.text((0, i * LINE_H), ln, font=F_TEXT, fill=(170, 176, 196, 255))
        self.body = body

    # ---- paint
    def _build_card(self, n: dict) -> Image.Image:
        label, col = APPS.get(str(n.get("pkg")), (str(n.get("app") or "telefon").title(), (124, 156, 255)))
        if n.get("_col"):
            col = tuple(n["_col"])
        ch = self.card_h
        card = Image.new("RGBA", (CARD_W, ch), (0, 0, 0, 0))
        d = ImageDraw.Draw(card)
        d.rounded_rectangle((0, 0, CARD_W - 1, ch - 1), radius=18, fill=(14, 15, 22, 236), outline=(*col, 200), width=2)
        # avatar: the sender's initial on a hue derived from the name (the
        # Companion sensor exposes no bitmap for android.largeIcon), with the
        # app badge small in its top-right corner
        title = str(n.get("title") or "?").strip()
        hue = sum(title.encode()) % 6
        av_col = [(99, 102, 241), (14, 165, 233), (16, 185, 129), (245, 158, 11), (236, 72, 153), (139, 92, 246)][hue]
        d.ellipse((16, 22, 16 + 64, 22 + 64), fill=av_col)
        initials = "".join(p[0] for p in title.split()[:2]).upper() or "?"
        d.text((16 + 32, 22 + 33), initials, font=F_AVATAR, fill=(255, 255, 255), anchor="mm")
        d.ellipse((16 + 44, 22 - 4, 16 + 44 + 26, 22 - 4 + 26), fill=(14, 15, 22, 255))
        d.ellipse((16 + 46, 22 - 2, 16 + 46 + 22, 22 - 2 + 22), fill=col)
        d.text((16 + 57, 22 + 9), label[:1].upper(), font=F_BADGE, fill=(255, 255, 255), anchor="mm")
        d.text((96, 14), label.upper(), font=F_APP, fill=col)
        d.text((CARD_W - 16, 16), time.strftime("%H:%M"), font=F_APP, fill=(128, 134, 155), anchor="ra")
        return card

    def draw(self, canvas: Image.Image, now: float, dim_bg: bool = True) -> bool:
        """Paint the overlay if active. Returns True when it drew anything."""
        if self.cur is None:
            return False
        ph, p = self._phase(now)
        pos = self.position
        ch = self.card_h
        rest_y = 12 if pos == "top" else (H - ch) // 2 if pos == "center" else H - 16 - ch
        # slide in from the nearest edge (top → from above, others → from below)
        off_y = -ch - 8 if pos == "top" else H + 8
        if ph == "in":
            e = ease_out_back(p)
            y = int(off_y + (rest_y - off_y) * e) // 4 * 4  # quantised travel: ≤ 8 distinct positions
            alpha = min(1.0, p * 2)
        elif ph == "out":
            e = ease_in_out(p)
            y = int(rest_y + (off_y - rest_y) * e) // 4 * 4
            alpha = 1.0 - e
        else:
            y = rest_y
            alpha = 1.0
        x = (W - CARD_W) // 2
        # Faded backdrop only behind the half where the card lives. A
        # full-screen dim is a 300 KB repaint per alpha step — the link cannot
        # afford it; a half-screen band at a few alpha steps can.
        if dim_bg and alpha > 0:
            a = int(110 * alpha) // 16 * 16
            if a > 0:
                by0, by1 = (0, min(H, rest_y + ch + 12)) if pos == "top" else (max(0, rest_y - 12), min(H, rest_y + ch + 12)) if pos == "center" else (max(0, rest_y - 12), H)
                region = canvas.crop((0, by0, W, by1)).convert("RGBA")
                shade = Image.new("RGBA", region.size, (0, 0, 0, a))
                canvas.paste(Image.alpha_composite(region, shade).convert("RGB"), (0, by0))
        self.rect = (x, max(0, y), x + CARD_W, min(H, y + ch))
        if self._card is None:
            self._card = self._build_card(self.cur)
        card = self._card
        if alpha < 1.0:
            a = card.split()[3].point(lambda v: int(v * alpha))
            card = card.copy()
            card.putalpha(a)
        canvas.paste(card, (x, y), card)
        # live text on top, only when fully in place
        if ph == "hold" and self.body is not None:
            fill = (236, 238, 245)
            self.title_m.draw(canvas, (x + 96, y + 32, x + CARD_W - 16, y + 60), F_TITLE, fill, (14, 15, 22))
            view_h = min(MAX_LINES, len(self.lines)) * LINE_H
            if len(self.lines) > MAX_LINES:
                # vertical scroll: hold 1.5 s at the top, glide down over the
                # remaining hold, in whole-line steps so most frames repaint nothing
                travel = (len(self.lines) - MAX_LINES) * LINE_H
                scroll_t = max(1.0, self.hold - 3.0)
                q = min(1.0, max(0.0, (p * self.hold - 1.5) / scroll_t))
                off = int(ease_in_out(q) * travel) // LINE_H * LINE_H
            else:
                off = 0
            crop = self.body.crop((0, off, self.body.width, off + view_h))
            canvas.paste(crop, (x + 96, y + 64), crop)
        return True
