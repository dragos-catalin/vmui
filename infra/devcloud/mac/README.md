# devcloud macOS host (DC-053)

The owner's macOS VM, replicated from the local WSL2 one: the **same** golden base
(`mac_hdd_ng.img`, 15.7.5) and Tahoe overlay (`mac-tahoe.qcow2`) booted by the **same**
`scripts/boot-mac.sh`, on a Google Compute Engine VM with nested virtualization. Owner only
(ADR-0003, risk accepted by the owner); never offered to users or customers.

| | |
|---|---|
| Host | `vmui-mac`, `c4-standard-16` (Intel Emerald Rapids, 16 vCPU, 60 GB), `dragos-devcloud` / `europe-central2-a`, Ubuntu 24.04, `--enable-nested-virtualization` |
| Guest | 32 GB / 8 cores / 16 threads (same as the local VM), QEMU 8.2.2, OSX-KVM/OpenCore |
| Disks | boot 50 GB; data disk `vmui-mac-data` (Hyperdisk Balanced 300 GB, kept on VM delete) mounted at `/var/lib/vmui-mac`, weekly snapshot (4 kept) |
| Source of the disks | `gs://dragos-devcloud-mac/v1/` (private bucket), pulled on first boot |
| Network | no external IP; Cloud NAT for apt; firewall `devcloud-mac-allow-iap` = IAP range `35.235.240.0/20` -> tcp:22 on tag `devcloud-mac` only |
| Listeners | every QEMU port binds `127.0.0.1` (`MAC_BIND`): guest SSH 10022, VNC 5900, Screen Sharing 5901, SPICE 5930, QMP 4444 |
| Cost | on demand, ~$0.96/h while running (c4-standard-16, europe-central2) + disk; suspends itself after 15 min idle (suspended = disk + saved RAM only) |

## Use

```powershell
pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Start     # resumes (~22 s, macOS as you left it) or cold-boots
pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Tunnel    # keep open; same ports as the local VM
#   ssh dragos@127.0.0.1 -p 10022   |  VNC localhost:5900  |  SPICE spice://localhost:5930
pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Stop      # clean guest shutdown, then the host stops
pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Status
```

vmui lists it under the GCP provider as a **macOS** instance (label `role=mac`), with start/stop
and the tunnel command in its connection info.

**Idle suspend.** `vmui-mac-idle.timer` checks every minute. "In use" = a connection to a guest
port through the tunnel, or an interactive login on the host. After 15 minutes of neither, the VM
suspends itself with macOS still running (custom role `devcloudMacSelfStop` bound on this instance
only). `-Start` resumes it in ~22 s with the session intact. An open tunnel with nothing using it
does not keep the VM up. GCE keeps a suspended VM for at most 60 days, then it becomes TERMINATED
(the data disk is unaffected; next `-Start` cold-boots). `-Stop` does the full clean shutdown
(ACPI power button over QMP, up to 300 s) before stopping the host.

## Setup (once)

```powershell
pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Upload      # local chain -> GCS (113 GB; see below)
pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Provision   # SA, firewall, NAT, data disk, VM, snapshot schedule
pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Status      # first boot pulls the disks (~5-10 min in-region)
```

`-UpdateHost` pushes a changed `mac-host-startup.sh` / `boot-mac.sh` and re-runs it.
`-Snapshot` takes an extra data-disk snapshot (do one before a macOS upgrade).

## What was measured (spike 2026-10-17)

- Host: `vmx` exposed (32 flags), clocksource `tsc` with `constant_tsc nonstop_tsc tsc_known_freq`.
- Tahoe recovery (`fetch-macOS-v2.py`) with the unchanged `boot-mac.sh` CPU line reached the
  Recovery UI within 30 s of the OpenCore picker; QEMU stable for 10+ minutes.
- Clean stop via the ACPI path: the guest powered off in 240 s.
- Suspend with QEMU running: 31 s; resume: 22 s; same QEMU pid, no restart, guest display live.
- All listeners on 127.0.0.1; the IAP two-hop tunnel reached VNC/SPICE.
- Upload from the workstation: base 51 GB in 47 min (18 MiB/s). The uplink is the limit, not GCS.

## Traps

- `gcloud compute ssh` on Windows drives PuTTY; an OpenSSH `ProxyCommand` with the quoted gcloud
  path fails in cmd ("Command name argument expected"). `-Tunnel` uses `start-iap-tunnel` to a
  local port + Windows OpenSSH instead.
- The gcloud key `~/.ssh/google_compute_engine` has inherited ACLs that OpenSSH rejects
  ("bad permissions"); `-Tunnel` makes an owner-only copy `devcloud_mac_ed`.
- Overlay backing paths are relative: keep `mac_hdd_ng.img` and the overlay in the same directory.
- C4D (AMD) has no nested virtualization; N4D does, but OSX-KVM wants an Intel CPUID. Use C4.
- No GPU: no Metal, no iOS Simulator, and Apple ID sign-in fails with the placeholder SMBIOS
  serial (same as locally). For Xcode/Simulator use real Apple hardware (ADR-0003, DC-054).
- Intel macOS ends at Tahoe 26.x (macOS 27 is Apple silicon only); security updates expected to ~2028.
