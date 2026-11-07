#!/usr/bin/env python3
"""vatra-updater (P5-03): move a hub to the digests in its signed channel manifest.

  vatra-updater check      verify the newest manifest for the channel, print what would change
  vatra-updater apply      verify -> pull -> snapshot -> pin .env -> up -> health -> rollback on failure
  vatra-updater rollback   restore the newest snapshot (.env + the state dirs it holds)
  vatra-updater status     print the last run
  vatra-updater os-apply   only the A/B OS stage (P5-04): bundle -> spare slot -> reboot in the window
  vatra-updater os-reboot  reboot into an installed, not yet booted OS bundle (window + hook permitting)
  vatra-updater os-health  at boot (vatra-os-health.service): commit the tried slot or fall back

Runs as root on the hub host (systemd timer), never inside a container. Config:
/srv/vatra/updater.json (see updater.example.json). Every image must arrive pinned by digest in a
manifest whose cosign bundle verifies against the release workflow identity; the Vatra image's own
signature is verified too. A version lower than the one running is refused (no silent downgrade).
Exit codes: 0 ok / up to date, 1 refused (verification, downgrade, bad manifest), 2 rolled back,
3 rollback failed (needs a human), 4 another run holds the lock.

OS stage (P5-04, docs/product/os-ab.md): runs after a successful container stage when the manifest
carries an `os` block and the hub is an A/B image (/etc/vatra-os-release AB=1). The bundle's file
sha256 and its Rugix bundle hash come from the cosign-verified manifest; Rugix Ctrl writes the
spare slot, the reboot happens in the update window unless /run/vatra/no-reboot exists, and the
health unit commits (rugix-ctrl system commit) or reboots uncommitted so the bootloader falls back.
os-health exits 2 when the hub fell back to the previous slot.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

DIGEST = re.compile(r"^[a-z0-9.\-/:_]+@sha256:[0-9a-f]{64}$")
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
BUNDLE_HASH = re.compile(r"^(?:[a-z0-9_\-]+:)?[0-9a-f]{32,128}$")
WINDOW = re.compile(r"^(\d{2}):(\d{2})-(\d{2}):(\d{2})$")
OS_PLATFORMS = ("pi4", "pi5", "x86")
ISSUER = "https://token.actions.githubusercontent.com"
DEFAULT_SERVICES = {
    "VATRA_IMAGE": {"service": "vatra", "state": "data"},
    "HA_IMAGE": {"service": "homeassistant", "state": "ha"},
    "ESPHOME_IMAGE": {"service": "esphome", "state": "esphome"},
    "MOSQUITTO_IMAGE": {"service": "mosquitto", "state": "mosquitto"},
}


class Refused(Exception):
    """The update must not happen (bad signature, downgrade, malformed manifest)."""


@dataclass
class Config:
    root: Path = Path("/srv/vatra")
    channel: str = "stable"
    repo: str = "dragos-catalin/vmui"
    manifest_url: str | None = None  # overrides the GitHub release lookup (tests, mirrors)
    verify: str = "keyless"  # keyless | key (key = tests and self-hosted forks only)
    public_key: str | None = None
    identity_regexp: str | None = None
    insecure_ignore_tlog: bool = False
    allow_insecure_registry: bool = False
    compose_file: str = "compose.yaml"
    services: dict = field(default_factory=lambda: dict(DEFAULT_SERVICES))
    health_url: str | None = "http://127.0.0.1:3737/api/discover"
    health_timeout: dict = field(default_factory=lambda: {"default": 240, "HA_IMAGE": 900})
    keep_snapshots: int = 3
    os_release: str = "/etc/vatra-os-release"
    rugix: str = "rugix-ctrl"
    os_health_timeout: int = 600
    os_reboot_window: str = "02:00-06:00"  # local time, HH:MM-HH:MM (may wrap midnight) or "always"
    no_reboot_flag: str = "/run/vatra/no-reboot"

    @classmethod
    def load(cls, path: Path) -> "Config":
        raw = json.loads(path.read_text()) if path.exists() else {}
        cfg = cls()
        for k, v in raw.items():
            if not hasattr(cfg, k):
                raise Refused(f"unknown config key {k}")
            setattr(cfg, k, Path(v) if k == "root" else v)
        if cfg.channel not in ("beta", "stable"):
            raise Refused("channel must be beta|stable")
        if cfg.verify not in ("keyless", "key"):
            raise Refused("verify must be keyless|key")
        if cfg.verify == "key" and not cfg.public_key:
            raise Refused("verify=key needs public_key")
        if cfg.insecure_ignore_tlog and cfg.verify != "key":
            raise Refused("insecure_ignore_tlog is only allowed with verify=key")
        if cfg.os_reboot_window != "always" and not WINDOW.match(cfg.os_reboot_window):
            raise Refused("os_reboot_window must be HH:MM-HH:MM or always")
        return cfg

    @property
    def env_path(self) -> Path:
        return self.root / ".env"

    @property
    def snapshots(self) -> Path:
        return self.root / "snapshots"

    @property
    def status_path(self) -> Path:
        return self.root / "data" / "update-status.json"

    @property
    def os_dir(self) -> Path:
        return self.root / "os"

    @property
    def os_pending(self) -> Path:
        return self.os_dir / "pending.json"

    @property
    def os_failed(self) -> Path:
        """OS versions that fell back once: not retried until a newer version is published."""
        return self.os_dir / "failed.json"

    def identity(self) -> str:
        return self.identity_regexp or (
            rf"^https://github\.com/{re.escape(self.repo)}/\.github/workflows/release-image\.yml@refs/tags/v"
        )


Runner = Callable[[list[str]], subprocess.CompletedProcess]


def default_runner(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=1800)


def log(msg: str) -> None:
    print(f"[vatra-updater] {msg}", flush=True)


def semver_key(v: str) -> tuple:
    m = SEMVER.match(v or "")
    if not m:
        raise Refused(f"bad version {v!r}")
    major, minor, patch, pre = m.groups()
    # a release sorts after its prereleases; numeric prerelease parts compare as numbers
    pre_key = (1,) if pre is None else (0, *[(0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")])
    return (int(major), int(minor), int(patch), pre_key)


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def write_env(path: Path, images: dict[str, str], version: str) -> None:
    """Replace the image lines and VATRA_VERSION, keep every other line (TZ, comments) as it was."""
    lines = path.read_text().splitlines() if path.exists() else [
        "# /srv/vatra/.env — written by vatra-updater from the signed channel manifest.",
    ]
    wanted = {**images, "VATRA_VERSION": version}
    seen: set[str] = set()
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in wanted:
            out.append(f"{key}={wanted[key]}")
            seen.add(key)
        else:
            out.append(line)
    out += [f"{k}={v}" for k, v in wanted.items() if k not in seen]
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(out) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def copy_tree(src: Path, dst: Path) -> None:
    """copytree that keeps uid/gid: the containers run as uid 1000 and the updater as root."""
    shutil.copytree(src, dst, symlinks=True)
    if not hasattr(os, "lchown"):
        return
    for s, d in [(src, dst)] + [(p, dst / p.relative_to(src)) for p in src.rglob("*")]:
        st = s.lstat()
        os.lchown(d, st.st_uid, st.st_gid)


def validate_manifest(m: dict, cfg: Config) -> None:
    if m.get("schema") != 1:
        raise Refused(f"unsupported manifest schema {m.get('schema')!r}")
    if m.get("channel") != cfg.channel:
        raise Refused(f"manifest is for channel {m.get('channel')!r}, hub follows {cfg.channel!r}")
    semver_key(m.get("version", ""))
    images = m.get("images")
    if not isinstance(images, dict) or "VATRA_IMAGE" not in images:
        raise Refused("manifest has no VATRA_IMAGE")
    for k, v in images.items():
        if k not in cfg.services:
            raise Refused(f"manifest names unknown image {k}")
        if not isinstance(v, str) or not DIGEST.match(v):
            raise Refused(f"{k} is not pinned by digest")
    if "os" in m:
        validate_os_block(m["os"])


def validate_os_block(o: object) -> None:
    if not isinstance(o, dict):
        raise Refused("os block is not an object")
    semver_key(o.get("version", ""))
    plats = o.get("platforms")
    if not isinstance(plats, dict) or not plats:
        raise Refused("os block has no platforms")
    for name, p in plats.items():
        if name not in OS_PLATFORMS:
            raise Refused(f"os block names unknown platform {name}")
        if not isinstance(p, dict):
            raise Refused(f"os.{name} is not an object")
        if not isinstance(p.get("url"), str) or not re.match(r"^(https?|file)://", p["url"]):
            raise Refused(f"os.{name}.url must be http(s) or file")
        if not isinstance(p.get("sha256"), str) or not SHA256.match(p["sha256"]):
            raise Refused(f"os.{name}.sha256 is not a sha256")
        if not isinstance(p.get("size"), int) or isinstance(p["size"], bool) or p["size"] <= 0:
            raise Refused(f"os.{name}.size must be a positive integer")
        if not isinstance(p.get("bundleHash"), str) or not BUNDLE_HASH.match(p["bundleHash"]):
            raise Refused(f"os.{name}.bundleHash is not a Rugix bundle hash")


def in_window(window: str, now: datetime) -> bool:
    if window == "always":
        return True
    m = WINDOW.match(window)
    if not m:
        return False
    h1, m1, h2, m2 = (int(x) for x in m.groups())
    start, end, cur = h1 * 60 + m1, h2 * 60 + m2, now.hour * 60 + now.minute
    return start <= cur < end if start <= end else (cur >= start or cur < end)


def sha256_file(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Updater:
    def __init__(self, cfg: Config, run: Runner = default_runner, fetch: Callable[[str], bytes] | None = None,
                 sleep: Callable[[float], None] = time.sleep, now: Callable[[], float] = time.time,
                 download: Callable[[str, Path], None] | None = None,
                 local_now: Callable[[], datetime] = datetime.now):
        self.cfg = cfg
        self.run = run
        self.fetch = fetch or self._fetch
        self.download = download or self._download
        self.sleep = sleep
        self.now = now
        self.local_now = local_now

    # ---- network -------------------------------------------------------------------------
    @staticmethod
    def _fetch(url: str) -> bytes:
        if url.startswith("file://"):
            return Path(url[7:]).read_bytes()
        req = urllib.request.Request(url, headers={"User-Agent": "vatra-updater", "Accept": "application/octet-stream"})
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 (https / file only by config)
            return r.read()

    @staticmethod
    def _download(url: str, dest: Path) -> None:
        """Append to dest from where it stopped (HTTP Range); a server that ignores Range restarts it."""
        have = dest.stat().st_size if dest.exists() else 0
        if url.startswith("file://"):
            with open(url[7:], "rb") as src, open(dest, "ab") as out:
                src.seek(have)
                shutil.copyfileobj(src, out, 1 << 20)
            return
        last: Exception | None = None
        for attempt in range(4):
            have = dest.stat().st_size if dest.exists() else 0
            headers = {"User-Agent": "vatra-updater"}
            if have:
                headers["Range"] = f"bytes={have}-"
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 (hash-pinned by the signed manifest)
                    mode = "ab" if have and r.status == 206 else "wb"
                    with open(dest, mode) as out:
                        shutil.copyfileobj(r, out, 1 << 20)
                return
            except urllib.error.HTTPError as e:
                if e.code == 416:  # already complete
                    return
                last = e
            except OSError as e:
                last = e
            time.sleep(min(60, 5 * (attempt + 1)))
        raise RuntimeError(f"download failed: {last}")

    def manifest_urls(self) -> tuple[str, str]:
        cfg = self.cfg
        if cfg.manifest_url:
            return cfg.manifest_url, cfg.manifest_url + ".sigstore"
        api = f"https://api.github.com/repos/{cfg.repo}/releases?per_page=20"
        releases = json.loads(self.fetch(api))
        name = f"{cfg.channel}.json"
        for rel in releases:
            if rel.get("draft") or (cfg.channel == "stable" and rel.get("prerelease")):
                continue
            assets = {a["name"]: a["browser_download_url"] for a in rel.get("assets", [])}
            if name in assets and name + ".sigstore" in assets:
                return assets[name], assets[name + ".sigstore"]
        raise Refused(f"no release carries {name} + its .sigstore bundle")

    # ---- verification --------------------------------------------------------------------
    def _trust_args(self) -> list[str]:
        cfg = self.cfg
        if cfg.verify == "key":
            args = ["--key", str(cfg.public_key)]
            if cfg.insecure_ignore_tlog:
                args.append("--insecure-ignore-tlog")
            return args
        return ["--certificate-identity-regexp", cfg.identity(), "--certificate-oidc-issuer", ISSUER]

    def fetch_verified_manifest(self, work: Path) -> dict:
        murl, burl = self.manifest_urls()
        mpath, bpath = work / "manifest.json", work / "manifest.json.sigstore"
        mpath.write_bytes(self.fetch(murl))
        bpath.write_bytes(self.fetch(burl))
        r = self.run(["cosign", "verify-blob", "--bundle", str(bpath), *self._trust_args(), str(mpath)])
        if r.returncode != 0:
            raise Refused(f"manifest signature did not verify: {(r.stderr or r.stdout).strip()[-400:]}")
        try:
            m = json.loads(mpath.read_text())
        except json.JSONDecodeError as e:
            raise Refused(f"manifest is not JSON: {e}") from e
        validate_manifest(m, self.cfg)
        return m

    def verify_image(self, ref: str) -> None:
        extra = ["--allow-insecure-registry"] if self.cfg.allow_insecure_registry else []
        r = self.run(["cosign", "verify", *extra, *self._trust_args(), ref])
        if r.returncode != 0:
            raise Refused(f"image signature did not verify for {ref}: {(r.stderr or r.stdout).strip()[-400:]}")

    # ---- docker --------------------------------------------------------------------------
    def compose(self, *args: str) -> subprocess.CompletedProcess:
        cfg = self.cfg
        return self.run(["docker", "compose", "--env-file", str(cfg.env_path), "-f", str(cfg.root / cfg.compose_file), *args])

    def must(self, r: subprocess.CompletedProcess, what: str) -> subprocess.CompletedProcess:
        if r.returncode != 0:
            raise RuntimeError(f"{what} failed: {(r.stderr or r.stdout).strip()[-400:]}")
        return r

    def health(self, service: str) -> str:
        r = self.compose("ps", "-q", service)
        cid = (r.stdout or "").strip()
        if r.returncode != 0 or not cid:
            return "missing"
        r = self.run(["docker", "inspect", "-f", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", cid])
        if r.returncode != 0:
            return "missing"
        state, _, hc = r.stdout.strip().partition(" ")
        if state != "running":
            return state
        return "healthy" if hc in ("healthy", "none") else hc

    def wait_healthy(self, key: str, version: str) -> bool:
        cfg = self.cfg
        service = cfg.services[key]["service"]
        limit = self.now() + float(cfg.health_timeout.get(key, cfg.health_timeout.get("default", 240)))
        while True:
            s = self.health(service)
            if s == "healthy" and (key != "VATRA_IMAGE" or self.version_ok(version)):
                log(f"{service} healthy")
                return True
            if s in ("exited", "dead", "missing") or self.now() >= limit:
                log(f"{service} not healthy: {s}")
                return False
            self.sleep(5)

    def version_ok(self, version: str) -> bool:
        if not self.cfg.health_url:
            return True
        try:
            body = json.loads(self.fetch(self.cfg.health_url))
        except Exception:  # noqa: BLE001 (any failure = not yet up)
            return False
        return body.get("version") in (version, "", None)

    # ---- snapshots -----------------------------------------------------------------------
    def snapshot(self, keys: list[str]) -> Path:
        cfg = self.cfg
        snap = cfg.snapshots / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        snap.mkdir(parents=True, exist_ok=False)
        os.chmod(snap, 0o700)
        if cfg.env_path.exists():
            shutil.copy2(cfg.env_path, snap / ".env")
        services = [cfg.services[k]["service"] for k in keys]
        # stopped so SQLite / HA's recorder are consistent on disk; `up` starts them again
        if cfg.env_path.exists():
            self.compose("stop", *services)
        held = []
        for k in keys:
            state = cfg.services[k].get("state")
            src = cfg.root / state if state else None
            if src and src.exists():
                copy_tree(src, snap / state)
                held.append(state)
        (snap / "snapshot.json").write_text(json.dumps({"keys": keys, "state": held}))
        self.prune()
        return snap

    def prune(self) -> None:
        snaps = sorted(p for p in self.cfg.snapshots.iterdir() if p.is_dir())
        for old in snaps[: max(0, len(snaps) - self.cfg.keep_snapshots)]:
            shutil.rmtree(old, ignore_errors=True)

    def latest_snapshot(self) -> Path | None:
        if not self.cfg.snapshots.exists():
            return None
        snaps = sorted(p for p in self.cfg.snapshots.iterdir() if (p / "snapshot.json").exists())
        return snaps[-1] if snaps else None

    def restore(self, snap: Path) -> bool:
        cfg = self.cfg
        meta = json.loads((snap / "snapshot.json").read_text())
        keys = meta["keys"]
        services = [cfg.services[k]["service"] for k in keys]
        self.compose("stop", *services)
        for state in meta["state"]:
            dst = cfg.root / state
            shutil.rmtree(dst, ignore_errors=True)
            copy_tree(snap / state, dst)
        if (snap / ".env").exists():
            shutil.copy2(snap / ".env", cfg.env_path)
        old = read_env(cfg.env_path)
        # only what the failed update touched: other services kept running on their own pins
        r = self.compose("up", "-d", *services)
        if r.returncode != 0:
            # a container still in its restart backoff can make `up` race; one retry settles it
            log(f"compose up during rollback failed, retrying: {(r.stderr or r.stdout).strip()[-400:]}")
            self.sleep(5)
            r = self.compose("up", "-d", "--force-recreate", *services)
            if r.returncode != 0:
                log(f"compose up during rollback failed: {(r.stderr or r.stdout).strip()[-400:]}")
                return False
        return all(self.wait_healthy(k, old.get("VATRA_VERSION", "")) for k in keys)

    # ---- status --------------------------------------------------------------------------
    def read_status(self) -> dict:
        try:
            return json.loads(self.cfg.status_path.read_text())
        except (OSError, ValueError):
            return {}

    def write_os_status(self, **os_status) -> None:
        """The os sub-object of update-status.json; the container result next to it is kept."""
        status = self.read_status()
        os_status["at"] = datetime.now(timezone.utc).isoformat()
        status["os"] = os_status
        self._store_status(status)

    def write_status(self, **status) -> None:
        status["at"] = datetime.now(timezone.utc).isoformat()
        status["channel"] = self.cfg.channel
        prev = self.read_status().get("os")
        if prev is not None and "os" not in status:
            status["os"] = prev
        self._store_status(status)

    def _store_status(self, status: dict) -> None:
        p = self.cfg.status_path
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(status, indent=2))
            os.chmod(tmp, 0o644)
            os.replace(tmp, p)
        except OSError as e:
            log(f"could not write status: {e}")

    # ---- commands ------------------------------------------------------------------------
    def plan(self, work: Path) -> tuple[dict, dict[str, str]]:
        m = self.fetch_verified_manifest(work)
        cur = read_env(self.cfg.env_path)
        current = cur.get("VATRA_VERSION")
        if current and SEMVER.match(current) and semver_key(m["version"]) < semver_key(current):
            raise Refused(f"manifest {m['version']} is older than the running {current}: downgrade refused")
        changes = {k: v for k, v in m["images"].items() if cur.get(k) != v}
        return m, changes

    def check(self) -> int:
        with tempfile.TemporaryDirectory() as t:
            m, changes = self.plan(Path(t))
        log(f"channel {self.cfg.channel}: {m['version']} " + (f"changes {sorted(changes)}" if changes else "up to date"))
        return 0

    def apply(self) -> int:
        with tempfile.TemporaryDirectory() as t:
            m, changes = self.plan(Path(t))
        code = self.apply_containers(m, changes)
        # the OS moves only from a healthy container state: a rolled-back hub is not rebooted
        return self.os_stage(m) if code == 0 else code

    def apply_containers(self, m: dict, changes: dict[str, str]) -> int:
        version = m["version"]
        if not changes:
            log(f"up to date at {version}")
            self.write_status(result="up-to-date", version=version)
            return 0
        if "VATRA_IMAGE" in changes:
            self.verify_image(changes["VATRA_IMAGE"])
        for k, ref in changes.items():
            self.must(self.run(["docker", "pull", "-q", ref]), f"pull {k}")
        first = "VATRA_IMAGE" not in read_env(self.cfg.env_path)
        snap = None if first else self.snapshot(sorted(changes))
        write_env(self.cfg.env_path, m["images"], version)
        managed = [self.cfg.services[k]["service"] for k in (m["images"] if first else sorted(changes))]
        up = self.compose("up", "-d", *managed)
        if up.returncode != 0:
            log(f"compose up failed: {(up.stderr or up.stdout).strip()[-400:]}")
        ok = up.returncode == 0 and all(self.wait_healthy(k, version) for k in sorted(changes))
        if ok:
            log(f"updated to {version}: {sorted(changes)}")
            self.write_status(result="updated", version=version, changed=sorted(changes))
            return 0
        if snap is None:
            self.write_status(result="failed", version=version, changed=sorted(changes))
            log("first install is unhealthy and there is nothing to roll back to")
            return 3
        log(f"{version} unhealthy, rolling back to {snap.name}")
        if self.restore(snap):
            self.write_status(result="rolled-back", version=version, changed=sorted(changes), snapshot=snap.name)
            return 2
        self.write_status(result="rollback-failed", version=version, snapshot=snap.name)
        return 3

    def rollback(self) -> int:
        snap = self.latest_snapshot()
        if not snap:
            log("no snapshot to roll back to")
            return 1
        ok = self.restore(snap)
        self.write_status(result="rolled-back" if ok else "rollback-failed", snapshot=snap.name, manual=True)
        return 0 if ok else 3

    # ---- A/B OS (P5-04) ------------------------------------------------------------------
    def running_os(self) -> dict | None:
        """VERSION / PLATFORM of the booted system image, None when this is not an A/B image."""
        rel = read_env(Path(self.cfg.os_release))
        if rel.get("AB") != "1" or not rel.get("VERSION") or rel.get("PLATFORM") not in OS_PLATFORMS:
            return None
        return {"version": rel["VERSION"], "platform": rel["PLATFORM"]}

    def rugix_info(self) -> dict:
        """`rugix-ctrl system info`, boot keys normalised to active_group / default_group / groups."""
        r = self.must(self.run([self.cfg.rugix, "system", "info"]), "rugix-ctrl system info")
        try:
            info = json.loads(r.stdout)
        except ValueError as e:
            raise RuntimeError(f"rugix-ctrl system info is not JSON: {e}") from e
        boot = info.get("boot") or {}
        for snake, camel in (("active_group", "activeGroup"), ("default_group", "defaultGroup"), ("boot_flow", "bootFlow")):
            if snake not in boot and camel in boot:
                boot[snake] = boot[camel]
        info["boot"] = boot
        state = info.get("state") or {}
        if isinstance(state.get("status"), str):
            state["status"] = state["status"].capitalize()
        info["state"] = state
        return info

    def read_pending(self) -> dict | None:
        try:
            return json.loads(self.cfg.os_pending.read_text())
        except (OSError, ValueError):
            return None

    def write_pending(self, pending: dict | None) -> None:
        p = self.cfg.os_pending
        if pending is None:
            p.unlink(missing_ok=True)
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(pending))
        os.replace(tmp, p)

    def failed_versions(self) -> list[str]:
        try:
            v = json.loads(self.cfg.os_failed.read_text())
            return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []
        except (OSError, ValueError):
            return []

    def mark_failed(self, version: str) -> None:
        keep = [v for v in self.failed_versions() if v != version][-9:] + [version]
        self.cfg.os_dir.mkdir(parents=True, exist_ok=True)
        self.cfg.os_failed.write_text(json.dumps(keep))

    def fetch_bundle(self, platform: str, version: str, spec: dict) -> Path:
        d = self.cfg.os_dir
        d.mkdir(parents=True, exist_ok=True)
        final = d / f"vatra-os-{platform}-{version}.rugixb"
        for old in d.glob("vatra-os-*"):
            if old.name not in (final.name, final.name + ".part"):
                old.unlink(missing_ok=True)
        if final.exists() and final.stat().st_size == spec["size"] and sha256_file(final) == spec["sha256"]:
            return final
        part = d / (final.name + ".part")
        if part.exists() and part.stat().st_size > spec["size"]:
            part.unlink()
        self.download(spec["url"], part)
        size = part.stat().st_size if part.exists() else -1
        digest = sha256_file(part) if size == spec["size"] else None
        if digest != spec["sha256"]:
            part.unlink(missing_ok=True)
            raise Refused(f"OS bundle {final.name}: size {size} / sha256 {digest} do not match the signed manifest")
        os.replace(part, final)
        return final

    def os_stage(self, m: dict) -> int:
        o = m.get("os")
        if not o:
            return 0
        cur = self.running_os()
        if cur is None:
            log("not an A/B image: OS stage skipped")
            self.write_os_status(result="not-ab", version=o["version"])
            return 0
        spec = o["platforms"].get(cur["platform"])
        if spec is None:
            self.write_os_status(result="no-bundle", version=o["version"], running=cur["version"])
            return 0
        try:
            if semver_key(o["version"]) < semver_key(cur["version"]):
                raise Refused(f"OS {o['version']} is older than the running {cur['version']}: downgrade refused")
            if o["version"] == cur["version"]:
                log(f"OS up to date at {cur['version']}")
                self.write_os_status(result="up-to-date", version=cur["version"])
                return 0
            if o["version"] in self.failed_versions():
                log(f"OS {o['version']} fell back on this hub before: not retried")
                self.write_os_status(result="skipped-failed", version=o["version"], running=cur["version"])
                return 0
            pending = self.read_pending()
            if pending and pending.get("version") == o["version"] and not pending.get("rebooted"):
                return self.os_reboot()
            bundle = self.fetch_bundle(cur["platform"], o["version"], spec)
        except Refused as e:
            log(f"OS refused: {e}")
            self.write_os_status(result="refused", version=o["version"], running=cur["version"], reason=str(e))
            return 1
        info = self.rugix_info()
        groups = sorted(((info.get("boot") or {}).get("groups") or {}).keys())
        active = (info.get("boot") or {}).get("active_group")
        spare = next((g for g in groups if g != active), None)
        log(f"installing OS {o['version']} into slot group {spare} (running {cur['version']} on {active})")
        r = self.run([self.cfg.rugix, "update", "install", "--reboot", "no",
                      "--bundle-hash", spec["bundleHash"], str(bundle)])
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip()[-400:]
            log(f"OS install failed: {err}")
            self.write_os_status(result="install-failed", version=o["version"], running=cur["version"], reason=err)
            return 3
        bundle.unlink(missing_ok=True)
        self.write_pending({"version": o["version"], "from": cur["version"], "group": spare, "rebooted": False,
                            "installedAt": datetime.now(timezone.utc).isoformat()})
        self.write_os_status(result="installed", version=o["version"], running=cur["version"], group=spare)
        return self.os_reboot()

    def os_reboot(self) -> int:
        pending = self.read_pending()
        if not pending or pending.get("rebooted"):
            return 0
        base = {"version": pending["version"], "running": pending.get("from"), "group": pending.get("group")}
        if Path(self.cfg.no_reboot_flag).exists():
            log(f"reboot into OS {pending['version']} deferred: {self.cfg.no_reboot_flag} exists")
            self.write_os_status(result="reboot-deferred", reason="no-reboot hook", **base)
            return 0
        if not in_window(self.cfg.os_reboot_window, self.local_now()):
            log(f"reboot into OS {pending['version']} deferred to the window {self.cfg.os_reboot_window}")
            self.write_os_status(result="reboot-deferred", reason="outside update window", **base)
            return 0
        pending["rebooted"] = True
        self.write_pending(pending)
        self.write_os_status(result="rebooting", **base)
        log(f"rebooting into OS {pending['version']} (slot group {pending.get('group')}, one try)")
        r = self.run([self.cfg.rugix, "system", "reboot", "--spare"])
        if r.returncode != 0:
            pending["rebooted"] = False
            self.write_pending(pending)
            err = (r.stderr or r.stdout).strip()[-400:]
            self.write_os_status(result="reboot-failed", reason=err, **base)
            return 3
        return 0

    def os_healthy(self) -> tuple[bool, str]:
        limit = self.now() + float(self.cfg.os_health_timeout)
        why = ""
        while True:
            why = self._os_health_once()
            if not why:
                return True, ""
            if self.now() >= limit:
                return False, why
            self.sleep(10)

    def _os_health_once(self) -> str:
        try:
            state = (self.rugix_info().get("state") or {}).get("status")
        except RuntimeError as e:
            return str(e)
        if state != "Active":
            return f"state management {state}: the data partition is not mounted"
        if self.run(["docker", "info", "--format", "{{.ServerVersion}}"]).returncode != 0:
            return "docker is not running"
        s = self.health(self.cfg.services["VATRA_IMAGE"]["service"])
        if s != "healthy":
            return f"vatra container {s}"
        if self.cfg.health_url:
            try:
                json.loads(self.fetch(self.cfg.health_url))
            except Exception as e:  # noqa: BLE001 (any failure = not up)
                return f"{self.cfg.health_url} not answering: {e}"
        return ""

    def os_health(self) -> int:
        if self.running_os() is None:
            return 0
        info = self.rugix_info()
        boot = info.get("boot") or {}
        active, default = boot.get("active_group"), boot.get("default_group")
        pending = self.read_pending()
        running = self.running_os()["version"]
        if active == default:
            if pending and pending.get("rebooted") and pending.get("group") != active:
                log(f"OS {pending['version']} did not stay: back on slot group {active} ({running})")
                prev = self.read_status().get("os") or {}
                self.write_os_status(result="fell-back", version=pending["version"], running=running,
                                     group=active, reason=prev.get("reason", "booted the committed slot"))
                self.mark_failed(pending["version"])
                self.write_pending(None)
                return 2
            return 0
        log(f"trying slot group {active} ({running}); committed is {default}")
        ok, why = self.os_healthy()
        if ok:
            r = self.run([self.cfg.rugix, "system", "commit"])
            if r.returncode != 0:
                err = (r.stderr or r.stdout).strip()[-400:]
                self.write_os_status(result="commit-failed", version=running, group=active, reason=err)
                return 3
            log(f"OS {running} healthy: committed slot group {active}")
            self.write_os_status(result="committed", version=running, group=active,
                                 previous=(pending or {}).get("from"))
            self.write_pending(None)
            return 0
        log(f"OS {running} unhealthy ({why}): rebooting without commit")
        self.write_os_status(result="health-failed", version=running, group=active, reason=why)
        self.run(["systemctl", "reboot"])
        return 2

    def os_apply(self) -> int:
        with tempfile.TemporaryDirectory() as t:
            m = self.fetch_verified_manifest(Path(t))
        return self.os_stage(m)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="vatra-updater")
    ap.add_argument("command", choices=["check", "apply", "rollback", "status", "os-apply", "os-reboot", "os-health"])
    ap.add_argument("--config", default=os.environ.get("VATRA_UPDATER_CONFIG", "/srv/vatra/updater.json"))
    a = ap.parse_args(argv)
    try:
        cfg = Config.load(Path(a.config))
    except Refused as e:
        log(f"config: {e}")
        return 1
    if a.command == "status":
        print(cfg.status_path.read_text() if cfg.status_path.exists() else "{}")
        return 0
    import fcntl  # host-only (Linux); kept out of module scope so the tests import anywhere

    cfg.root.mkdir(parents=True, exist_ok=True)
    lock = open(cfg.root / ".updater.lock", "w")  # noqa: SIM115 (held for the whole run)
    try:
        # the boot-time health check waits for a running apply instead of giving up
        fcntl.flock(lock, fcntl.LOCK_EX | (0 if a.command == "os-health" else fcntl.LOCK_NB))
    except BlockingIOError:
        log("another run holds the lock")
        return 4
    up = Updater(cfg)
    try:
        return {"check": up.check, "apply": up.apply, "rollback": up.rollback, "os-apply": up.os_apply,
                "os-reboot": up.os_reboot, "os-health": up.os_health}[a.command]()
    except Refused as e:
        log(f"refused: {e}")
        up.write_status(result="refused", reason=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
