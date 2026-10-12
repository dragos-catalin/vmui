import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature, pickProfile, costUsd, vmName, appJwt, handle, PROFILES } from './server.mjs';

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
