# devcloud — canonical plan (agentq v3 + cloud execution + own CI)

Single source of truth for this program. Tracker rows: [`TRACKER.csv`](TRACKER.csv) (same ids).
Owner: Dragos. Started 2026-10-11. Status legend: `todo` · `in-progress` · `done` (with evidence) · `blocked` (reason).

## Goal

Agents (VS Code Copilot Chat, Copilot CLI, codai apps) stop waiting in vain on the busy workstation:
agentq becomes a smart scheduler (lanes, priorities, overrides with a reason, hang watchdog,
learned placement) and can run typecheck / lint / tests / builds / E2E / dev servers on fast
cloud machines; long CI leaves GitHub-hosted minutes for our own runners on GCP. Personal
first (project `dragos-devcloud`), then the same contract in codai production (multi-tenant).

## Evidence that motivated it (agentq journal 2026-09-27 → 10-11, 33.8k events)

| Finding                                                              | Number                                    |
| -------------------------------------------------------------------- | ----------------------------------------- |
| build:machine waits > 10 s                                           | 983 waits, **102 h** total                |
| of which with < 2 holders (RAM/commit gate or reap lag, not the cap) | **49 h**                                  |
| build:<repo> held while waiting for build:machine                    | 969 runs, **96.5 h**                      |
| timeouts from run-build default `-TimeoutMin 25`                     | 58 of 71                                  |
| reaps (holder pid gone)                                              | 251                                       |
| lease expiries of live work (owner shell gone, work elsewhere)       | 24                                        |
| commit tickets without a commit and without a journaled reason       | ~695 (30 %)                               |
| land exit 7 / commit failures journaled                              | 0 (silent)                                |
| build holds per day at peak                                          | 21–26 h (both machine slots busy all day) |
| brivio release failure rate                                          | 54 %                                      |

Root design causes: strict FIFO, fixed cap 2 + binary RAM gate, repo ticket held while waiting for
the machine, liveness = pid alive (hung child never detected), hard-coded timeouts, no metrics.
Full audit: `E:\gh\codai\.copilot-tmp\aq-audit\` (scripts + outputs).

## Decisions (owner, 2026-10-11)

| #    | Decision                                                                                                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------ |
| D1   | New GCP project **`dragos-devcloud`**, billing **HAI Tips**, region **europe-central2**                                                                                                                                                                                                                                                 |
| D2   | Roles: **agentq** = local scheduler/CLI/runner-agent + job contract spec; **vmui** = cloud control plane (pools, images, Mac, UI/API/MCP, CI controller); **codai** = same contract later, multi-tenant (F5)                                                                                                                            |
| D3   | Execution: **warm per-repo workspaces** (c4d-highcpu-64-lssd + Hyperdisk, suspend/resume, warm pnpm/turbo/sccache/gradle) + **ephemeral spot pool** for E2E/CI                                                                                                                                                                          |
| D4   | Code sync: **git-delta** (base sha + binary patch incl. untracked) for jobs; live sync for dev servers (Syncthing 2.x preferred over unmaintained Mutagen 0.18 — research R4)                                                                                                                                                           |
| D5   | Placement: **automatic**, learned from history + local CPU/RAM/commit pressure; `-Where local                                                                                                                                                                                                                                           | cloud | auto`; override with `-Reason` |
| D6   | Agent rights: **lanes** (interactive/quick/gate/heavy/batch), **priority bump**, **burst lane**, **preempt batch**, all with mandatory `-Reason`, journaled, rate/TTL-limited; `propose` auto-applies when safe                                                                                                                         |
| D7   | CI: generalise brivio cloud-runners → **Cloud Run controller** (workflow_job webhook) → JIT VM from golden images per toolchain, optional warm pool; GitHub keeps YAML + short gates                                                                                                                                                    |
| D8   | Cache: **Turborepo remote cache self-hosted** (Cloud Run + GCS) + sccache-GCS + Gradle cache node + pnpm store baked in images                                                                                                                                                                                                          |
| D9   | Dev servers on the warm workspace, ports over Tailscale (MagicDNS) + local forward on the same port                                                                                                                                                                                                                                     |
| D10  | OS coverage: Linux, Windows (Server 2025 on c4-standard-16, on demand), Android (Gradle on Linux; emulators on C4 nested virt), macOS/iOS                                                                                                                                                                                               |
| D10a | macOS: **OSX-KVM on GCE for the owner only**, admin-only option in codai (vladulescu.catalin@gmail.com). Customers: **GitHub macos-26 per job + Scaleway Mac mini M4 pool with Tart**. Recorded risk: macOS EULA permits virtualisation only on Apple hardware; GCE nested macOS also has no Metal → no iOS Simulator GPU. See ADR-0003 |
| D11  | Metrics in **Postgres (Cloud SQL, personal project)**, surfaced in vmui UI + codai hub `/ops/agentq`; local journal rotated + synced                                                                                                                                                                                                    |
| D12  | agentq core rewritten in **TypeScript** (Node 24 daemon + CLI, local state `node:sqlite`, cloud queue **pg-boss 12**); PowerShell stays as compatible shim                                                                                                                                                                              |
| D13  | Dependency upgrade of codai = **separate goal** after phase 1 (Upgrade Migrator)                                                                                                                                                                                                                                                        |
| D14  | Cost safety: idle auto-stop 15 min, `max-run-duration` on every VM, budget alert via Brivio mail, daily per-job cost report                                                                                                                                                                                                             |
| D15  | Order: F1 agentq smart local → F2 cache + warm workspaces → F3 CI controller → F4 dev servers + Windows/Mac/Android pools → F5 vmui UI + codai prod                                                                                                                                                                                     |
| D16  | GitHub App `devcloud-runners`: I generate manifest + script; owner clicks Create + Install once                                                                                                                                                                                                                                         |
| D17  | Tailscale OAuth client (`auth_keys`, `tag:devcloud`) in Secret Manager; ephemeral nodes + `tailscale serve`                                                                                                                                                                                                                             |
| D18  | brivio/cursuri cloud runners kept; agentq `-Where cloud` adapter uses them; cursuri migrates first, brivio after the platform is proven                                                                                                                                                                                                 |
| D19  | PreToolUse hook rewrites heavy build/test/lint into `agentq run -Where auto` (explicit opt-out) + rule + skill                                                                                                                                                                                                                          |

## Architecture

```
 agent (VS Code / CLI / codai app)
        │  agentq run -Lane gate -Where auto -Purpose .. -- pnpm typecheck
        ▼
 agentq (local)  ── lanes, priorities, aging, overrides(-Reason), watchdog, pressure gate
   │ local slot? ──────────────► run here (BelowNormal, log, progress watchdog)
   │ cloud better? (history p50, pressure, cold-start estimate)
   ▼
 job contract (spec/job.md, versioned)  {repo, baseSha, patch, cmd, lane, toolchain, timeout}
   ▼
 devcloud control plane (vmui)  ── Cloud SQL (pg-boss queue + metrics), GCS (patches, logs, caches)
   ├─ warm workspace per repo (c4d-highcpu-64-lssd, Hyperdisk, suspend/resume) ── runner-agent claims jobs
   ├─ ephemeral spot pool (E2E, CI)            ── golden images per toolchain (family per image)
   ├─ windows pool (c4-standard-16, WS2025)    ── on demand
   ├─ android emulator pool (c4 nested virt)   ── on demand
   ├─ mac (owner: OSX-KVM on GCE; customers: GH macos-26 + Scaleway M4/Tart)
   ├─ turbo remote cache (Cloud Run + GCS), sccache GCS, gradle cache node
   └─ ci-controller (Cloud Run, GitHub App webhook workflow_job → JIT runner VM)
 results → log stream + exit code back to the agent; metrics row per job → placement model learns
```

## Phases and scope

- **F1 — agentq smart local** (this session): lanes + priority + aging; overrides (`bump`, `burst`,
  `propose`) with reason, TTL and per-session rate limit; progress watchdog (log/CPU growth) marks
  HUNG; no build:<repo> held while waiting for the machine (per-worktree build scope); configurable
  caps/timeouts; journal: `acquired` (waitSec) + `holdSec`, commit-attempt and land/exit-7 reasons;
  journal rotation; `agentq metrics`. Tests + install + live verification.
- **F2 — cloud foundation**: project, IAM, network, Cloud SQL, buckets, Secret Manager, budget;
  Turbo remote cache live and wired in codai/brivio; golden image `node24`; warm workspace codai;
  `agentq run -Where cloud`; TS daemon skeleton on the job contract.
- **F3 — CI controller**: GitHub App, controller on Cloud Run, images per toolchain, migrate long
  workflows (codai verify, metu, mmo…), keep only < 30 s gates on GitHub-hosted.
- **F4 — dev servers + OS pools**: Syncthing/forward, Windows pool, Android emulator pool, Mac.
- **F5 — vmui UI/API/MCP + codai production** (admin-only Mac option).

## Ideas recommended (nice to have, ranked)

1. **Dynamic execution race** (Bazel-style): for short jobs run local + cloud, keep the first.
2. **Speculative pre-warm**: resume the repo's workspace when an agent starts editing (hook on first
   write), so the first gate has zero cold start.
3. **Affected-only gates**: turbo `--affected` against the job's base sha everywhere by default.
4. **Flake ledger**: tests that fail then pass on retry are recorded; quarantine list per repo.
5. **Gate result reuse**: same tree hash + same command = return the cached exit code + log.
6. **Cost/time dashboard** per repo, per agent, per lane (hub + vmui).
7. **Budget-aware lanes for codai customers** (wallet holds, as CDE billing does).
8. **Pre-push in the cloud**: land gates run on the warm workspace instead of the land slot.

## Research notes

[`RESEARCH.md`](RESEARCH.md) — runners/pricing, remote cache, sandboxes, sync, machines, schedulers,
macOS, images, Tailscale, with sources.
