"""vatra-updater behaviour with a fake docker + cosign.

  python -m unittest deploy/vatra/updater/test_vatra_updater.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vatra_updater as vu  # noqa: E402

D = lambda c: "sha256:" + c * 64  # noqa: E731
OLD = {"VATRA_IMAGE": "ghcr.io/o/vatra@" + D("a"), "MOSQUITTO_IMAGE": "eclipse-mosquitto@" + D("b")}
NEW = {"VATRA_IMAGE": "ghcr.io/o/vatra@" + D("c"), "MOSQUITTO_IMAGE": "eclipse-mosquitto@" + D("b")}


class FakeHost:
    """docker + cosign stand-in. `bad` = digests whose containers never turn healthy."""

    def __init__(self, root: Path):
        self.root = root
        self.calls: list[list[str]] = []
        self.sig_ok = True
        self.image_sig_ok = True
        self.bad: set[str] = set()
        self.up_fails = False

    def __call__(self, cmd: list[str]) -> subprocess.CompletedProcess:
        self.calls.append(cmd)
        ok = lambda out="": subprocess.CompletedProcess(cmd, 0, out, "")  # noqa: E731
        fail = lambda err: subprocess.CompletedProcess(cmd, 1, "", err)  # noqa: E731
        if cmd[:2] == ["cosign", "verify-blob"]:
            return ok() if self.sig_ok else fail("no matching signatures")
        if cmd[:2] == ["cosign", "verify"]:
            return ok() if self.image_sig_ok else fail("no matching signatures")
        if cmd[:2] == ["docker", "pull"]:
            return ok()
        if cmd[:2] == ["docker", "compose"]:
            verb = cmd[6]
            if verb == "up":
                return fail("boom") if self.up_fails else ok()
            if verb == "ps":
                return ok(f"cid-{cmd[-1]}\n")
            return ok()
        if cmd[:2] == ["docker", "inspect"]:
            service = cmd[-1].removeprefix("cid-")
            key = next(k for k, v in vu.DEFAULT_SERVICES.items() if v["service"] == service)
            image = vu.read_env(self.root / ".env").get(key, "")
            return ok("running unhealthy" if image in self.bad else "running healthy")
        raise AssertionError(f"unexpected command {cmd}")


class UpdaterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "data").mkdir()
        (self.root / "data" / "vmui.db").write_text("v1-db")
        self.manifest: dict = {"schema": 1, "channel": "stable", "version": "0.5.0", "images": dict(NEW)}
        self.cfg = vu.Config(root=self.root, manifest_url="https://x/stable.json", health_url=None,
                             health_timeout={"default": 20})
        self.host = FakeHost(self.root)
        self.clock = [0.0]

        def sleep(s):
            self.clock[0] += s

        self.up = vu.Updater(self.cfg, run=self.host, fetch=self.fetch, sleep=sleep, now=lambda: self.clock[0])

    def tearDown(self):
        self.tmp.cleanup()

    def fetch(self, url: str) -> bytes:
        return b"bundle" if url.endswith(".sigstore") else json.dumps(self.manifest).encode()

    def install(self, images=OLD, version="0.4.0"):
        vu.write_env(self.root / ".env", images, version)

    def env(self) -> dict:
        return vu.read_env(self.root / ".env")

    def test_update_pins_new_digests_and_keeps_other_lines(self):
        (self.root / ".env").write_text("# hub\nTZ=Europe/Paris\n")
        vu.write_env(self.root / ".env", OLD, "0.4.0")
        self.assertEqual(self.up.apply(), 0)
        env = self.env()
        self.assertEqual(env["VATRA_IMAGE"], NEW["VATRA_IMAGE"])
        self.assertEqual(env["VATRA_VERSION"], "0.5.0")
        self.assertEqual(env["TZ"], "Europe/Paris")
        if os.name != "nt":
            self.assertEqual((self.root / ".env").stat().st_mode & 0o777, 0o600)
        pulled = [c[-1] for c in self.host.calls if c[:2] == ["docker", "pull"]]
        self.assertEqual(pulled, [NEW["VATRA_IMAGE"]], "only the changed image is pulled")
        status = json.loads(self.cfg.status_path.read_text())
        self.assertEqual(status["result"], "updated")

    def test_bad_manifest_signature_is_refused_before_touching_anything(self):
        self.install()
        before = (self.root / ".env").read_text()
        self.host.sig_ok = False
        with self.assertRaises(vu.Refused):
            self.up.apply()
        self.assertEqual((self.root / ".env").read_text(), before)
        self.assertFalse(any(c[:2] == ["docker", "pull"] for c in self.host.calls))

    def test_bad_image_signature_is_refused(self):
        self.install()
        self.host.image_sig_ok = False
        with self.assertRaises(vu.Refused):
            self.up.apply()
        self.assertEqual(self.env()["VATRA_IMAGE"], OLD["VATRA_IMAGE"])

    def test_tag_instead_of_digest_is_refused(self):
        self.install()
        self.manifest["images"]["VATRA_IMAGE"] = "ghcr.io/o/vatra:0.5.0"
        with self.assertRaises(vu.Refused):
            self.up.apply()

    def test_unknown_image_key_is_refused(self):
        self.install()
        self.manifest["images"]["EVIL_IMAGE"] = "x/y@" + D("d")
        with self.assertRaises(vu.Refused):
            self.up.apply()

    def test_wrong_channel_is_refused(self):
        self.install()
        self.manifest["channel"] = "beta"
        with self.assertRaises(vu.Refused):
            self.up.apply()

    def test_downgrade_is_refused(self):
        self.install(version="0.6.0")
        with self.assertRaises(vu.Refused):
            self.up.apply()
        self.assertEqual(self.env()["VATRA_VERSION"], "0.6.0")

    def test_prerelease_orders_before_release(self):
        self.assertLess(vu.semver_key("0.5.0-beta.2"), vu.semver_key("0.5.0"))
        self.assertLess(vu.semver_key("0.5.0-beta.2"), vu.semver_key("0.5.0-beta.10"))
        self.assertLess(vu.semver_key("0.4.9"), vu.semver_key("0.5.0-beta.1"))

    def test_up_to_date_does_nothing(self):
        self.install(images=NEW, version="0.5.0")
        self.assertEqual(self.up.apply(), 0)
        self.assertFalse(any(c[:2] == ["docker", "pull"] for c in self.host.calls))
        self.assertFalse(self.cfg.snapshots.exists())

    def test_unhealthy_update_rolls_back_env_and_state(self):
        self.install()
        self.host.bad.add(NEW["VATRA_IMAGE"])
        # the new version "migrates" the db before it falls over
        orig_up = self.host.__call__

        def run(cmd):
            if cmd[:2] == ["docker", "compose"] and cmd[6] == "up" and self.env()["VATRA_IMAGE"] == NEW["VATRA_IMAGE"]:
                (self.root / "data" / "vmui.db").write_text("v2-db")
            return orig_up(cmd)

        self.up.run = run
        self.assertEqual(self.up.apply(), 2)
        self.assertEqual(self.env()["VATRA_IMAGE"], OLD["VATRA_IMAGE"])
        self.assertEqual(self.env()["VATRA_VERSION"], "0.4.0")
        self.assertEqual((self.root / "data" / "vmui.db").read_text(), "v1-db")
        self.assertEqual(json.loads(self.cfg.status_path.read_text())["result"], "rolled-back")

    def test_compose_up_failure_rolls_back(self):
        self.install()
        self.host.up_fails = True
        # restore also runs `up`; let the second one succeed
        calls = {"n": 0}
        inner = self.host.__call__

        def run(cmd):
            if cmd[:2] == ["docker", "compose"] and cmd[6] == "up":
                calls["n"] += 1
                self.host.up_fails = calls["n"] == 1
            return inner(cmd)

        self.up.run = run
        self.assertEqual(self.up.apply(), 2)
        self.assertEqual(self.env()["VATRA_IMAGE"], OLD["VATRA_IMAGE"])

    def test_failed_rollback_reports_3(self):
        self.install()
        self.host.bad.update({NEW["VATRA_IMAGE"], OLD["VATRA_IMAGE"]})
        self.assertEqual(self.up.apply(), 3)
        self.assertEqual(json.loads(self.cfg.status_path.read_text())["result"], "rollback-failed")

    def test_snapshot_only_holds_state_of_changed_services_and_is_pruned(self):
        self.install()
        (self.root / "ha").mkdir()
        (self.root / "ha" / "big").write_text("x")
        self.cfg.keep_snapshots = 2
        for i in range(3):
            (self.cfg.snapshots / f"2000010{i}T000000Z").mkdir(parents=True)
            (self.cfg.snapshots / f"2000010{i}T000000Z" / "snapshot.json").write_text("{}")
        self.assertEqual(self.up.apply(), 0)
        snaps = sorted(self.cfg.snapshots.iterdir())
        self.assertEqual(len(snaps), 2)
        newest = snaps[-1]
        self.assertTrue((newest / "data" / "vmui.db").exists())
        self.assertFalse((newest / "ha").exists(), "HA did not change: its state is not copied")

    def test_services_are_stopped_before_the_snapshot(self):
        self.install()
        self.up.apply()
        verbs = [c[6] for c in self.host.calls if c[:2] == ["docker", "compose"]]
        self.assertLess(verbs.index("stop"), verbs.index("up"))

    def test_update_and_rollback_only_touch_changed_services(self):
        self.install()
        self.host.bad.add(NEW["VATRA_IMAGE"])
        self.assertEqual(self.up.apply(), 2)
        touched = [c[7:] for c in self.host.calls if c[:2] == ["docker", "compose"] and c[6] in ("up", "stop")]
        self.assertTrue(touched)
        for args in touched:
            self.assertNotIn("mosquitto", args, f"unchanged service restarted: {args}")

    def test_keyless_verification_pins_the_release_workflow_identity(self):
        args = self.up._trust_args()
        self.assertIn("--certificate-oidc-issuer", args)
        rx = args[args.index("--certificate-identity-regexp") + 1]
        self.assertRegex("https://github.com/dragos-catalin/vmui/.github/workflows/release-image.yml@refs/tags/v0.5.0", rx)
        import re
        self.assertIsNone(re.match(rx, "https://github.com/evil/vmui/.github/workflows/release-image.yml@refs/tags/v0.5.0"))
        self.assertIsNone(re.match(rx, "https://github.com/dragos-catalin/vmui/.github/workflows/other.yml@refs/heads/main"))
        # a hand-dispatched run from a branch is not a release
        self.assertIsNone(re.match(rx, "https://github.com/dragos-catalin/vmui/.github/workflows/release-image.yml@refs/heads/main"))

    def test_config_rejects_ignoring_the_tlog_for_keyless(self):
        p = self.root / "u.json"
        p.write_text(json.dumps({"insecure_ignore_tlog": True}))
        with self.assertRaises(vu.Refused):
            vu.Config.load(p)

    def test_release_lookup_skips_prereleases_on_stable(self):
        self.cfg.manifest_url = None
        rels = [
            {"prerelease": True, "assets": [{"name": n, "browser_download_url": "B/" + n} for n in ("stable.json", "stable.json.sigstore")]},
            {"prerelease": False, "assets": [{"name": n, "browser_download_url": "S/" + n} for n in ("stable.json", "stable.json.sigstore")]},
        ]
        self.up.fetch = lambda url: json.dumps(rels).encode()
        self.assertEqual(self.up.manifest_urls(), ("S/stable.json", "S/stable.json.sigstore"))


if __name__ == "__main__":
    unittest.main()
