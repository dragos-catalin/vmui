import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, stamp, imagesToDelete, TOOLCHAINS, bakeOs } from './bake.mjs';

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
