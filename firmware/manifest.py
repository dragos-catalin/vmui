#!/usr/bin/env python3
"""Vatra firmware manifests (stdlib only; the build VM has no node).

  manifest.py --image <yaml> --dir firmware-dist/<id> --version <v>
      writes firmware-dist/<id>/manifest.json (ESP Web Tools + hub contract),
      <id>-<v>.ota.md5 next to the ota bin.
  manifest.py --index firmware-dist
      writes firmware-dist/index.json and firmware-dist/SHA256SUMS from every
      firmware-dist/*/manifest.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

CHIP_FAMILY = {
    "vatra-display-oled": "ESP32",
    "vatra-display-s3": "ESP32-S3",
    "vatra-button-atom": "ESP32",
    "vatra-button-c3": "ESP32-C3",
}
HUMAN = {
    "vatra-display-oled": "Display (OLED)",
    "vatra-display-s3": "Display (4\" touch)",
    "vatra-button-atom": "Button (Atom Lite)",
    "vatra-button-c3": "Button (ESP32-C3)",
}
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")


def digest(path: Path, algo: str) -> str:
    h = hashlib.new(algo)
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def project_kind(image_yaml: Path) -> str:
    m = re.search(r"^\s*project_kind:\s*([a-z]+)\s*$", image_yaml.read_text(encoding="utf-8"), re.M)
    if not m:
        sys.exit(f"{image_yaml}: no project_kind substitution")
    return m.group(1)


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


def manifest(image_yaml: Path, out: Path, version: str) -> None:
    image_id = image_yaml.stem
    if image_id not in CHIP_FAMILY:
        sys.exit(f"unknown image id {image_id}: add it to CHIP_FAMILY in manifest.py")
    if not VERSION_RE.match(version):
        sys.exit(f"version {version!r} is not semver")
    factory = out / f"{image_id}-{version}.factory.bin"
    ota = out / f"{image_id}-{version}.ota.bin"
    for p in (factory, ota):
        if not p.is_file():
            sys.exit(f"missing {p}")
    md5 = digest(ota, "md5")
    write(out / f"{image_id}-{version}.ota.md5", md5 + "\n")
    doc = {
        "name": f"Vatra {HUMAN[image_id]}",
        "version": version,
        "home_assistant_domain": "esphome",
        "new_install_prompt_erase": True,
        "builds": [
            {
                "chipFamily": CHIP_FAMILY[image_id],
                "parts": [{"path": factory.name, "offset": 0}],
                "ota": {"path": ota.name, "md5": md5, "summary": f"Vatra {version}"},
            }
        ],
        # Not read by ESP Web Tools; lets the hub and index.json use one source.
        "vatra": {"id": image_id, "project": f"vatra.{project_kind(image_yaml)}"},
    }
    write(out / "manifest.json", json.dumps(doc, indent=2) + "\n")


def index(dist: Path) -> None:
    entries = []
    sums = []
    for mf in sorted(dist.glob("*/manifest.json")):
        doc = json.loads(mf.read_text(encoding="utf-8"))
        build = doc["builds"][0]
        ota = mf.parent / build["ota"]["path"]
        if digest(ota, "md5") != build["ota"]["md5"]:
            sys.exit(f"{mf}: md5 does not match {ota.name}")
        entries.append(
            {
                "id": doc["vatra"]["id"],
                "version": doc["version"],
                "chipFamily": build["chipFamily"],
                "project": doc["vatra"]["project"],
            }
        )
        for f in sorted(mf.parent.iterdir()):
            if f.is_file():
                sums.append(f"{digest(f, 'sha256')}  {f.relative_to(dist).as_posix()}")
    if not entries:
        sys.exit(f"no */manifest.json under {dist}")
    write(dist / "index.json", json.dumps(entries, indent=2) + "\n")
    write(dist / "SHA256SUMS", "\n".join(sums) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", type=Path)
    ap.add_argument("--dir", type=Path)
    ap.add_argument("--version")
    ap.add_argument("--index", type=Path)
    a = ap.parse_args()
    if a.index:
        index(a.index)
    elif a.image and a.dir and a.version:
        manifest(a.image, a.dir, a.version)
    else:
        ap.error("--index DIR, or --image + --dir + --version")


if __name__ == "__main__":
    main()
