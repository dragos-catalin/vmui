#!/usr/bin/env node
/**
 * vmui cloud browser tests — run Playwright (or any command) on an ephemeral GCE spot VM in
 * dragos-devcloud, never on the workstation (owner rule 2026-10-11; port of brivio/cursuri
 * scripts/e2e-cloud).
 *
 *   node scripts/e2e-cloud/run.mjs [playwright args…]            next build + start ON the VM, then playwright test
 *   node scripts/e2e-cloud/run.mjs --cmd "<shell>" --fetch test-results
 *                                                                  any command on the VM, copy dirs back
 *
 * Options: --machine <type> (default n2d-standard-8), --zone (default europe-central2-a),
 * --fetch <dir[,dir]> (repeatable; tarred back from the VM work dir), --keep (VM not deleted),
 * --no-wait (launch only), --attach <runId> (follow an existing run), --ledger (cost history),
 * --ref <rev> (baseline: app code from <rev>, harness files — scripts/e2e-cloud, tests/e2e,
 * playwright.config.ts, package.json, pnpm-lock.yaml — from the working tree).
 *
 * What travels: the WORKING TREE (tracked + untracked, minus .gitignore) via a throwaway git
 * index, so uncommitted edits are tested and the shared index is never touched. No secrets:
 * the VM generates its own VMUI_MASTER_KEY and seeds a throwaway SQLite DB.
 * Results land in .copilot-tmp/e2e-cloud/<runId>/ ; exit code = the VM command's exit code.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, ".copilot-tmp/e2e-cloud");
const LEDGER = join(TMP, "ledger.jsonl");
const PROJECT = process.env.VMUI_E2E_PROJECT ?? "dragos-devcloud";
const BUCKET = `vmui-e2e-runs-${PROJECT}`;
const SA = `vmui-e2e-runner@${PROJECT}.iam.gserviceaccount.com`;
const IMAGE_FAMILY = "vmui-e2e-runner";
const MAX_RUN = "2h";
const SPOT_USD_PER_HOUR = { "n2d-standard-4": 0.045, "n2d-standard-8": 0.09, "n2d-standard-16": 0.18 };
const vmName = (id) => `vmui-e2e-${id}`;
const runPath = (id) => `gs://${BUCKET}/runs/${id}`;

// ---------------------------------------------------------------- args --
const argv = process.argv.slice(2);
const own = new Map();
const fetchDirs = [];
const pw = [];
const VALUED = new Set(["machine", "zone", "cmd", "attach", "ref"]);
const BOOL = new Set(["keep", "no-wait", "ledger", "help"]);
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[i]);
  if (m && m[1] === "fetch") fetchDirs.push(...String(m[2] ?? argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
  else if (m && VALUED.has(m[1])) own.set(m[1], m[2] ?? argv[++i]);
  else if (m && BOOL.has(m[1])) own.set(m[1], true);
  else pw.push(argv[i]);
}
if (own.get("help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(0);
}
for (const d of fetchDirs) {
  if (!/^[\w./-]+$/.test(d) || d.includes("..")) {
    console.error(`--fetch: refusing path "${d}" (relative dirs only)`);
    process.exit(2);
  }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}\n${r.stderr ?? ""}`);
  return (r.stdout ?? "").trim();
}
const gcloud = (args, opts) => sh("gcloud", [...args, `--project=${PROJECT}`], opts);
const gsExists = (p) =>
  spawnSync("gcloud", ["storage", "ls", p, `--project=${PROJECT}`], { shell: process.platform === "win32", stdio: "ignore" }).status === 0;
const gsCat = (p) => gcloud(["storage", "cat", p], { allowFail: true, stdio: ["ignore", "pipe", "ignore"] });

if (own.get("ledger")) {
  if (!existsSync(LEDGER)) {
    console.log("no runs recorded yet");
    process.exit(0);
  }
  let usd = 0;
  for (const r of readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l))) {
    usd += r.usd ?? 0;
    console.log(`${r.at}  ${r.runId}  ${String(r.machine).padEnd(15)} ${String(r.seconds).padStart(5)}s  $${(r.usd ?? 0).toFixed(3)}  exit=${r.exit}`);
  }
  console.log(`~$${usd.toFixed(2)} total (spot list price estimate)`);
  process.exit(0);
}

if (!own.get("cmd") && !pw.some((a) => a.startsWith("--reporter"))) pw.push("--reporter=list,html");

const zone = own.get("zone") ?? "europe-central2-a";
const machine = own.get("machine") ?? "n2d-standard-8";
let runId = own.get("attach");
if (!runId) {
  runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12)}-${Math.random().toString(36).slice(2, 6)}`;
  launch();
}
process.exit(await follow(runId));

// ---------------------------------------------------------------- launch --
function launch() {
  mkdirSync(TMP, { recursive: true });
  const t0 = Date.now();
  const bundle = join(TMP, `${runId}.tgz`);
  const idx = join(TMP, `${runId}.index`);
  const genv = { ...process.env, GIT_INDEX_FILE: idx };
  const git = (a) =>
    execFileSync("git", ["-c", "core.safecrlf=false", ...a], { cwd: ROOT, env: genv, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] })
      .toString("utf8")
      .trim();
  let tree;
  try {
    const ref = own.get("ref");
    if (ref) {
      git(["read-tree", ref]);
      git(["add", "--all", "--", "scripts/e2e-cloud", "tests/e2e", "playwright.config.ts", "package.json", "pnpm-lock.yaml"]);
    } else {
      git(["read-tree", "HEAD"]);
      // .gitignore'd paths (node_modules/, .next/, .copilot-tmp/) are never added.
      git(["add", "--all", "--", "."]);
    }
    tree = git(["write-tree"]);
  } finally {
    rmSync(idx, { force: true });
  }
  const count = git(["ls-tree", "-r", "--name-only", tree]).split("\n").length;
  execFileSync("git", ["-c", "core.autocrlf=false", "archive", "--format=tar.gz", "-o", bundle, tree], { cwd: ROOT });
  const mb = (readFileSync(bundle).length / 1048576).toFixed(1);
  console.log(`▶ e2e-cloud ${runId}  machine=${machine} (spot, ${zone})  bundle=${count} files / ${mb} MB`);

  const run = runPath(runId);
  gcloud(["storage", "cp", "-q", bundle, `${run}/src.tgz`]);
  rmSync(bundle);

  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const startup = join(TMP, `${runId}.startup.sh`);
  writeFileSync(startup, readFileSync(join(ROOT, "scripts/e2e-cloud/vm-run.sh"), "utf8").replace(/\r\n/g, "\n"));
  const md = [
    `run-id=${runId}`,
    `bucket=${BUCKET}`,
    `pw-args=${b64(pw.map(q).join(" "))}`,
    `cmd=${b64(own.get("cmd") ?? "")}`,
    `fetch=${b64(fetchDirs.join(" "))}`,
    `keep=${own.get("keep") ? "1" : "0"}`,
  ].join(",");
  try {
    gcloud([
      // Name MUST start with vmui-e2e-: the runner SA may delete only VMs with that prefix
      // (IAM condition in provision.ps1), so any other name never self-deletes.
      "compute", "instances", "create", vmName(runId),
      `--zone=${zone}`, `--machine-type=${machine}`,
      `--image-family=${IMAGE_FAMILY}`, `--image-project=${PROJECT}`,
      "--boot-disk-size=50GB", "--boot-disk-type=pd-ssd",
      "--provisioning-model=SPOT", "--instance-termination-action=DELETE",
      `--max-run-duration=${MAX_RUN}`,
      `--service-account=${SA}`, "--scopes=cloud-platform",
      "--labels=purpose=e2e,owner=vmui",
      `--metadata=${md}`, `--metadata-from-file=startup-script=${startup}`,
    ]);
  } finally {
    rmSync(startup, { force: true });
  }
  console.log(`  VM ${vmName(runId)} created in ${((Date.now() - t0) / 1000).toFixed(0)} s — follow: node scripts/e2e-cloud/run.mjs --attach ${runId}`);
  if (own.get("no-wait")) process.exit(0);
}

function q(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function vmAlive(id) {
  const out = gcloud(
    ["compute", "instances", "list", `--filter=name=${vmName(id)}`, "--format=value(name,status)"],
    { allowFail: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  return out.length > 0 && !/TERMINATED|STOPPING/.test(out);
}

// ---------------------------------------------------------------- follow --
async function follow(id) {
  const run = runPath(id);
  const out = join(TMP, id);
  let shown = 0;
  const started = Date.now();
  let lastAlive = Date.now();
  let preempted = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const log = gsCat(`${run}/log`);
    if (log.length > shown) {
      process.stdout.write(log.slice(shown).replace(/^/gm, "  │ "));
      if (!log.endsWith("\n")) process.stdout.write("\n");
      shown = log.length;
    }
    if (gsExists(`${run}/exit-code`)) break;
    if (Date.now() - lastAlive > 120_000) {
      lastAlive = Date.now();
      if (!vmAlive(id)) {
        // exit-code may have landed between the two checks.
        if (gsExists(`${run}/exit-code`)) break;
        console.error(`✗ VM ${vmName(id)} is gone with no exit-code — spot preemption (or max-run-duration). Re-run.`);
        preempted = true;
        break;
      }
    }
    if (Date.now() - started > 2.2 * 3600_000) {
      console.error("✗ no exit-code after 2.2 h — VM hit max-run-duration");
      preempted = true;
      break;
    }
  }
  const code = preempted ? 1 : Number(gsCat(`${run}/exit-code`) || 1);
  const finalLog = gsCat(`${run}/log`);
  if (finalLog.length > shown) process.stdout.write(finalLog.slice(shown).replace(/^/gm, "  │ ") + "\n");
  mkdirSync(out, { recursive: true });
  if (finalLog) writeFileSync(join(out, "vm.log"), finalLog);
  for (const obj of ["report.tgz", "results.tgz", "fetch.tgz"]) {
    if (!gsExists(`${run}/${obj}`)) continue;
    const f = join(TMP, `${id}-${obj}`);
    gcloud(["storage", "cp", "-q", `${run}/${obj}`, f]);
    sh("tar", ["-xzf", f, "-C", out]);
    rmSync(f);
  }
  let meta = { runId: id, machine };
  try {
    meta = { ...meta, ...JSON.parse(gsCat(`${run}/meta.json`)) };
  } catch {
    /* VM died before writing it */
  }
  const usd = ((meta.seconds ?? 0) / 3600) * (SPOT_USD_PER_HOUR[meta.machine] ?? 0.09);
  appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...meta, exit: code, usd: Number(usd.toFixed(4)) }) + "\n");
  console.log(`${code === 0 ? "✓" : "✗"} exit=${code}  ${meta.seconds ?? "?"} s on ${meta.machine ?? "?"}  ~$${usd.toFixed(3)}  phases: ${meta.phases ?? "?"}`);
  console.log(`  results: ${out}`);
  return code;
}
