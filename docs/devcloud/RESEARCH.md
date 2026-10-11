# devcloud research (2026-10-11)

Sources were read on 2026-10-11. Items marked _(unverified)_ were not re-checked that day.

## 1. CI runners

- **GitHub self-hosted runner fee ($0.002/min)**: announced Dec 2025, postponed indefinitely; not in effect as of 2026-09-23.
  [changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions)
- **GitHub-hosted (from 2026-01-01)**: Linux 2 vCPU $0.006/min, ARM $0.005, Windows $0.010, macOS $0.062.
  [2026 pricing](https://github.com/resources/insights/2026-pricing-changes-for-github-actions)
- **Vendors (2 vCPU Linux)**: Ubicloud $0.00125 · Namespace $0.003 · Blacksmith $0.004 · WarpBuild $0.004 (BYOC $0.002) · Depot $0.006. BuildJet shut down 2026-03-31.
  [comparison](https://cicdpipelinecost.com/depot-vs-namespace-vs-blacksmith)
- **ARC `gha-runner-scale-set` 0.15.0** (2026-10-01) plus the Google Terraform module `terraform-google-github-actions-runners`, which provides `gh-runner-gke` and `gh-runner-mig-vm`.
- **Choice: own GCE JIT-VM controller.** brivio ADR-0236 already proves the pattern with n2d-16 spot, a zone fallback and VMs that delete themselves when idle. It gives VM isolation, Docker, KVM and Windows, and it is reusable in codai.

## 2. Caching

- **Turborepo remote cache**: `ducktors/turborepo-remote-cache`, a single container with GCS storage, run on Cloud Run. This is the biggest win for the least effort, and no repo has one today.
- **Rust**: sccache with `SCCACHE_GCS_BUCKET`. **Gradle**: an HTTP build cache node. **pnpm**: a store baked into the image or kept on a persistent disk (`store-dir`).
- **Bazel / NativeLink / BuildBuddy remote execution**: skipped, because they need a Bazel migration. **Nx agents**: skipped, because they need a switch away from Turbo.

## 3. Warm environments and sandboxes

- **GCE suspend/resume** saves RAM to storage and stops vCPU billing. It works on Spot VMs, but not with GPUs. This is the primitive for warm developer machines.
  [docs](https://docs.cloud.google.com/compute/docs/instances/suspend-resume-instance)
- **Hyperdisk instant snapshots** let you fork a golden workspace disk.
- **GKE Agent Sandbox** (gVisor, warm pool under 1 s) is a later option for short multi-tenant agent tasks. It cannot run Docker, emulators or Windows.
- **Cold-start P50s**: Daytona 27–90 ms, E2B ~150 ms, Modal 0.6–1.5 s.
  [bench](https://www.getqpro.com/blog/sandbox-startup-benchmark-2026)
- **Coder v2.36.7** (2026-10-05) prebuilt workspaces are the reference design for warm pools.

## 4. Code sync and remote development

- **Jobs**: git-delta. Send the base sha plus a binary patch that includes untracked files. Upload it to GCS; the runner fetches the base, applies the patch and runs. This is deterministic, and the brivio `e2e-cloud` temp-index pack already does the same.
- **Live sync**: Mutagen 0.18.1 has had no release in 19 months, so prefer Syncthing 2.1.x with a strict `.stignore`. For the fastest hot reload, use VS Code Remote-SSH/Tunnels editing directly on the VM.
- **Ports**: `tailscale serve`, with a local forward on the same port so `localhost:3000` keeps working.

## 5. GCP machines

| Series                             | Use                                | Notes                                |
| ---------------------------------- | ---------------------------------- | ------------------------------------ |
| C4D (AMD Turin, ≤4.1 GHz, `-lssd`) | builds: tsc, vitest, cargo, gradle | **no nested virt**                   |
| C4 (Intel)                         | Android emulator, Windows, OSX-KVM | nested virt (KVM L1 only)            |
| N4D                                | cheaper AMD                        | the only AMD series with nested virt |
| C4A (Axion ARM)                    | ARM Linux CI                       | ~$0.056/vCPU-h with local SSD        |

- `europe-central2` offers both c4d-highcpu-\*-lssd and c4-standard-16 (checked with `gcloud compute machine-types list`).
- Windows Server images carry a per-core licence surcharge.

## 6. Scheduling

- **Kubernetes-style priority classes plus preemption**: only for jobs marked preemptible (the batch lane), with a grace period.
- **Aging**: +1 priority level for every N minutes spent waiting, so nothing starves.
- **Work-conserving lanes**: borrow idle capacity and return it at the job boundary.
- **Slurm backfill**: a short job may jump the queue if its declared maximum ends before the top waiter's reserved start.
- **Token-bucket overrides**: N urgent tokens per session per hour.
- **Pressure admission on Windows**: there is no PSI, so use Processor Queue Length per core and Committed Bytes vs Commit Limit (FreeVirtualMemory).
- **Progress watchdog**: if log size and CPU time are both flat for N minutes, the job is HUNG.
- **Bazel dynamic execution** (race local vs remote): https://bazel.build/remote/dynamic
- **Queue libraries**:
  - pg-boss 12.37.1 (Postgres; priority, singleton keys, stats). This is the choice for cloud jobs.
  - graphile-worker 0.18.0
  - p-queue 9.3.5 (in-process only)

## 7. macOS / iOS

- **Owner path, chosen by the owner**: OSX-KVM on GCE C4 nested virt. Known limits: no Metal and no Apple ID with a placeholder SMBIOS. The local OSX-KVM VM (vmui `docs/local-kvm-macos.md`) has **no** Xcode and **no** working iOS Simulator today. The EULA risk is in ADR-0003.
- **Customer path**:
  - GitHub macos-26 runners (GA 2026-02, per minute, no 24 h minimum).
  - Scaleway Mac mini M4 at €0.22/h with a 24 h minimum, running **Tart 2.40.1** (now under OpenAI, being relicensed permissively) with Orchard, 2 VMs per host.
  - AWS EC2 mac-m4 at ~$1.23/h with a 24 h minimum.

## 8. Images and toolchains

- **mise** (2026.10.x) pins toolchains, with the same `mise.toml` on Windows and Linux.
- **Image builds**: a plain gcloud startup-script that bakes into an image family. Packer 1.16.1 (BSL) only if we go multi-cloud.

| Image             | Contents              |
| ----------------- | --------------------- |
| node24-pnpm12     | ~80 % of agent work   |
| node24-playwright |                       |
| rust-tauri-linux  |                       |
| android-sdk-jdk21 |                       |
| python-uv         |                       |
| flutter-3.47      |                       |
| polyglot-sdk      | Go / .NET / PHP / JDK |
| windows-msvc      |                       |
| macos             | owner                 |

## 9. Tailscale

- 1.104.1. An OAuth client with the `auth_keys` scope creates tagged keys.
- `tailscale up --auth-key='<secret>?ephemeral=true&preauthorized=true' --advertise-tags=tag:devcloud --ssh`
- `tailscale serve` exposes each dev port.

## 10. Workload inventory

The full table is in `E:\gh\codai\.copilot-tmp\inv\`.

- **Linux-capable (most of it)**: typecheck, lint, vitest, playwright, next/vite/tsdown builds, docker builds, Android Gradle, Rust library crates, Python.
- **Windows-only**: Tauri NSIS/MSI, crates that use the Windows API (codai sensors/exec/codaid, vitals-win, dashy-agent, titi/metu desktop), and codai desktop VR/e2e.
- **macOS-only**: titi/caelia iOS, and the dmg bundles.
