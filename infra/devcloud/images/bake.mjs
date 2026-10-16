#!/usr/bin/env node
// devcloud DC-042: bake a CI runner image family `devcloud-ci-<toolchain>` in the runner project.
// DC-051: toolchain win-desktop bakes Windows Server 2025 (image-setup-win.ps1, GCESysprep at the end).
//   node bake.mjs --toolchain node24 [--lock pnpm-lock.yaml --workspace pnpm-workspace.yaml] [--keep 3] [--dry-run]
// Throwaway bake VM (Spot, no service account) runs image-setup.sh, powers off; its disk becomes
// image devcloud-ci-<tc>-<UTC stamp>; the VM is deleted; images beyond --keep in the family are deleted.
// Credentials: metadata server (Cloud Build / Cloud Run) or `gcloud auth print-access-token` locally.
// Without --lock (Cloud Build), the codai lockfile comes from GitHub with the devcloud-runners App
// (needs Contents: read) — secrets read from Secret Manager, never printed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
export const TOOLCHAINS = {
  node24: { diskGb: 30, store: true },
  'android-jdk21': { diskGb: 40, store: false },
  'rust-tauri-linux': { diskGb: 40, store: false },
  'rust-tauri-win': { diskGb: 50, store: false },
  'python-uv': { diskGb: 30, store: false },
  flutter: { diskGb: 50, store: false },
  polyglot: { diskGb: 64, store: true },
  // Windows: stock image is 50 GB; VS Build Tools + SDK + Rust + Chrome ~ 25 GB more. CI disk is 150 GB.
  'win-desktop': { diskGb: 100, store: false, os: 'windows', maxMin: 120 },
};
/** Per-OS bake shape: source image, startup metadata key + script file. */
export function bakeOs(tc) {
  return tc?.os === 'windows'
    ? { sourceImage: 'projects/windows-cloud/global/images/family/windows-2025', startupKey: 'windows-startup-script-ps1', script: 'image-setup-win.ps1', stopWaitMin: 20 }
    : { sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64', startupKey: 'startup-script', script: 'image-setup.sh', stopWaitMin: 5 };
}
const CFG = {
  toolchain: opt('toolchain', 'node24'),
  project: opt('project', process.env.RUNNER_PROJECT || 'codai-training'),
  control: opt('control', process.env.CONTROL_PROJECT || 'dragos-devcloud'),
  bucket: opt('bucket', process.env.BUCKET || 'dragos-devcloud-devcloud-jobs'),
  zones: (opt('zones', 'europe-west4-a,europe-west4-b,europe-west4-c')).split(','),
  machine: opt('machine', 'c4d-highcpu-16'),
  keep: Number(opt('keep', '3')),
  runnerVersion: opt('runner-version', '2.338.0'),
  pnpmVersion: opt('pnpm-version', '12.9.1'),
  repo: opt('repo', 'codai-ro/codai-cc'),
  maxMin: opt('max-min') ? Number(opt('max-min')) : null,
  rustToolchain: opt('rust-toolchain', '1.98.1'),
};
const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// ---------- auth ----------
let tok = { v: '', exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1500) });
    if (r.ok) { const j = await r.json(); tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 }; return tok.v; }
  } catch { /* not on GCP */ }
  const v = execFileSync('gcloud', ['auth', 'print-access-token'], { shell: process.platform === 'win32' }).toString().trim();
  tok = { v, exp: Date.now() + 45 * 60000 };
  return v;
}
async function gapi(url, init = {}) {
  const { timeoutMs = 60000, ...rest } = init;
  const r = await fetch(url, { ...rest, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(rest.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: r.status, ok: r.ok, body };
}
const C = (p) => `https://compute.googleapis.com/compute/v1/projects/${CFG.project}/${p}`;
async function waitOp(op, zone) {
  const u = zone ? C(`zones/${zone}/operations/${op}/wait`) : C(`global/operations/${op}/wait`);
  // operations.wait holds up to ~2 min per call; image creation can take several calls.
  const deadline = Date.now() + 30 * 60000;
  while (Date.now() < deadline) {
    let r;
    try { r = await gapi(u, { method: 'POST', timeoutMs: 150000 }); } catch (e) { if (e.name === 'TimeoutError' || e.name === 'AbortError') continue; throw e; }
    if (r.body.status === 'DONE') return r.body.error ? r.body.error.errors.map((e) => `${e.code}: ${e.message}`).join('; ') : null;
    if (!r.ok && r.status !== 503) return `operation wait ${r.status}: ${r.body.error?.message || ''}`;
  }
  return 'operation wait timeout';
}

// ---------- lockfile ----------
async function gcsObject(name) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${CFG.bucket}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`gs://${CFG.bucket}/${name}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function secret(name) {
  const r = await gapi(`https://secretmanager.googleapis.com/v1/projects/${CFG.control}/secrets/${name}/versions/latest:access`);
  if (!r.ok) throw new Error(`secret ${name}: ${r.status}`);
  return Buffer.from(r.body.payload.data, 'base64').toString('utf8');
}
function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), pem).toString('base64url')}`;
}
async function githubFiles(files) {
  const jwt = appJwt((await secret('devcloud-runners-app-id')).trim(), await secret('devcloud-runners-app-key'));
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'devcloud-bake' };
  const inst = await (await fetch(`https://api.github.com/repos/${CFG.repo}/installation`, { headers: { ...h, Authorization: `Bearer ${jwt}` } })).json();
  if (!inst.id) throw new Error(`app not installed on ${CFG.repo}`);
  const t = await (await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, { method: 'POST', headers: { ...h, Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ repositories: [CFG.repo.split('/')[1]], permissions: { contents: 'read' } }) })).json();
  if (!t.token) throw new Error(`installation token (needs Contents: read on the App): ${t.message || ''}`);
  const out = {};
  for (const f of files) {
    const r = await fetch(`https://api.github.com/repos/${CFG.repo}/contents/${f}`, { headers: { ...h, Accept: 'application/vnd.github.raw', Authorization: `Bearer ${t.token}` } });
    if (!r.ok) throw new Error(`GET ${f}: ${r.status}`);
    out[f] = Buffer.from(await r.arrayBuffer());
  }
  return out;
}

// ---------- pure helpers (unit-tested) ----------
export function chunk(b64, size = 240000) {
  const out = [];
  for (let i = 0; i < b64.length; i += size) out.push(b64.slice(i, i + size));
  return out;
}
export function stamp(d = new Date()) { return d.toISOString().replace(/[-:T]/g, '').slice(0, 12); }
export function imagesToDelete(images, keep) {
  return [...images].filter((i) => i.status === 'READY' || i.status === 'FAILED')
    .sort((a, b) => Date.parse(b.creationTimestamp) - Date.parse(a.creationTimestamp)).slice(keep).map((i) => i.name);
}

// ---------- bake ----------
async function main() {
  const tc = TOOLCHAINS[CFG.toolchain];
  if (!tc) throw new Error(`unknown toolchain ${CFG.toolchain}`);
  const family = `devcloud-ci-${CFG.toolchain}`;
  const os = bakeOs(tc);
  const maxMin = CFG.maxMin ?? tc.maxMin ?? 45;
  const vm = `bake-${CFG.toolchain}-${stamp()}`.slice(0, 62);
  const items = [
    { key: os.startupKey, value: fs.readFileSync(path.join(HERE, os.script), 'utf8') },
    { key: 'toolchain', value: CFG.toolchain },
    { key: 'runner-version', value: CFG.runnerVersion },
    { key: 'pnpm-version', value: CFG.pnpmVersion },
    { key: 'serial-port-logging-enable', value: 'true' },
  ];
  if (tc.os === 'windows') items.push({ key: 'rust-toolchain', value: CFG.rustToolchain });
  let lockSha = null;
  if (tc.store) {
    let lock, ws;
    if (opt('lock')) { lock = fs.readFileSync(opt('lock')); ws = opt('workspace') ? fs.readFileSync(opt('workspace')) : null; }
    else {
      try { const f = await githubFiles(['pnpm-lock.yaml', 'pnpm-workspace.yaml']); lock = f['pnpm-lock.yaml']; ws = f['pnpm-workspace.yaml']; }
      catch (e) {
        // Fallback: the copy images.ps1 -Schedule uploads from codai origin/main (staler, still a warm store).
        log('bake.lock.github-failed', { err: String(e.message || e), fallback: `gs://${CFG.bucket}/images/` });
        lock = await gcsObject('images/pnpm-lock.yaml'); ws = await gcsObject('images/pnpm-workspace.yaml').catch(() => null);
      }
    }
    lockSha = crypto.createHash('sha256').update(lock).digest('hex').slice(0, 12);
    chunk(zlib.gzipSync(lock, { level: 9 }).toString('base64')).forEach((v, i) => items.push({ key: `lock-${i}`, value: v }));
    if (ws) items.push({ key: 'pnpm-workspace', value: ws.toString('utf8') });
  }
  log('bake.start', { toolchain: CFG.toolchain, family, vm, lockSha, metadataKb: Math.round(items.reduce((n, i) => n + i.value.length, 0) / 1024) });
  if (flag('dry-run')) { log('bake.dry-run'); return; }

  const t0 = Date.now();
  let zone = null; const attempts = [];
  for (const model of ['SPOT', 'STANDARD']) {
    for (const z of CFG.zones) {
      const body = {
        name: vm, machineType: `zones/${z}/machineTypes/${CFG.machine}`,
        disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: os.sourceImage, diskSizeGb: String(tc.diskGb), diskType: `zones/${z}/diskTypes/hyperdisk-balanced` } }],
        networkInterfaces: [{ network: 'global/networks/default', accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
        scheduling: { provisioningModel: model, instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: String((maxMin + 15 + os.stopWaitMin) * 60) }, automaticRestart: false, onHostMaintenance: 'TERMINATE' },
        serviceAccounts: [],
        labels: { purpose: 'ci-bake', owner: 'devcloud', toolchain: CFG.toolchain },
        metadata: { items },
      };
      const r = await gapi(C(`zones/${z}/instances`), { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) { attempts.push(`${z}/${model}: ${r.status} ${r.body.error?.message || ''}`); continue; }
      const err = await waitOp(r.body.name, z);
      if (!err) { zone = z; break; }
      attempts.push(`${z}/${model}: ${err}`);
    }
    if (zone) break;
  }
  if (!zone) throw new Error(`no capacity: ${attempts.join(' | ')}`);
  log('bake.vm.created', { vm, zone, sec: (Date.now() - t0) / 1000 });

  let result = null; let start = 0; let tail = ''; let all = '';
  const deadline = Date.now() + maxMin * 60000;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10000));
      const s = await gapi(C(`zones/${zone}/instances/${vm}/serialPort?port=1&start=${start}`));
      if (s.ok) {
        start = Number(s.body.next || start);
        const fresh = (s.body.contents || '').replace(/\r/g, '');
        all = (all + fresh).slice(-20000);
        for (const line of fresh.split('\n')) if (/::(step|android|store|image-setup|ver |warn|defender)/.test(line)) log('bake.serial', { line: line.replace(/^.*?(::)/, '::').slice(0, 200) });
        const text = tail + fresh;
        const m = text.match(/::image-setup (done|failed)([^\n]*)/);
        if (m) { result = m[1] === 'done' ? null : `setup failed${m[2]}`; break; }
        tail = text.slice(-300);
      } else if (s.status === 404) { throw new Error('bake VM disappeared (Spot preemption / max-run-duration)'); }
    }
    if (result === null && Date.now() >= deadline) result = `setup timeout after ${maxMin} min`;
    if (result) {
      const lines = all.split('\n').filter((l) => !/^\s*$/.test(l)).slice(-40);
      for (const l of lines) log('bake.serial.tail', { line: l.replace(/^.*?startup-script: /, '').slice(0, 300) });
      throw new Error(result);
    }
    // Windows: GCESysprep generalises and then powers off (several minutes).
    for (let i = 0; i < os.stopWaitMin * 12; i++) {
      const g = await gapi(C(`zones/${zone}/instances/${vm}`));
      if (g.body.status === 'TERMINATED') break;
      if (g.status === 404) throw new Error('bake VM deleted before imaging (Spot preemption?)');
      await new Promise((r) => setTimeout(r, 5000));
    }
    const name = `${family}-${stamp()}`;
    const img = {
      name, family, sourceDisk: `zones/${zone}/disks/${vm}`, storageLocations: ['eu'],
      labels: { owner: 'devcloud', toolchain: CFG.toolchain, ...(lockSha ? { lock: lockSha } : {}) },
      ...(tc.os === 'windows' ? { guestOsFeatures: [{ type: 'WINDOWS' }, { type: 'UEFI_COMPATIBLE' }, { type: 'VIRTIO_SCSI_MULTIQUEUE' }, { type: 'GVNIC' }, { type: 'MULTI_IP_SUBNET' }] } : {}),
      description: `devcloud CI runner image (${CFG.toolchain}); runner ${CFG.runnerVersion}, pnpm ${CFG.pnpmVersion}${tc.os === 'windows' ? `, rust ${CFG.rustToolchain}, Windows Server 2025` : ''}${lockSha ? `, pnpm store warmed from lock ${lockSha}` : ''}`,
    };
    const r = await gapi(C('global/images'), { method: 'POST', body: JSON.stringify(img) });
    if (!r.ok) throw new Error(`image create ${r.status}: ${r.body.error?.message || ''}`);
    const err = await waitOp(r.body.name);
    if (err) throw new Error(`image create: ${err}`);
    const got = await gapi(C(`global/images/${name}`));
    log('bake.image.ready', { image: name, family, diskSizeGb: got.body.diskSizeGb, archiveGb: Math.round(Number(got.body.archiveSizeBytes || 0) / 1e8) / 10, bakeSec: Math.round((Date.now() - t0) / 1000) });
  } finally {
    const d = await gapi(C(`zones/${zone}/instances/${vm}`), { method: 'DELETE' });
    log('bake.vm.deleted', { vm, ok: d.ok || d.status === 404 });
  }
  const list = await gapi(C(`global/images?filter=${encodeURIComponent(`family = "${family}"`)}`));
  for (const n of imagesToDelete(list.body.items || [], CFG.keep)) {
    const r = await gapi(C(`global/images/${n}`), { method: 'DELETE' });
    log('bake.image.pruned', { image: n, ok: r.ok });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { log('bake.failed', { err: String(e.message || e) }); process.exit(1); });
}
