# devcloud CI runners (F3: DC-040..043)

GitHub keeps the workflow YAML and the short gates; long jobs run on a one-shot GCE VM that the
**ci-controller** (Cloud Run `ci-controller`, dragos-devcloud/europe-west4) creates from the GitHub App
`devcloud-runners` `workflow_job` webhook and deletes when the job completes.

## Flow

1. A job asks for `runs-on: [self-hosted, devcloud-linux-16]` (or `-32`), optionally plus a toolchain label
   `devcloud-<toolchain>` (default `node24`).
2. `queued` webhook -> JIT runner config -> VM `gha-<jobId>` in `codai-training` (Spot, then Standard,
   across europe-west4-a/b/c), image family `devcloud-ci-<toolchain>`; stock Ubuntu 24.04 + bootstrap if the
   family has no image. The VM has **no service account**.
3. `completed` webhook -> VM deleted, record `gs://dragos-devcloud-devcloud-jobs/ci/jobs/<jobId>.json`
   (queueSec, bootSec, jobSec, vmSec, model, preempted, costUsd at configured rates).
4. Janitor deletes TERMINATED or over-age `gha-*` VMs; `max-run-duration` (DELETE) is the backstop.

## Repos and orgs (multi-org)

The controller serves every repo in `ALLOW_REPOS` (`ci-controller.ps1 -AllowRepos 'a/b;c/d'`); the installation
token and the org JIT runner registration come from the job repo's OWNER, so each org needs the App
`devcloud-runners` installed (the App is public for that; unknown repos are still refused by `ALLOW_REPOS`).
Onboarding an org: install the App (Actions RW, org self-hosted runners RW, Contents R) -> add the repo to
`-AllowRepos` -> redeploy -> repo variable `DEVCLOUD_CI_CONTROLLER_URL` -> gate job as in codai `ci.yml` /
`release-phone.yml`. The org's default runner group must allow the repo (private repos: default yes).
User accounts (dragoscv/*) have no org runners: not supported (repo-level JIT needs Administration: write).

brivio (ADR-0278): ci.yml, e2e-nightly.yml, a11y-nightly ibm and release-android use the same gate (brivio f5aa05277).
A repo WITHOUT hosted minutes cannot run a gate job either: it must ask for `[self-hosted, devcloud-linux-16|32]` directly
and gets no ubuntu-latest fallback (brivio did that 2026-10-12..14 while its org had no payment method; linking billing
information to an org shares only the address, the card must be added on the org's own payment page). Job `services:`
containers work: Docker is in every image (DC-045).

## No gate job: repo variable DEVCLOUD_FALLBACK (DC-046)

A repo listed in the controller's `FALLBACK_VAR_REPOS` (brivio since 2026-10-14) has no hosted gate job at all:

```yaml
runs-on: ${{ (inputs.runner == 'github' || vars.DEVCLOUD_FALLBACK == '1') && 'ubuntu-latest' || fromJSON('["self-hosted","devcloud-linux-16","devcloud-node24"]') }}
```

- `vars` and `inputs` are allowed in `runs-on`; a FULL re-run reads the variable's current value (verified 2026-10-14).
- On no-capacity / Spot preemption the controller sets `DEVCLOUD_FALLBACK=1` on the repo, cancels and re-runs the run
  whole; the next successful VM create sets it back to `0`. Needs App permission **Variables: Read & write**.
- **Always name a toolchain label** (`devcloud-node24` when nothing else). GitHub gives a queued job to ANY idle
  runner whose labels are a superset of the job's: a VM made for `[linux-4, android-jdk21]` took a plain
  `[linux-4]` job and left its own job queued forever (brivio run 38501083333).
- `devcloud-linux-4` (c4d-highcpu-4, 7 GB, 50 GB disk) is for 1-5 min jobs (lint gates, release helpers, crons).

## Fallback to GitHub-hosted

GitHub has no `runs-on` fallback, so the workflow decides in its gate job:

- `GET /health` -> `capacityOk:false` (a create failed on every zone/model in the last 30 min and nothing
  succeeded since) or unreachable -> `ubuntu-latest`.
- Fork PRs and dispatch `runner=github` -> `ubuntu-latest`.
- On no capacity at create time, or a Spot preemption mid-job, the controller cancels the run and re-runs the
  WHOLE run once (first attempt only; not `rerun-failed-jobs`, which splices the gate's stale attempt-1 outputs) after writing `ci/fallback/<run>.json`; the re-run's gate
  reads `GET /fallback/<run>` and picks `ubuntu-latest`. **Needs the App permission Actions: Read & write**
  (without it the cancel/rerun calls 403, logged as `ci.fallback.rerun`).

## Images (DC-042) — `infra/devcloud/images/`

| family                         | layers                                                                                        | used by               |
| ------------------------------ | --------------------------------------------------------------------------------------------- | --------------------- |
| `devcloud-ci-node24`           | node 24, pnpm (codai `packageManager`), chrome, pwsh, gh, rg, Docker (+compose/buildx), actions runner, warm pnpm store | codai `ci.yml` verify |
| `devcloud-ci-android-jdk21`    | node24 + Temurin 21 + Android SDK (latest platform / build-tools / NDK)                       | codai `release-phone` |
| `devcloud-ci-rust-tauri-linux` | node24 + rustup stable + Tauri 2 Linux deps                                                   | Linux desktop builds  |
| `devcloud-ci-python-uv`        | node24 + uv + CPython 3.12                                                                    | Python services       |
| `devcloud-ci-flutter`          | android-jdk21 + Flutter stable                                                                | caelia                |
| `devcloud-ci-polyglot`         | all of the above + warm store                                                                 | ad-hoc                |

```powershell
pwsh -NoProfile -File infra/devcloud/images/images.ps1 -List              # newest image per family
pwsh -NoProfile -File infra/devcloud/images/images.ps1 -Bake node24 -Lock E:\gh\codai\pnpm-lock.yaml
pwsh -NoProfile -File infra/devcloud/images/images.ps1 -BootTest node24   # create -> runner-ready, fails >= 60 s
pwsh -NoProfile -File infra/devcloud/images/images.ps1 -Schedule          # weekly rebake (Sun 01:30 UTC)
pwsh -NoProfile -File infra/devcloud/images/images.ps1 -RunNow            # one rebake now
```

Weekly rebake: Cloud Scheduler `devcloud-image-rebake` -> Cloud Build (SA `devcloud-image-baker`) runs
`bake.mjs` per toolchain (independent steps); each keeps the newest 3 images of its family. The warm store's
lockfile comes from GitHub via the App (needs Contents: read) or the copy `-Schedule` uploads to
`gs://dragos-devcloud-devcloud-jobs/images/`.

## Turbo cache

On a devcloud VM the verify job uses the self-hosted turbo cache (`vars.DEVCLOUD_TURBO_API` +
`secrets.DEVCLOUD_TURBO_TOKEN`, a copy of Secret Manager `devcloud-turbo-token`: rotate both together).
GitHub-hosted runs keep the Actions-cache turbo server.

## Cost

`pwsh -NoProfile -File infra/devcloud/ci-controller.ps1 -Jobs 5` — last jobs plus per-month VM cost vs the
GitHub-hosted minutes those jobs would have billed.
