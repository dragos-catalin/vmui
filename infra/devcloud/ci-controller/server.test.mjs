import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature, pickProfile, costUsd, vmName, appJwt, handle, PROFILES, imageFamily, bootSecFromSerial, shouldFallback, capacityOk, rerunPath, isAbort, ownerOf, fallbackVarRequests, usesFallbackVar, FALLBACK_VAR } from './server.mjs';

test('fallback variable: PATCH existing, POST creates, only for opted-in repos', () => {
  const { patch, create } = fallbackVarRequests(1);
  assert.equal(FALLBACK_VAR, 'DEVCLOUD_FALLBACK');
  assert.deepEqual(patch, ['PATCH', '/actions/variables/DEVCLOUD_FALLBACK', { name: 'DEVCLOUD_FALLBACK', value: '1' }]);
  assert.deepEqual(create, ['POST', '/actions/variables', { name: 'DEVCLOUD_FALLBACK', value: '1' }]);
  assert.equal(fallbackVarRequests('0').patch[2].value, '0');
  assert.equal(usesFallbackVar('brivio-ro/brivio', ['brivio-ro/brivio']), true);
  assert.equal(usesFallbackVar('codai-ro/codai-cc', ['brivio-ro/brivio']), false);
  assert.equal(usesFallbackVar('brivio-ro/brivio', []), false);
});

test('ownerOf takes the installation owner from the job repo (multi-org)', () => {
  assert.equal(ownerOf('brivio-ro/brivio'), 'brivio-ro');
  assert.equal(ownerOf('codai-ro/codai-cc'), 'codai-ro');
  assert.equal(ownerOf('', 'codai-ro'), 'codai-ro');
  assert.equal(ownerOf(undefined, 'x'), 'x');
});

test('verifySignature accepts the GitHub HMAC and rejects tampering', () => {
  const raw = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.equal(verifySignature('s3cret', raw, sig), true);
  assert.equal(verifySignature('s3cret', Buffer.from('{"a":2}'), sig), false);
  assert.equal(verifySignature('other', raw, sig), false);
  assert.equal(verifySignature('s3cret', raw, undefined), false);
  assert.equal(verifySignature('s3cret', raw, 'sha1=abc'), false);
  assert.equal(verifySignature('', raw, sig), false);
});

test('pickProfile needs self-hosted plus a devcloud label', () => {
  assert.equal(pickProfile(['ubuntu-latest']), null);
  assert.equal(pickProfile(['devcloud-linux-16']), null);
  assert.equal(pickProfile(['self-hosted', 'linux']), null);
  assert.equal(pickProfile(['self-hosted', 'devcloud-linux-16']).machine, 'c4d-highcpu-16');
  assert.equal(pickProfile(['Self-Hosted', 'DEVCLOUD-LINUX-32']).machine, 'c4d-highcpu-32');
  assert.equal(pickProfile(['self-hosted', 'devcloud-linux-4']).machine, 'c4d-highcpu-4');
  assert.equal(pickProfile(['self-hosted', 'devcloud-linux-4', 'devcloud-android-jdk21']).toolchain, 'android-jdk21');
});

test('pickProfile picks the toolchain image family from an extra label', () => {
  assert.equal(pickProfile(['self-hosted', 'devcloud-linux-16']).toolchain, 'node24');
  assert.equal(pickProfile(['self-hosted', 'devcloud-linux-16', 'devcloud-android-jdk21']).toolchain, 'android-jdk21');
  assert.equal(pickProfile(['self-hosted', 'devcloud-linux-32', 'devcloud-unknown']).toolchain, 'node24');
  assert.equal(imageFamily({ toolchain: 'flutter' }, 'p'), 'projects/p/global/images/family/devcloud-ci-flutter');
});

test('bootSecFromSerial reads the runner-online marker', () => {
  assert.equal(bootSecFromSerial('x\n::image {}\n::runner-online 23s\n'), 23);
  assert.equal(bootSecFromSerial('no marker'), null);
  assert.equal(bootSecFromSerial(undefined), null);
});

test('shouldFallback only on the first attempt and only for capacity/preemption', () => {
  assert.equal(shouldFallback({ run_attempt: 1 }, 'no-capacity'), true);
  assert.equal(shouldFallback({}, 'preempted'), true);
  assert.equal(shouldFallback({ run_attempt: 2 }, 'no-capacity'), false);
  assert.equal(shouldFallback({ run_attempt: 1 }, 'job-failed'), false);
  assert.equal(shouldFallback(null, 'no-capacity'), false);
});

test('fallback re-runs the whole run so the gate job re-decides the runner', () => {
  assert.equal(rerunPath(42), '/actions/runs/42/rerun');
  assert.doesNotMatch(rerunPath(42), /failed/);
});

test('isAbort recognises a fetch timeout so the op wait keeps waiting', async () => {
  const e = await fetch('http://10.255.255.1/', { signal: AbortSignal.timeout(1) }).catch((x) => x);
  assert.equal(isAbort(e), true);
  assert.equal(isAbort(new Error('boom')), false);
  assert.equal(isAbort(undefined), false);
});

test('capacityOk is false only for a recent unrecovered failure', () => {
  const now = 10_000_000;
  assert.equal(capacityOk({ lastFailAt: 0, lastOkAt: 0 }, now, 30), true);
  assert.equal(capacityOk({ lastFailAt: now - 60_000, lastOkAt: 0 }, now, 30), false);
  assert.equal(capacityOk({ lastFailAt: now - 60_000, lastOkAt: now - 1000 }, now, 30), true);
  assert.equal(capacityOk({ lastFailAt: now - 31 * 60_000, lastOkAt: 0 }, now, 30), true);
});

test('costUsd scales with time and is cheaper on Spot', () => {
  const p = PROFILES['devcloud-linux-16'];
  assert.equal(costUsd(p, 'SPOT', 0), 0);
  const spot = costUsd(p, 'SPOT', 3600), std = costUsd(p, 'STANDARD', 3600);
  assert.ok(spot > 0.2 && spot < 0.5, `spot ${spot}`);
  assert.ok(std > spot * 2, `std ${std}`);
  assert.ok(Math.abs(costUsd(p, 'SPOT', 1800) - spot / 2) < 1e-5);
});

test('vmName is a valid GCE name', () => {
  assert.match(vmName(114430954977), /^gha-[0-9]+$/);
});

test('appJwt is RS256 and verifies with the public key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const jwt = appJwt(123, pem, 1_700_000_000);
  const [h, b, s] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  assert.deepEqual(JSON.parse(Buffer.from(b, 'base64url')), { iat: 1_699_999_940, exp: 1_700_000_540, iss: '123' });
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')), true);
});

test('handle ignores foreign repos, non-devcloud jobs and other events', async () => {
  assert.equal((await handle('ping', {})).status, 200);
  assert.equal((await handle('push', {})).body, 'ignored event');
  const job = (labels, repo = 'codai-ro/codai-cc') => ({ action: 'in_progress', repository: { full_name: repo }, workflow_job: { id: 1, labels } });
  assert.equal((await handle('workflow_job', job(['self-hosted', 'devcloud-linux-16'], 'evil/repo'))).body, 'repo not allowed');
  assert.equal((await handle('workflow_job', job(['ubuntu-latest']))).body, 'not a devcloud job');
});
