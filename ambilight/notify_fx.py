"""Per-LED notification animations for the DX Light strip (65 LEDs).

The strip runs right (17, bottom->top), top (31, right->left), left (17,
top->bottom) behind the Odyssey. A notification takes the strip over for a
few seconds, then hands it back to the ambilight frames.

One pattern per Copilot event, so the eye knows what happened without
reading a screen:

  ask      insistent: a bright orange "runner" laps the strip fast while the
           rest breathes; repeats until cancelled (max 10 s, like the bulbs).
  done     calm: a green wave rises from the bottom of both sides, meets at
           the top, then fades out. 3 s, once.
    blocked  a red ring swells from the middle of the top outwards, twice.
    failed   two amber double-pulses over the whole strip.

No hard on/off anywhere: every pattern ramps with a raised-cosine envelope
and the whole notification crossfades in from and out to the live ambilight
frame (`Animator.base`). Hard 0->100 % steps at 30 fps read as a strobe next
to the room bulbs, which use 0.3 s transitions (user, 2026-10-20).

Frames are 65*3 bytes in strip order, rendered at FPS by `Animator.frame()`;
the bridge calls it instead of the HyperHDR frame while `active`.

Control: UDP datagram on FX_PORT, JSON {"event":"ask","color":"#ff5a1f",
"duration":10} or {"event":"clear"}. Sent by vmui /api/copilot/event.
"""
from __future__ import annotations

import colorsys
import json
import math
import time

LED_COUNT = 65
RIGHT = range(0, 17)        # bottom -> top
TOP = range(17, 48)         # right -> left
LEFT = range(48, 65)        # top -> bottom
# 30, not 50: the strip takes 4 HID reports per frame and already runs ~55
# fps from HyperHDR; the wedge of 2026-09-15 23:39 came ~10 min after the
# first 50 fps animation tests. Unproven link, cheap insurance.
FPS = 30
FX_PORT = 19460
FADE_IN_S = 0.5
FADE_OUT_S = 0.8

# Height 0..1 of every LED (0 = desk level, 1 = top edge) and its position
# along the whole strip 0..1 (right-bottom -> top -> left-bottom).
HEIGHT = [0.0] * LED_COUNT
POS = [0.0] * LED_COUNT
for i in RIGHT:
    HEIGHT[i] = (i + 0.5) / len(RIGHT)
for i in TOP:
    HEIGHT[i] = 1.0
for i in LEFT:
    HEIGHT[i] = 1.0 - (i - LEFT.start + 0.5) / len(LEFT)
for i in range(LED_COUNT):
    POS[i] = (i + 0.5) / LED_COUNT
TOP_MID = (TOP.start + TOP.stop) / 2


def _hex(color: str) -> tuple[int, int, int]:
    h = color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _scale(rgb: tuple[int, int, int], k: float) -> tuple[int, int, int]:
    k = max(0.0, min(1.0, k))
    # perceptual: LEDs look linear-ish only after a gamma
    k = k ** 1.8
    return int(rgb[0] * k), int(rgb[1] * k), int(rgb[2] * k)


def _shift_hue(rgb: tuple[int, int, int], dh: float) -> tuple[int, int, int]:
    h, s, v = colorsys.rgb_to_hsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
    r, g, b = colorsys.hsv_to_rgb((h + dh) % 1.0, s, v)
    return int(r * 255), int(g * 255), int(b * 255)


def _smooth(x: float) -> float:
    """0..1 -> 0..1 raised cosine (zero slope at both ends)."""
    x = max(0.0, min(1.0, x))
    return 0.5 - 0.5 * math.cos(math.pi * x)


def _hump(t: float, start: float, width: float) -> float:
    """sin^2 bump over [start, start+width): smooth rise and fall, 0 outside."""
    if not start <= t < start + width:
        return 0.0
    return math.sin(math.pi * (t - start) / width) ** 2


# ---------------------------------------------------------------- patterns
# Each returns per-LED intensity 0..1 (and optionally a colour override) for
# time t (seconds since start). `done`/`blocked`/`failed` end on their own by
# returning None; `ask` loops until duration.

def fx_ask(t: float, base: tuple[int, int, int]) -> list[tuple[int, int, int]] | None:
    lap = 2.4                                  # seconds per lap
    head = (t / lap) % 1.0
    breathe = 0.10 + 0.08 * (0.5 + 0.5 * math.sin(t * 2 * math.pi / 1.5))
    out = []
    for i in range(LED_COUNT):
        d = (POS[i] - head) % 1.0              # distance behind the head
        # soft front (last 20 % before the head) so an LED ramps up over a few
        # frames instead of jumping 0 -> 100 % when the head reaches it
        tail = _smooth(1.0 - d / 0.3) if d < 0.8 else _smooth((d - 0.8) / 0.2)
        k = max(breathe, tail)
        out.append(_scale(base, k))
    return out


def fx_done(t: float, base: tuple[int, int, int]) -> list[tuple[int, int, int]] | None:
    dur = 3.0
    if t >= dur:
        return None
    rise = min(1.0, t / 1.4)                   # wave front height 0..1 in 1.4 s
    fade = 1.0 if t < 2.0 else max(0.0, 1.0 - (t - 2.0) / 1.0)
    out = []
    for i in range(LED_COUNT):
        edge = rise * 1.15 - HEIGHT[i]         # >0 once the front passed
        k = _smooth(edge / 0.4)
        # a slightly lighter crest right at the front
        crest = math.exp(-((edge - 0.1) ** 2) / 0.012) * 0.4
        col = _shift_hue(base, 0.04 * crest)
        out.append(_scale(col, (k + crest) * fade))
    return out


def fx_blocked(t: float, base: tuple[int, int, int]) -> list[tuple[int, int, int]] | None:
    if t >= DURATION["blocked"]:
        return None
    ph = (t % 1.5) / 1.5                       # two shots of 1.5 s
    env = _smooth(ph / 0.42) if ph < 0.42 else 1.0 - _smooth((ph - 0.42) / 0.58)
    radius = _smooth(ph) * 34                  # LEDs from the top middle
    out = []
    for i in range(LED_COUNT):
        dist = abs(i - TOP_MID)
        ring = _smooth(1.0 - abs(dist - radius) / 20.0)
        out.append(_scale(base, env * max(ring, 0.4)))
    return out


def fx_failed(t: float, base: tuple[int, int, int]) -> list[tuple[int, int, int]] | None:
    if t >= DURATION["failed"]:
        return None
    ph = t % 2.2
    # double pulse: two sin^2 humps (the second a bit softer), then a rest
    k = max(_hump(ph, 0.0, 1.0), 0.8 * _hump(ph, 0.85, 1.0))
    return [_scale(base, k)] * LED_COUNT


PATTERNS = {"ask": fx_ask, "done": fx_done, "blocked": fx_blocked, "failed": fx_failed}
DEFAULT_COLOR = {"ask": "#ff5a1f", "done": "#2ecc71", "blocked": "#ff2d2d", "failed": "#ffc400"}
# Self-ending patterns; `ask` loops until cleared or `duration`.
DURATION = {"done": 3.0, "blocked": 3.0, "failed": 4.4}


class Animator:
    """Owns the current notification. `frame()` returns the next 195-byte
    frame or None when nothing is playing. The bridge keeps `base` set to the
    latest ambilight frame so the notification blends in and out of it."""

    def __init__(self) -> None:
        self.event: str | None = None
        self.color = (0, 0, 0)
        self.t0 = 0.0
        self.until = 0.0
        self.base: bytes | None = None
        self._fade_out_at: float | None = None

    @property
    def active(self) -> bool:
        return self.event is not None

    def start(self, event: str, color: str | None = None, duration: float | None = None) -> None:
        if event not in PATTERNS:
            return
        self.event = event
        self.color = _hex(color or DEFAULT_COLOR[event])
        self.t0 = time.monotonic()
        self._fade_out_at = None
        # `ask` loops; cap it like the bulbs so a lost cancel cannot pin the strip
        self.until = self.t0 + (duration if duration is not None else (10.0 if event == "ask" else 60.0))
        print(f"  fx: {event} {color or DEFAULT_COLOR[event]}", flush=True)

    def stop(self) -> None:
        if self.event:
            print(f"  fx: {self.event} end", flush=True)
        self.event = None
        self._fade_out_at = None

    def release(self, now: float | None = None) -> None:
        """Graceful stop: fade back to `base` over FADE_OUT_S."""
        if self.event and self._fade_out_at is None:
            self._fade_out_at = time.monotonic() if now is None else now

    def handle(self, payload: bytes) -> None:
        try:
            msg = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        ev = msg.get("event")
        if ev == "clear":
            self.release()
        elif ev in PATTERNS:
            self.start(ev, msg.get("color"), msg.get("duration"))

    def frame(self, now: float | None = None) -> bytes | None:
        if not self.event:
            return None
        now = time.monotonic() if now is None else now
        t = now - self.t0
        if now >= self.until - FADE_OUT_S:
            self.release(now)
        mix = _smooth(t / FADE_IN_S)
        if self.event in DURATION:
            mix = min(mix, _smooth((DURATION[self.event] - t) / FADE_OUT_S))
        if self._fade_out_at is not None:
            mix = min(mix, 1.0 - _smooth((now - self._fade_out_at) / FADE_OUT_S))
        px = PATTERNS[self.event](t, self.color)
        if px is None or (self._fade_out_at is not None and now - self._fade_out_at >= FADE_OUT_S):
            self.stop()
            return None
        fx = b"".join(bytes(p) for p in px)
        base = self.base if self.base is not None and len(self.base) == len(fx) else bytes(len(fx))
        return bytes(int(b + (f - b) * mix) for b, f in zip(base, fx))


def preview(event: str, seconds: float = 4.0) -> None:
    """Print a coarse ASCII strip so a pattern can be eyeballed without hardware."""
    a = Animator()
    a.start(event)
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        f = a.frame()
        if f is None:
            break
        row = "".join(" .:-=+*#%@"[min(9, max(f[3 * i:3 * i + 3]) * 10 // 256)] for i in range(LED_COUNT))
        print(row, flush=True)
        time.sleep(1 / 12)


if __name__ == "__main__":
    import sys
    preview(sys.argv[1] if len(sys.argv) > 1 else "ask", float(sys.argv[2]) if len(sys.argv) > 2 else 4.0)
