"""vatra-updater A/B OS stage (P5-04) with a fake rugix-ctrl + bootloader + docker.

  python -m unittest discover deploy/vatra/updater
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vatra_updater as vu  # noqa: E402

IMG = {"VATRA_IMAGE": "ghcr.io/o/vatra@sha256:" + "a" * 64}
BUNDLE = b"rugix bundle bytes " * 4096
BHASH = "sha512-256:" + "b" * 64


class FakeBoard:
    """rugix-ctrl + the bootloader state it drives (systemd-boot one-shot / tryboot), plus docker.

    Slot groups a/b; `default` = committed group, `oneshot` = group to try on the next boot only,
    `active` = booted group. Booting consumes the one-shot, exactly like systemd-boot / tryboot."""

    def __init__(self, root: Path, release: Path):
        self.root = root
        self.release = release
        self.calls: list[list[str]] = []
        self.default = self.active = "a"
        self.oneshot: str | None = None
        self.slots = {"a": "1.0.0", "b": None}
        self.staged: str | None = None
        self.vatra_healthy = True
        self.install_fails = False
        self.state = "Active"
        self.write_release()

    def write_release(self):
        self.release.write_text(f"AB=1\nPLATFORM=x86\nVERSION={self.slots[self.active]}\n")

    def boot(self):
        """Power cycle: the firmware takes the one-shot once, otherwise the default."""
        self.active = self.oneshot or self.default
        self.oneshot = None
        self.write_release()

    def __call__(self, cmd: list[str]) -> subprocess.CompletedProcess:
        self.calls.append(cmd)
        ok = lambda out="": subprocess.CompletedProcess(cmd, 0, out, "")  # noqa: E731
        fail = lambda err: subprocess.CompletedProcess(cmd, 1, "", err)  # noqa: E731
        if cmd[0] == "rugix-ctrl":
            sub = cmd[1:3]
            if sub == ["system", "info"]:
                # the exact shape rugix-ctrl v1.4.0 printed on the smoke VM (run 2611071958-zjzp)
                return ok(json.dumps({
                    "slots": {f"system-{g}": {"active": g == self.active} for g in "ab"},
                    "boot": {"bootFlow": "systemd-boot", "activeGroup": self.active,
                             "defaultGroup": self.default, "groups": {"a": {}, "b": {}}},
                    "state": {"status": self.state, "dataPartition": "/dev/vda4"},
                }))
            if sub == ["update", "install"]:
                if self.install_fails:
                    return fail("hash mismatch")
                assert "--reboot" in cmd and cmd[cmd.index("--reboot") + 1] == "no", cmd
                assert cmd[cmd.index("--bundle-hash") + 1] == BHASH
                spare = "b" if self.active == "a" else "a"
                self.slots[spare] = self.staged
                return ok()
            if sub == ["system", "reboot"]:
                assert "--spare" in cmd
                self.oneshot = "b" if self.active == "a" else "a"
                return ok()
            if sub == ["system", "commit"]:
                self.default = self.active
                return ok()
            raise AssertionError(f"unexpected rugix-ctrl {cmd}")
        if cmd[:2] == ["systemctl", "reboot"]:
            return ok()
        if cmd[:2] == ["docker", "info"]:
            return ok("29.0.0")
        if cmd[:2] == ["docker", "compose"]:
            return ok("cid-vatra\n") if cmd[6] == "ps" else ok()
        if cmd[:2] == ["docker", "inspect"]:
            return ok("running healthy" if self.vatra_healthy else "running unhealthy")
        if cmd[:2] == ["cosign", "verify-blob"]:
            return ok()
        raise AssertionError(f"unexpected command {cmd}")


class OsStageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir()
        self.release = self.root / "vatra-os-release"
        self.flag = self.root / "no-reboot"
        self.src = self.root / "bundle.rugixb"
        self.src.write_bytes(BUNDLE)
        self.board = FakeBoard(self.root, self.release)
        self.clock = [0.0]
        self.hour = [3]
        self.cfg = vu.Config(root=self.root, manifest_url="file:///x/stable.json", health_url=None,
                             os_release=str(self.release), no_reboot_flag=str(self.flag),
                             os_health_timeout=60, health_timeout={"default": 20})
        self.manifest = self.make_manifest("1.1.0")
        self.downloads: list[str] = []

        def sleep(s):
            self.clock[0] += s

        self.up = vu.Updater(self.cfg, run=self.board, fetch=self.fetch, sleep=sleep, now=lambda: self.clock[0],
                             download=self.download, local_now=lambda: datetime(2026, 11, 7, self.hour[0], 15))

    def tearDown(self):
        self.tmp.cleanup()

    def make_manifest(self, os_version: str, sha: str | None = None) -> dict:
        self.board.staged = os_version
        return {"schema": 1, "channel": "stable", "version": "0.5.0", "images": dict(IMG),
                "os": {"version": os_version, "platforms": {"x86": {
                    "url": "https://example.test/vatra-os-x86.rugixb", "size": len(BUNDLE),
                    "sha256": sha or hashlib.sha256(BUNDLE).hexdigest(), "bundleHash": BHASH}}}}

    def fetch(self, url: str) -> bytes:
        return b"sig" if url.endswith(".sigstore") else json.dumps(self.manifest).encode()

    def download(self, url: str, dest: Path) -> None:
        self.downloads.append(url)
        have = dest.stat().st_size if dest.exists() else 0
        with open(dest, "ab") as f:
            f.write(self.src.read_bytes()[have:])

    def rugix(self, *sub: str) -> list[list[str]]:
        return [c for c in self.board.calls if c[0] == "rugix-ctrl" and tuple(c[1:1 + len(sub)]) == sub]

    def os_status(self) -> dict:
        return json.loads(self.cfg.status_path.read_text())["os"]

    def stage(self) -> int:
        return self.up.os_stage(self.manifest)

    # ---- install path ---------------------------------------------------------------------
    def test_install_writes_spare_and_reboots_once_in_window(self):
        self.assertEqual(self.stage(), 0)
        self.assertEqual(len(self.rugix("update", "install")), 1)
        self.assertEqual(self.board.slots["b"], "1.1.0")
        self.assertEqual(self.board.default, "a", "install never changes the committed slot")
        self.assertEqual(self.board.oneshot, "b")
        self.assertEqual(self.os_status()["result"], "rebooting")
        self.assertFalse(list((self.root / "os").glob("*.rugixb")), "bundle removed after install")

    def test_full_switch_commits_after_health(self):
        self.stage()
        self.board.boot()
        self.assertEqual(self.board.active, "b")
        self.assertEqual(self.up.os_health(), 0)
        self.assertEqual(self.board.default, "b")
        self.assertEqual(self.os_status()["result"], "committed")
        self.assertEqual(self.os_status()["previous"], "1.0.0")
        self.board.boot()
        self.assertEqual(self.board.active, "b", "committed slot stays across reboots")
        self.assertEqual(self.up.os_health(), 0)
        self.assertEqual(len(self.rugix("system", "commit")), 1, "a committed boot is not committed again")

    def test_resumes_a_partial_download(self):
        part = self.root / "os" / "vatra-os-x86-1.1.0.rugixb.part"
        part.parent.mkdir(parents=True)
        part.write_bytes(BUNDLE[:1000])
        self.assertEqual(self.stage(), 0)
        self.assertEqual(self.board.slots["b"], "1.1.0")

    # ---- refusals -------------------------------------------------------------------------
    def test_sha_mismatch_is_refused_before_rugix(self):
        self.manifest = self.make_manifest("1.1.0", sha="0" * 64)
        self.assertEqual(self.stage(), 1)
        self.assertEqual(self.rugix("update", "install"), [])
        self.assertEqual(self.board.slots["b"], None)
        self.assertEqual(self.os_status()["result"], "refused")
        self.assertFalse(list((self.root / "os").glob("vatra-os-*")), "a bad download is not kept")

    def test_truncated_download_is_refused(self):
        self.src.write_bytes(BUNDLE[:-10])
        self.assertEqual(self.stage(), 1)
        self.assertEqual(self.rugix("update", "install"), [])

    def test_downgrade_is_refused(self):
        self.manifest = self.make_manifest("0.9.0")
        self.assertEqual(self.stage(), 1)
        self.assertEqual(self.downloads, [])
        self.assertIn("downgrade", self.os_status()["reason"])

    def test_same_version_is_skipped(self):
        self.manifest = self.make_manifest("1.0.0")
        self.assertEqual(self.stage(), 0)
        self.assertEqual(self.downloads, [])
        self.assertEqual(self.rugix("update", "install"), [])
        self.assertEqual(self.os_status()["result"], "up-to-date")

    def test_os_block_is_validated_with_the_manifest(self):
        for bad in ({"version": "1.1.0", "platforms": {"riscv": {}}},
                    {"version": "1.1.0", "platforms": {"x86": {"url": "ftp://x", "sha256": "a" * 64, "size": 1, "bundleHash": BHASH}}},
                    {"version": "1.1.0", "platforms": {"x86": {"url": "https://x", "sha256": "zz", "size": 1, "bundleHash": BHASH}}},
                    {"version": "x", "platforms": {}}):
            with self.assertRaises(vu.Refused):
                vu.validate_manifest({"schema": 1, "channel": "stable", "version": "0.5.0", "images": IMG, "os": bad}, self.cfg)

    def test_not_an_ab_image_is_left_alone(self):
        self.release.write_text("VERSION=1.0.0\n")
        self.assertEqual(self.stage(), 0)
        self.assertEqual(self.board.calls, [])
        self.assertEqual(self.os_status()["result"], "not-ab")

    def test_install_failure_reports_3_and_keeps_committed_slot(self):
        self.board.install_fails = True
        self.assertEqual(self.stage(), 3)
        self.assertEqual(self.board.oneshot, None)
        self.assertEqual(self.os_status()["result"], "install-failed")

    # ---- reboot policy --------------------------------------------------------------------
    def test_no_reboot_hook_defers_then_reboot_runs_later(self):
        self.flag.write_text("")
        self.assertEqual(self.stage(), 0)
        self.assertEqual(self.board.slots["b"], "1.1.0")
        self.assertEqual(self.rugix("system", "reboot"), [])
        self.assertEqual(self.os_status()["result"], "reboot-deferred")
        self.assertEqual(self.os_status()["reason"], "no-reboot hook")
        # next run: the hook is gone, nothing is downloaded or installed again
        self.flag.unlink()
        self.assertEqual(self.stage(), 0)
        self.assertEqual(len(self.rugix("update", "install")), 1)
        self.assertEqual(len(self.rugix("system", "reboot")), 1)

    def test_outside_window_defers(self):
        self.hour[0] = 14
        self.assertEqual(self.stage(), 0)
        self.assertEqual(self.rugix("system", "reboot"), [])
        self.assertEqual(self.os_status()["reason"], "outside update window")
        self.hour[0] = 3
        self.assertEqual(self.up.os_reboot(), 0)
        self.assertEqual(self.board.oneshot, "b")

    def test_window_wraps_midnight(self):
        self.assertTrue(vu.in_window("23:00-05:00", datetime(2026, 1, 1, 1, 0)))
        self.assertFalse(vu.in_window("23:00-05:00", datetime(2026, 1, 1, 12, 0)))
        self.assertTrue(vu.in_window("always", datetime(2026, 1, 1, 12, 0)))

    # ---- health ---------------------------------------------------------------------------
    def test_unhealthy_slot_is_not_committed_and_falls_back(self):
        self.stage()
        self.board.boot()
        self.board.vatra_healthy = False
        self.assertEqual(self.up.os_health(), 2)
        self.assertEqual(self.rugix("system", "commit"), [])
        self.assertIn(["systemctl", "reboot"], self.board.calls)
        self.assertEqual(self.os_status()["result"], "health-failed")
        self.board.boot()  # the one-shot is spent: firmware boots the committed slot
        self.assertEqual(self.board.active, "a")
        self.assertEqual(self.up.os_health(), 2)
        self.assertEqual(self.os_status()["result"], "fell-back")
        self.assertIn("vatra container", self.os_status()["reason"])
        # the same broken version is not installed again on the next nightly run
        self.assertEqual(self.stage(), 0)
        self.assertEqual(len(self.rugix("update", "install")), 1)
        self.assertEqual(self.os_status()["result"], "skipped-failed")

    def test_data_partition_missing_is_unhealthy(self):
        self.stage()
        self.board.boot()
        self.board.state = "Error"
        self.assertEqual(self.up.os_health(), 2)
        self.assertEqual(self.rugix("system", "commit"), [])

    def test_slow_start_within_timeout_still_commits(self):
        self.stage()
        self.board.boot()
        self.board.vatra_healthy = False
        orig = self.up.sleep

        def sleep(s):
            orig(s)
            if self.clock[0] >= 30:
                self.board.vatra_healthy = True

        self.up.sleep = sleep
        self.assertEqual(self.up.os_health(), 0)
        self.assertEqual(self.board.default, "b")

    def test_container_rollback_skips_os_stage(self):
        self.cfg.services = dict(vu.DEFAULT_SERVICES)
        self.up.apply_containers = lambda m, c: 2
        self.up.plan = lambda w: (self.manifest, {})
        self.assertEqual(self.up.apply(), 2)
        self.assertEqual(self.board.calls, [])

    def test_status_keeps_container_and_os_results(self):
        self.up.write_status(result="updated", version="0.5.0")
        self.stage()
        self.up.write_status(result="up-to-date", version="0.5.0")
        s = json.loads(self.cfg.status_path.read_text())
        self.assertEqual(s["result"], "up-to-date")
        self.assertEqual(s["os"]["result"], "rebooting")


if __name__ == "__main__":
    unittest.main()
