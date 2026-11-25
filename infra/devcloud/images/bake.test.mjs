import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chunk, stamp, imagesToDelete, orphanBakeVms, TOOLCHAINS, bakeOs } from './bake.mjs';

test('win-desktop bakes Windows Server 2025 with the ps1 startup key; Linux keeps ubuntu + startup-script', () => {
  const w = bakeOs(TOOLCHAINS['win-desktop']);
  assert.equal(w.sourceImage, 'projects/windows-cloud/global/images/family/windows-2025');
  assert.equal(w.startupKey, 'windows-startup-script-ps1');
  assert.equal(w.script, 'image-setup-win.ps1');
  const l = bakeOs(TOOLCHAINS.node24);
  assert.equal(l.startupKey, 'startup-script');
  assert.equal(l.script, 'image-setup.sh');
  assert.match(l.sourceImage, /ubuntu-2404/);
});

test('win-flutter = win-desktop + Flutter: windows ps1 bake, 150 GB disk, flutter flag', () => {
  const f = TOOLCHAINS['win-flutter'];
  assert.equal(f.os, 'windows');
  assert.equal(f.flutter, true);
  assert.equal(f.store, false);
  assert.ok(f.diskGb >= 150, String(f.diskGb));
  assert.ok(f.maxMin >= 150, String(f.maxMin));
  const o = bakeOs(f);
  assert.equal(o.sourceImage, 'projects/windows-cloud/global/images/family/windows-2025');
  assert.equal(o.startupKey, 'windows-startup-script-ps1');
  assert.equal(o.script, 'image-setup-win.ps1');
});

test('chunk splits base64 under the 256 KB metadata value limit and rejoins losslessly', () => {
  const s = 'A'.repeat(600001);
  const c = chunk(s);
  assert.equal(c.length, 3);
  assert.ok(c.every((x) => x.length <= 240000));
  assert.equal(c.join(''), s);
});

test('stamp is a GCE-name-safe UTC minute', () => {
  assert.equal(stamp(new Date('2026-10-12T06:41:59Z')), '202610120641');
});

test('imagesToDelete keeps the newest N READY/FAILED images and never touches PENDING', () => {
  const imgs = [
    { name: 'a', status: 'READY', creationTimestamp: '2026-10-01T00:00:00Z' },
    { name: 'b', status: 'READY', creationTimestamp: '2026-10-08T00:00:00Z' },
    { name: 'c', status: 'FAILED', creationTimestamp: '2026-10-09T00:00:00Z' },
    { name: 'd', status: 'READY', creationTimestamp: '2026-10-12T00:00:00Z' },
    { name: 'e', status: 'PENDING', creationTimestamp: '2026-10-12T01:00:00Z' },
  ];
  assert.deepEqual(imagesToDelete(imgs, 2), ['b', 'a']);
  assert.deepEqual(imagesToDelete(imgs, 9), []);
});

test('every toolchain has a disk size; store only where node CI runs', () => {
  for (const [k, v] of Object.entries(TOOLCHAINS)) assert.ok(v.diskGb >= 30, k);
  assert.deepEqual(Object.keys(TOOLCHAINS).filter((k) => TOOLCHAINS[k].store), ['node24', 'polyglot']);
});

// A killed bake never reaches its `finally` delete, so the leftover keeps its 100-150 GB boot disk. The
// sweep must be exact in both directions: reap the dead ones, keep a live bake and every foreign VM.
test('orphanBakeVms reaps dead bake VMs and leaves running ones and other agents alone', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const items = [
    { name: 'bake-win-flutter-202611250704', zone: 'https://x/zones/europe-west4-a', status: 'TERMINATED', creationTimestamp: '2026-11-25T07:04:00Z', labels: { purpose: 'ci-bake' } },
    { name: 'bake-preempted', zone: 'https://x/zones/europe-west4-b', status: 'STOPPED', creationTimestamp: '2026-11-25T06:00:00Z', labels: { purpose: 'ci-bake' } },
    { name: 'bake-live', zone: 'https://x/zones/europe-west4-a', status: 'RUNNING', creationTimestamp: '2026-11-25T11:10:00Z', labels: { purpose: 'ci-bake' } },
    { name: 'bake-still-booting', zone: 'https://x/zones/europe-west4-a', status: 'PROVISIONING', creationTimestamp: '2026-11-25T11:58:00Z', labels: { purpose: 'ci-bake' } },
    { name: 'bake-just-stopped', zone: 'https://x/zones/europe-west4-a', status: 'TERMINATED', creationTimestamp: '2026-11-25T11:55:00Z', labels: { purpose: 'ci-bake' } },
    { name: 'ws-caelia', zone: 'https://x/zones/europe-west4-a', status: 'TERMINATED', creationTimestamp: '2026-11-25T01:00:00Z', labels: { purpose: 'workspace' } },
  ];
  assert.deepEqual(orphanBakeVms(items, now), [
    { name: 'bake-win-flutter-202611250704', zone: 'europe-west4-a', status: 'TERMINATED' },
    { name: 'bake-preempted', zone: 'europe-west4-b', status: 'STOPPED' },
  ]);
  assert.deepEqual(orphanBakeVms([], now), []);
  assert.deepEqual(orphanBakeVms([{ name: 'x', status: 'TERMINATED', labels: { purpose: 'ci-bake' } }], now), [{ name: 'x', zone: '', status: 'TERMINATED' }]);
});

// The scheduled rebake (build.json, run weekly by Cloud Scheduler) is a SECOND way an image gets made,
// and it does not read this file's defaults. A step that omits --android-sdk bakes a Windows Flutter image
// with no Android toolchain at all, so the weekly job would silently break every Android build on the pool
// while `-Bake <toolchain>` from a terminal stayed green (found 2026-11-25: the win-flutter step had no
// --android-sdk). The layers caelia depends on must travel together in both paths.
test('DC-071 the scheduled rebake asks for the Android layer whenever it bakes Flutter', () => {
  const cfg = JSON.parse(readFileSync(new URL('./build.json', import.meta.url), 'utf8'));
  const steps = cfg.steps.filter((s) => s.id);
  assert.ok(steps.length >= 8, `only ${steps.length} steps in build.json`);
  for (const s of steps) {
    const args = s.args.map(String);
    const tc = args[args.indexOf('--toolchain') + 1];
    assert.ok(TOOLCHAINS[tc], `step ${s.id} names an unknown toolchain ${tc}`);
    if (TOOLCHAINS[tc].flutter) {
      const i = args.indexOf('--android-sdk');
      assert.ok(i > -1, `step ${s.id} bakes Flutter without --android-sdk`);
      assert.match(args[i + 1], /\b3[56]\b/, `step ${s.id} asks for an unexpected Android API level: ${args[i + 1]}`);
    }
    // A Windows bake that forgets --machine lands on the Linux default VM shape and cannot sysprep.
    if (TOOLCHAINS[tc].os === 'windows') {
      assert.equal(args[args.indexOf('--machine') + 1], 'c4d-standard-16', `step ${s.id} Windows VM shape`);
    }
  }
});
