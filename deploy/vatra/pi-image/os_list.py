#!/usr/bin/env python3
"""Raspberry Pi Imager os_list for the Vatra hub images (P5-01).

  python3 os_list.py --version 0.4.0 --base-url https://.../ --date 2026-11-06 \
      pi5=out/vatra-hub-pi5-0.4.0.img.xz:out/vatra-hub-pi5-0.4.0.img pi4=...

Imager validates extract_sha256 before it writes past the first MB, so the raw image hash is
mandatory. Users add the list in Imager with "Use custom repository" (or open the .json).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

DEVICES = {
    "pi5": ("Raspberry Pi 5", ["pi5"]),
    "pi4": ("Raspberry Pi 4 / 400", ["pi4"]),
}


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def entry(board: str, xz: str, raw: str, version: str, base_url: str, date: str, raw_sha: str | None = None) -> dict:
    label, devices = DEVICES[board]
    return {
        "name": f"Vatra hub {version} ({label})",
        "description": "Vatra home hub: claim it from the Vatra app with the setup code printed on the boot partition. "
                       "Hub Vatra: revendică-l din aplicația Vatra cu codul de configurare de pe partiția de boot.",
        "icon": base_url + "vatra-icon-192.png",
        "url": base_url + os.path.basename(xz),
        "extract_size": os.path.getsize(raw),
        "extract_sha256": raw_sha or sha256(raw),
        "image_download_size": os.path.getsize(xz),
        "image_download_sha256": sha256(xz),
        "release_date": date,
        "init_format": "none",
        "architecture": "armv8",
        "devices": devices,
        "website": "https://github.com/dragos-catalin/vmui",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("images", nargs="+", help="board=<file.img.xz>:<file.img>[:<raw sha256>]")
    a = ap.parse_args(argv)
    if not a.base_url.endswith("/"):
        a.base_url += "/"
    items = []
    for spec in a.images:
        board, _, files = spec.partition("=")
        parts = files.split(":")
        if board not in DEVICES or len(parts) not in (2, 3):
            print(f"bad image spec {spec}", file=sys.stderr)
            return 2
        items.append(entry(board, parts[0], parts[1], a.version, a.base_url, a.date, parts[2] if len(parts) == 3 else None))
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"os_list": items}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"os_list: {len(items)} images -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
