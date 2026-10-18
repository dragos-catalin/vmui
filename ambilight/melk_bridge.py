"""Legacy name for the MELK strip bridge -- the code now lives in ble_lights.py.

ble_lights.BleHub is the single owner of every BLE light connection on this
PC (a peripheral accepts ONE central); bridges.py runs it on udp/19450 for
HyperHDR instance 4 plus the JSON control server on tcp/19460. This module
only re-exports the protocol helpers so old imports keep working, and keeps
its CLI for diagnostics. It never opens a BLE connection of its own while a
hub is running.

  python melk_bridge.py --test     # red / green / blue / off on the OA10
  python melk_bridge.py --listen 19450   # standalone hub (bridges.py not running)
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ble_lights import (  # noqa: E402,F401 -- re-exports
    CHAR,
    CONNECT_TIMEOUT_S,
    MIN_DELTA,
    MIN_INTERVAL_S,
    OA10_MAC,
    RELEASE_S,
    WAKE_MIN,
    AmbientDriver,
    BleHub,
    cmd_brightness,
    cmd_effect,
    cmd_led_count,
    cmd_off,
    cmd_on,
    cmd_rgb,
    cmd_speed,
    oa10_owned_elsewhere,
    run_listen,
)

MAC = OA10_MAC


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", type=int, metavar="PORT")
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()
    if (a.test or a.listen) and oa10_owned_elsewhere():
        print("refusing: a bridge already owns the OA10 (tcp/19460 or udp/19450 in use)")
        return 2
    hub = BleHub()
    hub.describe()
    try:
        if a.test:
            drv = AmbientDriver(hub)
            t = time.monotonic()
            for rgb in ((200, 0, 0), (0, 200, 0), (0, 0, 200), (0, 0, 0)):
                print(f"  {rgb}")
                drv.set(rgb, t, 200)
                t += 10
                time.sleep(2.0)
            drv.release()
        elif a.listen:
            run_listen(hub, a.listen)
    finally:
        hub.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
