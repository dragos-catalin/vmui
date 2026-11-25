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

caelia (org `dragos-catalin`, 2026-11-25) is the second such repo and the first Windows one. Its org's GitHub
Actions minutes are exhausted, so every GitHub-hosted job fails before its first step ("The job was not
started because recent account payments have failed or your spending limit needs to be increased"; run
45530189086, 0 steps in 4 s) - while a probe job with a devcloud label still reached `queued`, which proved
that only HOSTED jobs are blocked. All five CI jobs therefore name their label set directly (no fallback
expression, and caelia is deliberately absent from `-FallbackVarRepos`): `[self-hosted,
devcloud-win-flutter-16, devcloud-win-flutter]` for verify/dart-tests/build-windows/perf-gate and
`[self-hosted, devcloud-linux-16, devcloud-android-jdk21]` for build-android. Every job carries a
`timeout-minutes`, so a VM that never appears is a fast explicit red instead of an hours-long `queued`.

Windows toolchains: `devcloud-win-desktop` (MSVC/Rust/WebView2/Chrome, family `devcloud-ci-win-desktop`)
and `devcloud-win-flutter` = win-desktop + Flutter (family `devcloud-ci-win-flutter`, baked 2026-11-25:
Flutter 3.47.3 stable from the official zip into `C:\flutter`, machine-wide `FLUTTER_ROOT`, `precache
--windows`; the image is a superset of win-desktop, so a Flutter repo also gets the Tauri/desktop stack).

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
| `devcloud-ci-rust-tauri-win`   | rust-tauri-linux + target x86_64-pc-windows-msvc, cargo-xwin (warm MSVC CRT/SDK cache), clang/lld/llvm-rc, NSIS, JRE 21 + jsign, osslsigncode | brivio Windows desktop release + cross clippy (DC-047) |
| `devcloud-ci-python-uv`        | node24 + uv + CPython 3.12                                                                    | Python services       |
| `devcloud-ci-flutter`          | android-jdk21 + Flutter stable                                                                | caelia                |
| `devcloud-ci-polyglot`         | all of the above + warm store                                                                 | ad-hoc                |
| `devcloud-ci-win-flutter`      | Windows 2025 + Git, Node 24, pnpm, pwsh 7, gh, rg, 7zip, CMake, NASM, Chrome, WebView2, Flutter stable, JDK 21 (Adoptium zip) + Android SDK (platform/build-tools 35 36), VS Build Tools, Rust (DC-071) | caelia `ci.yml` (verify, dart tests, build Windows, perf) |

### Which label picks which image (verified 2026-11-25)

`pickProfile()` resolves the machine from the first `runs-on` label that is a `PROFILES` key
(`devcloud-linux-4/16/32`, `devcloud-win-16`, `devcloud-win-flutter-16`), then the toolchain from the
label whose `devcloud-` prefix stripped is in `TOOLCHAINS` **and whose OS matches the profile's**
(`TOOLCHAIN_OS` maps only `win-desktop` / `win-flutter` to Windows). The image family is then
`devcloud-ci-<toolchain>`, so:

| labels in `runs-on`                                  | image family                    |
| ---------------------------------------------------- | ------------------------------- |
| `self-hosted, devcloud-linux-16, devcloud-android-jdk21` | `devcloud-ci-android-jdk21` |
| `self-hosted, devcloud-win-flutter-16, devcloud-win-flutter` | `devcloud-ci-win-flutter` |
| `self-hosted, devcloud-win-16`                        | `devcloud-ci-win-desktop` (profile default) |

Two consequences worth knowing before writing a workflow: a **misspelled label is a silent hang** (no
profile matches, no runner is ever created, and GitHub applies `timeout-minutes` only once a job starts),
and a **Linux job that needs Flutter must install it itself** (`subosito/flutter-action`) because the
`android-jdk21` image ships the JDK and the Android SDK, not Flutter — the `flutter` toolchain layer is a
separate family. `base` (every family) already has pwsh + gh, so `shell: pwsh` works on Linux too.

### An image step that "succeeds" is not an image step that did anything (2026-11-25)

Every install step in `image-setup-win.ps1` / `image-setup.sh` must end in an assertion on the **artifact**,
never on an exit code, because the failure mode here is silent: bake #2 ran the Android SDK installs through
the `Run` helper (`Start-Process`), which reports success for a `.bat` **without installing anything**, so the
image published with `C:\Android\sdk` holding only `cmdline-tools` and `licenses` while its own log still
printed `::android ready api=35 36`. The first job on that image then answered `Unable to locate Android SDK` /
`Android SDK file not found: adb` — a doctor line, not a build failure, so it reads as noise.

- Invoke `sdkmanager`/`flutter`/installers with the **call operator**, then assert
  `platform-tools\adb.exe`, `platforms\android-<api>\android.jar` and `build-tools\<api>.0.0\aapt2.exe` exist.
- A bake is only proven by **booting it and running the tool** (`flutter doctor -v` on a workspace made from
  the new image), not by the bake's own log. `-BootTest` proves the runner becomes ready and nothing else.
- The runner service is **LocalSystem while jobs run as `dev`**, so a checkout owned by SYSTEM fails git's
  dubious-ownership check and Flutter then dies with `Unable to determine engine version`. The image writes a
  **system** `git safe.directory C:/flutter`; fixes applied by hand inside a live workspace
  (`git config --global`) hide this and disappear with the VM.

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

### A second bake path is a second way to ship a broken image (2026-11-25)

`build.json` (the scheduled rebake) is a **separate** definition from `-Bake <toolchain>` on the command line:
it does not read this file's defaults and it is the path nobody watches. Its `win-flutter` step asked for the
Flutter layer but **not** `--android-sdk`, so the weekly job would have replaced the pool's Windows image with
one that cannot build an APK — every Android job red the next morning, with the bake log green. Both layers
caelia needs now travel together, and `bake.test.mjs` reads `build.json` and fails if a Flutter step omits the
Android layer (mutation-checked: removing the flag fails that test alone).

Rule: when a capability is a **flag**, every path that bakes the family must pass it, and a test must read the
scheduled definition rather than trust the one you type.

### Which bake ran this job

`GET .../images/family/<f>` answers with the **concrete** image, and the controller now records it: the job VM
carries `image-family` / `image-version` / `image-stock` in **metadata**, an `image` **label** (so
`gcloud compute instances list --filter labels.image=...` works) and the same three fields in
`ci/vms/*.json` + `ci/jobs/*.json`. `imagePin()` in `server.mjs` derives them, including the stock fallback
(`stock: true`) that boots with no toolchain at all — without it, a job that booted a months-old bake and a
job that booted stock Ubuntu are indistinguishable after the fact.

`tool/health_devcloud.ps1` (caelia) prints the `image-version` metadata when it runs on a controller-created
VM, so a health probe names the bake it ran on.

### Recreating a workspace VM: reset the delta base

The bundle a cloud run uploads is a delta from the commits the **disk** already has, and that list lives in
GCS (`ws/<ws>/repos/<repo>.json`), not on the VM. A recreated VM therefore starts empty while the record still
claims the old disk had `HEAD`, and the first run dies with
`error: Repository lacks these prerequisite commits`. `workspace.ps1` now overwrites those lists with `[]`
when it **creates** an instance (the shas are a cache of the disk, not data), so the next run ships a full
bundle. Seen live 2026-11-25 right after recreating `ws-caelia` from a new bake.

### Secrets a workspace needs

`workspace.ps1 -SecretAccess 'project:secret;project:secret'` binds
`roles/secretmanager.secretAccessor` for the workspace service account on those **individual** secrets, so a
runner reads them with its metadata token and the Secret Manager REST API — no `gcloud` in the image, and no
project-wide read. Caelia's signed release uses it for its upload keystore
(`-SecretAccess 'dragos-devcloud:caelia-upload-keystore-b64;dragos-devcloud:caelia-upload-key-properties'`,
read by `tool/devcloud_secrets.ps1`, documented in `E:\gh\caelia\docs\devcloud.md`). Recreating a workspace
without that flag silently drops the runner's ability to sign.

## Turbo cache

On a devcloud VM the verify job uses the self-hosted turbo cache (`vars.DEVCLOUD_TURBO_API` +
`secrets.DEVCLOUD_TURBO_TOKEN`, a copy of Secret Manager `devcloud-turbo-token`: rotate both together).
GitHub-hosted runs keep the Actions-cache turbo server.

## Cost

`pwsh -NoProfile -File infra/devcloud/ci-controller.ps1 -Jobs 5` — last jobs plus per-month VM cost vs the
GitHub-hosted minutes those jobs would have billed.
