# Performance config for cloud machines — measured on the workstation, 2026-11-21

**Who this is for:** whoever is working the devcloud program (`ws-codai`, `ws-devbox`,
`ws-vitals-win`, the Windows CI pool, the ephemeral e2e runner VMs).
**Why:** the workstation was profiled today with 24 active agent turns / VS Code Insiders
(~32 logical cores, 196 GB RAM). The findings below transfer directly: the cloud machines
run the same stack (Windows or Linux, Docker/WSL, Node/pnpm/turbo, VS Code + agents) and
currently have **no equivalent tuning**.

All numbers are measured on the workstation, not estimated. The measurement harness and the
rollback scripts for every change are in
`E:\gh\.copilot-tmp\perf-20261121-rollback\` (gitignored scratch; 90 files incl. `baseline.ps1`).

---

## 0. The measurement technique (read this first)

```powershell
# Total + per-process CPU, 5 samples x 2 s, plus working set per process group
pwsh -NoProfile -File baseline.ps1 -Label <name> -CounterSamples 5 -CounterInterval 2
# per-process attribution aggregated by NAME over N rounds
pwsh -NoProfile -File cpu-full.ps1   -Label <name> -Rounds 8 -Gap 3
```

Three traps that cost time today:

1. `Get-Counter '\Process(*)\% Processor Time'` **fails** with PDH error `800007d2`
   (`PDH_MORE_DATA`). Use single-instance paths (`\Process(System)\% Processor Time`) or
   `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process`.
2. In the WMI **formatted** class, duplicate process names get a `#N` suffix
   (`tsc`, `tsc#1`, `tsc#2`). A filter `-eq 'tsc'` matched **1 of 3** instances and hid the
   real culprit. Always match `-like 'name*'`.
3. `% Processor Utility` overstates (33,99 vs 22,11 cores on the same sample). Use
   `% Processor Time`; `PercentProcessorTime` from WMI is per ONE core (divide by 100 × ncpu
   to get machine %).

---

## 1. Windows: Defender exclusions — the biggest single measured win

CI / dev VMs are usually unconfigured, so **every** `node_modules`, `.next`, `.turbo`,
`target/`, `.gradle`, `.cargo` write is scanned.

Measured on the workstation after excluding the dev tree and caches:
`MsMpEng` **1,86 → 1,13 cores**, working set **944 → 745 MB**.

```powershell
Add-MpPreference -ExclusionPath 'C:\workspace'     # or E:\gh
Add-MpPreference -ExclusionPath "$env:TEMP"
Add-MpPreference -ExclusionPath "$env:USERPROFILE\.vscode-insiders\extensions"
Add-MpPreference -ExclusionPath "$env:USERPROFILE\.codai\logs"
# caches: .cargo, .cargo\registry, .gradle, .gradle\caches, .pnpm-store, node_modules, target, .next, .turbo
```

Keep realtime monitoring **on** — 22 exclusions do not disable protection.
Rollback: `elevated-ops5-rollback.ps1` / `elevated-ops7-rollback.ps1`
(`Remove-MpPreference -ExclusionPath ...` per path).

## 2. Windows: services → Manual / Stopped

Runs a background service that is pure waste on a VM whose job is running builds/tests:
`SysMain` (Superfetch), `WSearch` (Windows Search — on CI set **Disabled**), `Spooler`,
`StiSvc`, `DiagTrack` (set **Disabled**), plus the vendor/gaming set that exists on desktops
(`XboxService`, `GameInputRedistService`, `GamingServices{,-Net}`, RGB/update helpers).

```powershell
Set-Service -Name SysMain -StartupType Manual; Stop-Service SysMain
# services with a TrustedInstaller DACL refuse Set-Service -> write the registry value:
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\GamingServices' Start -Value 3 -Type DWord
```

## 3. Windows: scheduled tasks to disable

`OneDrive Per-Machine Standalone Update Task`, `OneDrive Reporting Task-*`,
`RunPlatformExperienceHelper_Daily`, `RunPlatformExperienceHelper_Metrics`,
`Autorun for <user>`.

```powershell
Get-ScheduledTask -TaskName '<name>' | Disable-ScheduledTask
```

## 4. Docker / WSL — both disk and RAM

- `docker system df` on a dev box: build cache is typically the largest reclaimable item
  (**measured: 32,4 GB** freed by `docker system prune` + fstrim).
- Cap the engine: Docker Desktop `Cpus` (32 → 16 here) so a runaway build cannot starve the
  agent host.
- Compact the vhdx — the file does **not** shrink on prune alone:
  `schtasks /run /tn CodaiMaint-CompactWslDisks` (**measured: 572,0 → 506,2 GB, 65,9 GB
  reclaimed, no UAC**; the script pauses `brivio-wsl-runner-keepalive`, fstrims, then
  Optimize-VHD per disk).
- `wsl --shutdown` frees the VM's RAM (measured ~3,5 GB: `vmmemWSL` 2,8 GB + Docker 0,5 GB).
  **Caveat:** Docker Desktop + WSL **relaunch themselves** (Docker Desktop at 05:44:29,
  parent process already dead) — and `CodaiMaint-CompactWslDisks` relaunches Docker on
  purpose. Do not assume "stopped once = stays stopped".
- Every long-lived cloud VM needs the server-side deadline
  (`--max-run-duration=Nh --instance-termination-action=DELETE`) — already a standing rule.

## 5. Node/JS stack: keep the caches bounded

The turbo cache grows without a limit on a busy runner (disk + hashing time on every task).
Set, per machine or in the CI env:

```
TURBO_CACHE_MAX_SIZE=5GB
TURBO_CACHE_MAX_AGE=7d
```

(env vars chosen over editing `turbo.json` so the repo config stays untouched).

## 6. VS Code + agents on a cloud workspace (ws-codai, ws-devbox, Windows CI desktop)

This is where the workstation profiled **worst**, and cloud VMs are typically
under-provisioned vs. the workstation (32 cores / 196 GB here).

- **`typescriptteam.native-preview` (tsgo, TS 7) is the single largest CPU consumer**:
  measured **12,95 cores average / 21,19 max of 32** on the codai workspace with 24 worktree
  slots (99 GB under `E:\gh\.wt\codai`). It correlated exactly with
  `Extension host (LocalProcess pid: N) is unresponsive` events and preceded a VS Code crash
  (Crashpad dumps 2,90 MB + 2× 33,90 MB). Settings it honours:
  `typescript.native-preview.goMemLimit` (6GiB here), `typescript.native-preview.tsdk`,
  `typescript.native-preview.trace.server`. Commands: `typescript.native-preview.restart`,
  `.disable`. 3 instances ran (one per window): 1,1 / 4,5 / 6,5 GB.
  The watchdog `codai-tsgo-watchdog` (`C:\Users\vladu\.codai\bin\tsgo-watchdog.ps1`, every
  10 min, `wscript.exe hidden-run.vbs`) restarts the server only above a CPU threshold — at
  `MaxCores=12` it fired **once in 60 minutes** while the server sat at ~13-21 cores, i.e. the
  threshold is not a reliable guard. On a smaller cloud VM, prefer disabling native-preview
  for agent-driven windows and measure.
- **Why it burns all cores, from upstream (researched 2026-11-21, do not re-investigate):**
  - `microsoft/typescript-go#4347` ("CPU usage spikes to 80-100% with `tsgo --lsp --stdio`")
    was **closed as not planned**; Daniel Rosenwasser: _"The CPU spikes are definitely a lot
    easier to notice when the server is capable of using all cores."_ → **all-core usage is by
    design**, there is no setting that lowers it. The reporter's own workaround was
    `cpulimit -l 400 -- tsgo --lsp --stdio`; `GOMAXPROCS=4` did **not** work for him, and the
    extension bundle here does not reference `GOMAXPROCS` at all (only `GOMEMLIMIT` / `goMemLimit`).
  - `#2780` (memory explosion in a large **pnpm** monorepo: the auto-import registry cached the
    same physical file under several keys because it did not resolve `node_modules` symlinks)
    is **already fixed** by PR #3447 in **7.0.2 — the version bundled here**
    (`typescriptteam.native-preview-1.0.2-win32-x64` ships `tsc.exe 7.0.2`,
    `@typescript/typescript-win32-x64 7.0.2`). **An upgrade is therefore not a fix.**
  - The auto-import cache keeps growing because **agent chat opens files through the LSP and
    leaves them open across every project** (the maintainer's own diagnosis on #2780) — exactly
    the 24-worktree agent load here. Killing the server only triggers a full re-index; measured
    restart: tsgo back to 14,0 / 17,4 cores 15 s and 60 s later.
- **The fix that works (Windows equivalent of that `cpulimit`): CPU affinity.** Restarting does
  not help (measured) and priority alone does not stop an all-core hog, so _bound the cores_:
  `tsgo-cap.ps1 -Cores 12` sets `ProcessorAffinity=0xFFF` (first 12 of 32 logical) on every
  `tsc.exe --lsp`; `-Reset` puts all cores back. `tsgo-ab.ps1` measures uncapped vs capped with
  the same instrument. On a cloud VM size the cap to **~half the vCPUs** (e.g. 8 of 16) and set
  the watchdog's `-MaxCores` to match, or install Process Lasso (present but unconfigured here:
  `ProcessGovernor` service running, `Start=4`, config dirs empty) and give it a CPU-limiter rule.
- `files.watcherExclude` (agent hosts churn the tree; a recursive watcher over worktree slots
  and `workspaceStorage` is pure waste):
  `**/.wt/**`, `**/AppData/Roaming/Code - Insiders/**`, `**/AppData/Local/Temp/**`,
  `**/.copilot-tmp/**`, plus the usual `node_modules`, `.next`, `.turbo`, `dist`, `target`.
- `[typescript]/[javascript]` → `editor.codeActionsOnSave: {"source.*": "never"}`: on reload,
  VS Code restores every `chatEditingSessions` entry and autosave triggers TS7 loads **per
  worktree** (measured: tens of minutes of unresponsiveness).
- Chat progress/shimmer animations off + smooth scrolling off (measured: renderer + GPU
  processes at ~2 cores each with the animations on).
- `argv.json`: `{"max-old-space-size": 4096}`.
- Crashpad dumps are **not** self-limiting: measured 28 dumps / 36 GB. Delete >7 days.

## 7. Reporting rule

Every optimization ships with **before/after measurement** and a **rollback script**, and the
claim is labelled VERIFIED (ran it, saw it) or EXPECTED. The rollback bundles here are the
pattern: each `elevated-opsN.ps1` writes a matching `elevated-opsN-rollback.ps1` plus a
timestamped log.

## 8. Ready-made harness

Copy from `E:\gh\.copilot-tmp\perf-20261121-rollback\`:

| File                                   | What it does                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `baseline.ps1`                         | 16 counters × N samples + WMI rounds → appends `baseline-series.csv`                |
| `cpu-full.ps1`                         | per-process CPU aggregated by name over N rounds + process churn                    |
| `cpu-attr2.ps1`                        | per-instance CPU attribution (`#N` aware)                                           |
| `ext-watch.ps1`                        | N-minute monitor: new `Extension host … is unresponsive` events + MsMpEng/total CPU |
| `temp-clean.ps1`                       | deletes `%TEMP%` items older than N days (`-WhatIf` supported)                      |
| `elevated-*.ps1` + `run-elevated*.cmd` | the UAC-launch pattern for elevated one-shot ops                                    |
