// devcloud ci-controller (DC-041): GitHub App webhook `workflow_job` -> one JIT runner VM per job.
// queued      -> JIT runner config (GitHub App installation token) + GCE VM (Spot, falls back to
//                Standard across zones), record ci/vms/<vm>.json
// in_progress -> note which runner picked the job
// completed   -> delete that runner's VM, write ci/jobs/<id>.json with duration + cost
// janitor     -> every webhook (max once / 5 min) deletes gha-* VMs that are TERMINATED (powered
//                off after their job) or older than MAX_RUN_SEC + 10 min.
// fallback    -> no capacity, or a Spot VM preempted mid-job: cancel the run and re-run its failed
//                jobs once with devcloud disabled for that attempt (DC-043; App needs Actions: write).
//                The workflow's gate probes GET /health `capacityOk` and picks ubuntu-latest itself
//                when the controller is down or saw no capacity in the last CAPACITY_WINDOW_MIN.
//                Gate-free repos (DC-046, FALLBACK_VAR_REPOS): before the re-run the controller sets the
//                repo variable DEVCLOUD_FALLBACK=1, which their runs-on reads (a full re-run sees the new
//                value, verified 2026-10-14); the next successful VM create clears it again.
//                App needs Variables: write on those repos.
// No npm dependencies: node:http, node:crypto, global fetch. Credentials: the Cloud Run SA via the
// metadata server; GitHub App id/key/webhook secret from Secret Manager (read lazily, cached).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] ?? d;
export const CFG = {
  project: env('CONTROL_PROJECT', 'dragos-devcloud'),
  runnerProject: env('RUNNER_PROJECT', 'codai-training'),
  zones: env('RUNNER_ZONES', 'europe-west4-a,europe-west4-b,europe-west4-c').split(','),
  // Default owner for calls that carry no repo; every job uses its own repo's owner (multi-org, DC-043).
  org: env('GH_ORG', 'codai-ro'),
  allowRepos: env('ALLOW_REPOS', 'codai-ro/codai-cc').split(','),
  // Repos whose workflows have no hosted gate and read vars.DEVCLOUD_FALLBACK in runs-on (DC-046).
  fallbackVarRepos: env('FALLBACK_VAR_REPOS', '').split(',').filter(Boolean),
  bucket: env('BUCKET', 'dragos-devcloud-devcloud-jobs'),
  runnerGroupId: Number(env('RUNNER_GROUP_ID', '1')),
  runnerVersion: env('RUNNER_VERSION', '2.338.0'),
  maxRunSec: Number(env('MAX_RUN_SEC', '7200')),
  idleMin: Number(env('IDLE_MIN', '20')),
  capacityWindowMin: Number(env('CAPACITY_WINDOW_MIN', '30')),
  imageProject: env('IMAGE_PROJECT', env('RUNNER_PROJECT', 'codai-training')),
  secretAppId: env('SECRET_APP_ID', 'devcloud-runners-app-id'),
  secretKey: env('SECRET_APP_KEY', 'devcloud-runners-app-key'),
  secretHook: env('SECRET_WEBHOOK', 'devcloud-runners-webhook-secret'),
};

// label -> VM shape + image family (DC-042, baked by infra/devcloud/images/bake.mjs in the runner
// project). A label `devcloud-<toolchain>` next to the size label picks another family, e.g.
// [self-hosted, devcloud-linux-16, devcloud-android-jdk21]. No baked image -> stock Ubuntu + the
// startup script's bootstrap. USD/hour = on-demand list rates europe-west4 (vCPU + GB RAM + disk
// GB-month), configured, not fetched: the job record says `costSource: "configured-rate"`.
export const PROFILES = {
  // Short jobs (1-5 min: lint gates, release helpers, crons). 50 GB = the baked images are 40 GB.
  'devcloud-linux-4': { machine: 'c4d-highcpu-4', vcpu: 4, memGb: 7, diskGb: 50, diskType: 'hyperdisk-balanced', toolchain: 'node24' },
  'devcloud-linux-16': { machine: 'c4d-highcpu-16', vcpu: 16, memGb: 30, diskGb: 100, diskType: 'hyperdisk-balanced', toolchain: 'node24' },
  'devcloud-linux-32': { machine: 'c4d-highcpu-32', vcpu: 32, memGb: 60, diskGb: 150, diskType: 'hyperdisk-balanced', toolchain: 'node24' },
};
export const TOOLCHAINS = ['node24', 'android-jdk21', 'rust-tauri-linux', 'rust-tauri-win', 'python-uv', 'flutter', 'polyglot'];
const STOCK_IMAGE = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64';
export const RATES = JSON.parse(env('RATES_JSON', JSON.stringify({
  // c4d europe-west4 list prices (USD): vCPU-h, GB-h; Spot = separate rates; hyperdisk-balanced GB-month
  STANDARD: { vcpu: 0.0418, mem: 0.0047 },
  SPOT: { vcpu: 0.0167, mem: 0.0019 },
  diskGbMonth: 0.08,
})));

const log = (severity, msg, extra = {}) => console.log(JSON.stringify({ severity, msg, ...extra }));

// ---------- pure helpers (unit-tested) ----------
export function verifySignature(secret, raw, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Dependabot "Labeled runner" (repo setting, no API) queues its update job with ONLY this label.
export const DEPENDABOT_LABEL = 'devcloud-dependabot';
export function pickProfile(labels) {
  const l = (labels || []).map((x) => String(x).toLowerCase());
  if (l.length === 1 && l[0] === DEPENDABOT_LABEL) return { label: 'devcloud-linux-4', ...PROFILES['devcloud-linux-4'], toolchain: 'node24' };
  if (!l.includes('self-hosted')) return null;
  const name = l.find((x) => PROFILES[x]);
  if (!name) return null;
  const tc = l.map((x) => x.replace(/^devcloud-/, '')).find((x) => TOOLCHAINS.includes(x));
  return { label: name, ...PROFILES[name], ...(tc ? { toolchain: tc } : {}) };
}

export function imageFamily(profile, project = CFG.imageProject) {
  return `projects/${project}/global/images/family/devcloud-ci-${profile.toolchain}`;
}

// Seconds from VM create to "runner online", parsed from the startup script's serial markers.
export function bootSecFromSerial(text) {
  const m = /::runner-online (\d+)s/.exec(text || '');
  return m ? Number(m[1]) : null;
}

// Re-run guard: only the FIRST attempt of a run falls back; a re-run that fails again stays failed.
export function shouldFallback(job, reason) {
  if (!job || Number(job.run_attempt || 1) > 1) return false;
  return reason === 'no-capacity' || reason === 'preempted';
}

export function rerunPath(runId) { return `/actions/runs/${runId}/rerun`; }

export const FALLBACK_VAR = 'DEVCLOUD_FALLBACK';
/** PATCH-then-POST plan for a repo variable: [method, path, body] (POST creates when PATCH is 404). */
export function fallbackVarRequests(value) {
  const body = { name: FALLBACK_VAR, value: String(value) };
  return { patch: ['PATCH', `/actions/variables/${FALLBACK_VAR}`, body], create: ['POST', '/actions/variables', body] };
}
export function usesFallbackVar(repo, list = CFG.fallbackVarRepos) { return list.includes(repo); }

export function isAbort(e) { return e?.name === 'TimeoutError' || e?.name === 'AbortError'; }

export function costUsd(profile, model, seconds) {
  const r = RATES[model] || RATES.STANDARD;
  const h = Math.max(0, seconds) / 3600;
  const compute = h * (profile.vcpu * r.vcpu + profile.memGb * r.mem);
  const disk = h * profile.diskGb * (RATES.diskGbMonth / 730);
  return Math.round((compute + disk) * 1e6) / 1e6;
}

export function vmName(jobId) { return `gha-${jobId}`; }

/** `brivio-ro/brivio` -> `brivio-ro`; the App installation + org runner registration live on that owner. */
export function ownerOf(repo, fallback = CFG.org) {
  const o = String(repo || '').split('/')[0];
  return o || fallback;
}

export function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), pem).toString('base64url')}`;
}

// ---------- GCP via metadata server ----------
let gtok = { v: '', exp: 0 };
async function gcpToken() {
  if (gtok.v && Date.now() < gtok.exp) return gtok.v;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error(`metadata token ${r.status}`);
  const j = await r.json();
  gtok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return gtok.v;
}
async function gapi(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await gcpToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: r.status, ok: r.ok, body };
}
const secrets = new Map();
async function secret(name) {
  const hit = secrets.get(name);
  if (hit && Date.now() - hit.at < 600000) return hit.v;
  const r = await gapi(`https://secretmanager.googleapis.com/v1/projects/${CFG.project}/secrets/${name}/versions/latest:access`);
  if (!r.ok) throw new Error(`secret ${name}: ${r.status}`);
  const v = Buffer.from(r.body.payload.data, 'base64').toString('utf8');
  secrets.set(name, { v, at: Date.now() });
  return v;
}
const gcs = {
  put: (o, doc) => gapi(`https://storage.googleapis.com/upload/storage/v1/b/${CFG.bucket}/o?uploadType=media&name=${encodeURIComponent(o)}`, { method: 'POST', body: JSON.stringify(doc, null, 1) }),
  get: async (o) => { const r = await gapi(`https://storage.googleapis.com/storage/v1/b/${CFG.bucket}/o/${encodeURIComponent(o)}?alt=media`); return r.ok ? r.body : null; },
};

// ---------- GitHub App ----------
const itoks = new Map(); // owner -> { v, exp }
async function installationToken(owner = CFG.org) {
  const hit = itoks.get(owner);
  if (hit && Date.now() < hit.exp) return hit.v;
  const jwt = appJwt((await secret(CFG.secretAppId)).trim(), await secret(CFG.secretKey));
  const h = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'devcloud-ci-controller' };
  const inst = await (await fetch(`https://api.github.com/orgs/${owner}/installation`, { headers: h })).json();
  if (!inst.id) throw new Error(`app not installed on ${owner}: ${inst.message || ''}`);
  const t = await (await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, { method: 'POST', headers: h })).json();
  if (!t.token) throw new Error(`installation token: ${t.message || ''}`);
  itoks.set(owner, { v: t.token, exp: Date.parse(t.expires_at) - 300000 });
  return t.token;
}
async function jitConfig(name, labels, owner = CFG.org) {
  const r = await fetch(`https://api.github.com/orgs/${owner}/actions/runners/generate-jitconfig`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await installationToken(owner)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'devcloud-ci-controller' },
    body: JSON.stringify({ name, runner_group_id: CFG.runnerGroupId, labels: [...new Set([...labels, 'linux', 'x64'])], work_folder: '_work' }),
  });
  const j = await r.json();
  if (r.status === 409) return null; // runner with this name exists = redelivery
  if (!j.encoded_jit_config) throw new Error(`jitconfig ${r.status}: ${j.message || ''}`);
  return j.encoded_jit_config;
}

// ---------- VMs ----------
const STARTUP = fs.readFileSync(path.join(HERE, 'runner-startup.sh'), 'utf8');
const C = (p) => `https://compute.googleapis.com/compute/v1/projects/${CFG.runnerProject}/${p}`;

async function waitOp(zone, op) {
  for (let i = 0; i < 40; i++) {
    // operations.wait can hold the request longer than gapi's 30 s abort (2026-10-12: release-phone job
    // 114739261211 got a running VM but no record -> never deleted by `completed`). An abort = keep waiting.
    let r;
    try { r = await gapi(C(`zones/${zone}/operations/${op}/wait`), { method: 'POST' }); } catch (e) {
      if (isAbort(e)) continue;
      throw e;
    }
    if (r.body.status === 'DONE') return r.body.error ? r.body.error.errors?.map((e) => e.code + ': ' + e.message).join('; ') : null;
  }
  return 'operation wait timeout';
}

async function createVm(name, profile, jit, job) {
  const attempts = [];
  const fam = imageFamily(profile);
  const img = await gapi(`https://compute.googleapis.com/compute/v1/${fam}`);
  const sourceImage = img.ok ? img.body.selfLink : STOCK_IMAGE;
  const baked = img.ok;
  for (const model of ['SPOT', 'STANDARD']) {
    for (const zone of CFG.zones) {
      const sched = { provisioningModel: model, instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: String(CFG.maxRunSec) }, automaticRestart: false, onHostMaintenance: 'TERMINATE' };
      const body = {
        name,
        machineType: `zones/${zone}/machineTypes/${profile.machine}`,
        disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage, diskSizeGb: String(profile.diskGb), diskType: `zones/${zone}/diskTypes/${profile.diskType}` } }],
        networkInterfaces: [{ network: 'global/networks/default', accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
        scheduling: sched,
        // No service account: the job VM holds no GCP credentials at all.
        serviceAccounts: [],
        labels: { purpose: 'ci', owner: 'devcloud', job: String(job.id), repo: job.repo.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 60) },
        metadata: { items: [
          { key: 'startup-script', value: STARTUP },
          { key: 'jit-config', value: jit },
          { key: 'idle-minutes', value: String(CFG.idleMin) },
          { key: 'runner-version', value: CFG.runnerVersion },
        ] },
      };
      const r = await gapi(C(`zones/${zone}/instances`), { method: 'POST', body: JSON.stringify(body) });
      if (r.status === 409) return { zone, model, existed: true, attempts, image: sourceImage, baked };
      if (!r.ok) { attempts.push(`${zone}/${model}: ${r.status} ${r.body.error?.message || ''}`); continue; }
      const err = await waitOp(zone, r.body.name);
      if (!err) return { zone, model, attempts, image: sourceImage, baked };
      attempts.push(`${zone}/${model}: ${err}`);
    }
  }
  const e = new Error(`no capacity: ${attempts.join(' | ')}`); e.code = 'no-capacity'; throw e;
}

async function deleteVm(name, zone) {
  const r = await gapi(C(`zones/${zone}/instances/${name}`), { method: 'DELETE' });
  return r.ok || r.status === 404;
}

async function serialText(name, zone) {
  const r = await gapi(C(`zones/${zone}/instances/${name}/serialPort?port=1`));
  return r.ok ? String(r.body.contents || '') : '';
}

// ---------- capacity state (GET /health -> capacityOk) ----------
const capacity = { lastFailAt: 0, lastOkAt: 0, lastError: '' };
let capLoaded = false;
async function loadCapacity() {
  if (capLoaded) return; capLoaded = true;
  const s = await gcs.get('ci/state/capacity.json').catch(() => null);
  if (s) Object.assign(capacity, s);
}
async function noteCapacity(ok, err = '') {
  await loadCapacity().catch(() => {});
  if (ok) capacity.lastOkAt = Date.now(); else { capacity.lastFailAt = Date.now(); capacity.lastError = String(err).slice(0, 500); }
  await gcs.put('ci/state/capacity.json', capacity).catch(() => {});
}
export function capacityOk(state, now = Date.now(), windowMin = CFG.capacityWindowMin) {
  return !state.lastFailAt || now - state.lastFailAt > windowMin * 60000 || state.lastOkAt > state.lastFailAt;
}

// ---------- GitHub fallback: cancel + re-run on GitHub-hosted ----------
async function ghRepo(method, repo, p, body) {
  const r = await fetch(`https://api.github.com/repos/${repo}${p}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${await installationToken(ownerOf(repo))}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'devcloud-ci-controller' },
  });
  return { status: r.status, ok: r.ok, body: r.status === 204 ? {} : await r.json().catch(() => ({})) };
}
async function fallbackToGithub(job, reason) {
  if (!shouldFallback(job, reason)) { log('INFO', 'ci.fallback.skipped', { job: job.id, run: job.run_id, attempt: job.run_attempt, reason }); return; }
  // The workflow reads this in its gate: a re-run attempt whose marker exists runs on ubuntu-latest.
  await gcs.put(`ci/fallback/${job.run_id}.json`, { run: job.run_id, job: job.id, reason, at: new Date().toISOString() });
  await setFallbackVar(job.repo, '1').catch((e) => log('ERROR', 'ci.fallback.var.failed', { repo: job.repo, err: String(e.message || e) }));
  const c = await ghRepo('POST', job.repo, `/actions/runs/${job.run_id}/cancel`);
  for (let i = 0; i < 24; i++) {
    const r = await ghRepo('GET', job.repo, `/actions/runs/${job.run_id}`);
    if (r.body.status === 'completed') break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  // Re-run the WHOLE run, not rerun-failed-jobs: the gate job succeeded in attempt 1 and GitHub splices its
  // stale outputs (runner=devcloud) into a failed-jobs re-run (actions/runner#1961), so verify would ask for a
  // self-hosted runner again and sit queued. A full re-run makes the gate read GET /fallback/<run> on attempt 2.
  const rr = await ghRepo('POST', job.repo, rerunPath(job.run_id));
  log(rr.ok ? 'INFO' : 'ERROR', 'ci.fallback.rerun', { job: job.id, run: job.run_id, reason, cancel: c.status, rerun: rr.status, msg: rr.body.message || '' });
}
// Repo variable read by gate-free workflows: '1' = run on ubuntu-latest, '0' = devcloud. Best effort:
// a failure is logged, never thrown (the webhook must not fail because of it).
const fallbackVarState = new Map(); // repo -> last value written by this instance
async function setFallbackVar(repo, value) {
  if (!usesFallbackVar(repo)) return;
  if (fallbackVarState.get(repo) === String(value)) return;
  const { patch, create } = fallbackVarRequests(value);
  let r = await ghRepo(...[patch[0], repo, patch[1], patch[2]]);
  if (r.status === 404) r = await ghRepo(create[0], repo, create[1], create[2]);
  if (r.ok) fallbackVarState.set(repo, String(value));
  log(r.ok ? 'INFO' : 'ERROR', 'ci.fallback.var', { repo, value: String(value), status: r.status, msg: r.body.message || '' });
}

export async function fallbackFor(runId) {
  return gcs.get(`ci/fallback/${runId}.json`);
}

// ---------- webhook handlers ----------
async function onQueued(p) {
  const job = { id: p.workflow_job.id, run: p.workflow_job.run_id, run_id: p.workflow_job.run_id, run_attempt: p.workflow_job.run_attempt, name: p.workflow_job.name, repo: p.repository.full_name, labels: p.workflow_job.labels };
  const profile = pickProfile(job.labels);
  const name = vmName(job.id);
  const t0 = Date.now();
  const jit = await jitConfig(name, job.labels, ownerOf(job.repo));
  if (!jit) { log('INFO', 'ci.queued.duplicate', { job: job.id, vm: name }); return; }
  let vm;
  try { vm = await createVm(name, profile, jit, job); } catch (e) {
    if (e.code === 'no-capacity') { await noteCapacity(false, e.message); await fallbackToGithub(job, 'no-capacity'); }
    throw e;
  }
  await noteCapacity(true);
  // Capacity is back: gate-free repos return to devcloud for their next run.
  await setFallbackVar(job.repo, '0').catch((e) => log('ERROR', 'ci.fallback.var.failed', { repo: job.repo, err: String(e.message || e) }));
  const rec = { vm: name, job: job.id, run: job.run, attempt: job.run_attempt, repo: job.repo, jobName: job.name, label: profile.label, toolchain: profile.toolchain, image: vm.image, baked: vm.baked, machine: profile.machine, zone: vm.zone, model: vm.model, createdAt: new Date().toISOString(), createSec: (Date.now() - t0) / 1000, attempts: vm.attempts };
  await gcs.put(`ci/vms/${name}.json`, rec);
  log('INFO', 'ci.vm.created', rec);
}

async function onCompleted(p) {
  const wj = p.workflow_job;
  const runner = wj.runner_name || '';
  const vmRec = runner.startsWith('gha-') ? await gcs.get(`ci/vms/${runner}.json`) : null;
  const now = new Date();
  let deleted = false;
  let bootSec = null; let preempted = false;
  if (vmRec && !vmRec.deletedAt) {
    bootSec = bootSecFromSerial(await serialText(runner, vmRec.zone).catch(() => ''));
    // Spot preemption: the instance is gone/terminated by GCE while the job did not succeed.
    if (vmRec.model === 'SPOT' && wj.conclusion !== 'success' && wj.conclusion !== 'cancelled') {
      const g = await gapi(C(`zones/${vmRec.zone}/operations?filter=${encodeURIComponent(`(targetLink eq ".*/instances/${runner}") AND (operationType eq "compute.instances.preempted")`)}`));
      preempted = (g.body.items || []).length > 0;
    }
    deleted = await deleteVm(runner, vmRec.zone);
    vmRec.deletedAt = now.toISOString();
    vmRec.bootSec = bootSec;
    await gcs.put(`ci/vms/${runner}.json`, vmRec);
  }
  const prof = vmRec ? PROFILES[vmRec.label] : null;
  const vmSec = vmRec ? (now - Date.parse(vmRec.createdAt)) / 1000 : null;
  const jobSec = wj.started_at && wj.completed_at ? (Date.parse(wj.completed_at) - Date.parse(wj.started_at)) / 1000 : null;
  const queueSec = wj.created_at && wj.started_at ? (Date.parse(wj.started_at) - Date.parse(wj.created_at)) / 1000 : null;
  const rec = {
    job: wj.id, run: wj.run_id, repo: p.repository.full_name, jobName: wj.name, workflow: wj.workflow_name, conclusion: wj.conclusion,
    attempt: wj.run_attempt ?? null,
    runner, vm: vmRec?.vm ?? null, machine: vmRec?.machine ?? null, zone: vmRec?.zone ?? null, model: vmRec?.model ?? null,
    toolchain: vmRec?.toolchain ?? null, image: vmRec?.image ?? null, baked: vmRec?.baked ?? null,
    queueSec, jobSec, vmSec, bootSec, preempted, vmDeleted: deleted,
    costUsd: prof ? costUsd(prof, vmRec.model, vmSec) : null, costSource: 'configured-rate',
    recordedAt: now.toISOString(),
  };
  await gcs.put(`ci/jobs/${wj.id}.json`, rec);
  log('INFO', 'ci.job.completed', rec);
  if (preempted) await fallbackToGithub({ id: wj.id, run_id: wj.run_id, run_attempt: wj.run_attempt, repo: p.repository.full_name }, 'preempted');
}

let lastJanitor = 0;
async function janitor() {
  if (Date.now() - lastJanitor < 300000) return;
  lastJanitor = Date.now();
  for (const zone of CFG.zones) {
    const r = await gapi(C(`zones/${zone}/instances?filter=${encodeURIComponent('name eq "gha-.*"')}`));
    for (const vm of r.body.items || []) {
      const ageSec = (Date.now() - Date.parse(vm.creationTimestamp)) / 1000;
      if (vm.status === 'TERMINATED' || ageSec > CFG.maxRunSec + 600) {
        const ok = await deleteVm(vm.name, zone);
        log('INFO', 'ci.janitor.delete', { vm: vm.name, zone, status: vm.status, ageSec: Math.round(ageSec), ok });
      }
    }
  }
}

export async function handle(event, payload) {
  if (event === 'ping') return { status: 200, body: 'pong' };
  if (event !== 'workflow_job') return { status: 202, body: 'ignored event' };
  const repo = payload.repository?.full_name;
  if (!CFG.allowRepos.includes(repo)) return { status: 202, body: 'repo not allowed' };
  if (!pickProfile(payload.workflow_job?.labels)) return { status: 202, body: 'not a devcloud job' };
  const work = payload.action === 'queued' ? onQueued(payload)
    : payload.action === 'completed' ? onCompleted(payload)
    : payload.action === 'in_progress' ? Promise.resolve(log('INFO', 'ci.job.started', { job: payload.workflow_job.id, runner: payload.workflow_job.runner_name }))
    : Promise.resolve();
  // Answer GitHub at once (10 s limit); the service runs with CPU always allocated.
  work.catch((e) => log('ERROR', `ci.${payload.action}.failed`, { job: payload.workflow_job.id, err: String(e.message || e) }))
    .finally(() => janitor().catch((e) => log('WARNING', 'ci.janitor.failed', { err: String(e.message || e) })));
  return { status: 202, body: 'accepted' };
}

// ---------- HTTP ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        await loadCapacity().catch(() => {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rev: process.env.K_REVISION || 'local', capacityOk: capacityOk(capacity), fallbackVarRepos: CFG.fallbackVarRepos, lastCapacityFailAt: capacity.lastFailAt ? new Date(capacity.lastFailAt).toISOString() : null }));
        return;
      }
      // Gate probe for a re-run attempt: did the controller fall this run back to GitHub-hosted?
      const fb = req.method === 'GET' && /^\/fallback\/(\d+)$/.exec(req.url || '');
      if (fb) { const f = await fallbackFor(fb[1]); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ fallback: !!f, reason: f?.reason ?? null })); return; }
      if (req.method !== 'POST' || req.url !== '/webhook') { res.writeHead(404); res.end(); return; }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(c); }
      const raw = Buffer.concat(chunks);
      if (!verifySignature(await secret(CFG.secretHook), raw, req.headers['x-hub-signature-256'])) {
        log('WARNING', 'ci.webhook.bad_signature', { delivery: req.headers['x-github-delivery'] || '' });
        res.writeHead(401); res.end('bad signature'); return;
      }
      const out = await handle(String(req.headers['x-github-event'] || ''), JSON.parse(raw.toString('utf8')));
      res.writeHead(out.status, { 'content-type': 'text/plain' }); res.end(out.body);
    } catch (e) {
      log('ERROR', 'ci.webhook.error', { err: String(e.message || e) });
      res.writeHead(500); res.end('error');
    }
  }).listen(Number(process.env.PORT || 8080), () => log('INFO', 'ci.controller.listening', { port: process.env.PORT || 8080 }));
}
