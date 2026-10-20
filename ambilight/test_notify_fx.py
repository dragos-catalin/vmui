"""Notification animations must not strobe: no frame-to-frame jump on any
LED larger than MAX_STEP at the strip's FPS, including the blend in from and
out to the live ambilight frame.

  python -m unittest ambilight/test_notify_fx.py
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify_fx as nf  # noqa: E402

# 30 fps; a full 0->255 swing needs >= ~0.25 s, the bulbs' 0.3 s transitions.
MAX_STEP = 40


def run(event: str, base: bytes, clear_at: float | None = None, seconds: float = 12.0) -> list[bytes]:
    a = nf.Animator()
    a.base = base
    a.start(event)
    t0 = a.t0
    frames = [base]
    t = 0.0
    while t < seconds:
        t += 1 / nf.FPS
        if clear_at is not None and abs(t - clear_at) < 0.5 / nf.FPS:
            a.release(t0 + t)
        f = a.frame(t0 + t)
        if f is None:
            break
        frames.append(f)
    else:
        raise AssertionError(f"{event} never ended")
    frames.append(base)  # the bridge hands back to this frame
    return frames


def max_step(frames: list[bytes]) -> int:
    return max(max(abs(a - b) for a, b in zip(x, y)) for x, y in zip(frames, frames[1:]))


class NoStrobe(unittest.TestCase):
    bases = {"black": bytes(nf.LED_COUNT * 3), "idle red": bytes((160, 0, 0)) * nf.LED_COUNT, "film": bytes((40, 90, 200)) * nf.LED_COUNT}

    def test_self_ending_patterns(self) -> None:
        for ev in ("done", "blocked", "failed"):
            for name, base in self.bases.items():
                with self.subTest(ev=ev, base=name):
                    self.assertLessEqual(max_step(run(ev, base)), MAX_STEP)

    def test_ask_until_cleared(self) -> None:
        for name, base in self.bases.items():
            with self.subTest(base=name):
                self.assertLessEqual(max_step(run("ask", base, clear_at=3.0)), MAX_STEP)

    def test_ask_hits_its_cap(self) -> None:
        a = nf.Animator()
        a.start("ask", duration=2.0)
        frames, t = [bytes(nf.LED_COUNT * 3)], 0.0
        while (f := a.frame(a.t0 + t)) is not None:
            frames.append(f)
            t += 1 / nf.FPS
        frames.append(bytes(nf.LED_COUNT * 3))
        self.assertLess(t, 2.1)
        self.assertLessEqual(max_step(frames), MAX_STEP)

    def test_patterns_still_visible(self) -> None:
        for ev in ("done", "blocked", "failed", "ask"):
            with self.subTest(ev=ev):
                peak = max(max(f) for f in run(ev, self.bases["black"], clear_at=3.0))
                self.assertGreater(peak, 200)


if __name__ == "__main__":
    unittest.main()
