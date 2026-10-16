# Local KVM macOS — operations & troubleshooting

This document covers the **local-kvm** provider: a macOS guest running under
QEMU/KVM inside WSL2 Ubuntu, controlled by vmui.

The same disks also run in Google Cloud (nested KVM on a C4 VM, owner only):
see [infra/devcloud/mac/README.md](../infra/devcloud/mac/README.md) (DC-053). `boot-mac.sh`
is shared; `MAC_BIND` (default `0.0.0.0`) is `127.0.0.1` there.

## Architecture

```
 Windows host                                WSL2 (Ubuntu-24.04)
 ─────────────                                ──────────────────
 vmui (Next.js) ──▶ Server Action ──┐
                                    │
       VS Code task ────────────────┼──▶ spawn-watchdog.ps1 (Windows)
                                    │           │
                                    │           ▼
                                    └──▶ watchdog-mac.ps1 (Windows, hidden)
                                                │   keeps wsl.exe handle open
                                                ▼     so WSL2 doesn't idle-shut
                                          run-mac-foreground.sh (in WSL)
                                                │
                                                ▼
                                          boot-mac.sh ──▶ qemu-system-x86_64
                                                              │
                                                              ▼
                                            VNC :5900   QMP :4444   SSH :10022
```

The Windows-side watchdog process is essential: it holds an open handle on
the WSL distro, defeating WSL2's 60-second idle-shutdown that would otherwise
kill QEMU.

## Two equivalent ways to start the VM

Both routes end up running the same `watchdog-mac.ps1` with the same args.

1. **Web UI** — `Instances → local-mac → Start` calls
   `LocalKvmProvider.startInstance()` in
   [src/lib/providers/local-kvm.ts](../src/lib/providers/local-kvm.ts), which
   spawns the watchdog through `scripts/spawn-watchdog.ps1` (uses
   `Win32_Process.Create` to break out of Node's job object).

2. **VS Code task** — `vmui: start mac VM (32GB)` runs
   `scripts/watchdog-mac.ps1` directly in the foreground terminal, useful
   for live log tailing during dev.

The watchdog itself:

- syncs `run-mac-foreground.sh` from `/mnt/e/gh/vmui/scripts` on every iteration
- pre-cleans stale `qemu-nbd` connections / mounts that would lock
  `OpenCore.qcow2` (e.g. from a crashed UIScale-patch run)
- restarts QEMU automatically if it exits

## QEMU version compatibility

WSL2 Ubuntu-24.04 ships **QEMU 8.2.2**. Earlier guides for OSX-KVM use props
that this build no longer accepts:

| Removed prop         | Symptom                                                             | Fix                                         |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| `VGA.xmm`, `VGA.ymm` | `Property 'VGA.xmm' not found` → QEMU exits, watchdog restart-loops | omit them; the bare `xres`/`yres` is enough |

These were physical-screen-size hints (in mm) used by older QEMU to hint
DPI to the guest. They've been removed from the std VGA device.

## Host prerequisite: guest credentials (`.private/`)

The scripts drive the guest over SSH unattended, so they need a password. This
repo is **public**, so credentials live outside it:

```bash
mkdir -p .private
cp .private.example/credentials.env .private/credentials.env
# then edit .private/credentials.env
```

`.private/` is gitignored. Scripts load it via
`scripts/lib/guest-credentials.sh` (bash) or
`scripts/lib/guest-credentials.ps1` (PowerShell), and an already-exported
environment variable always wins, so a single run can be overridden with
`MAC_GUEST_PASS='…' ./scripts/mac-perf-tune.sh`.

See [.private.example/README.md](../.private.example/README.md).

## Host prerequisite: WSL memory cap (`.wslconfig`)

The guest is allocated **32 GB** (`-AllocatedRamMb 32768`) by every launch
path. QEMU needs headroom _beyond_ `-m` for its own address space and for page
cache over the qcow2 overlays, so the WSL2 VM must be given more than the
guest asks for.

`%USERPROFILE%\.wslconfig` — **not tracked in this repo**, so it must be
recreated by hand on a new machine:

```ini
[wsl2]
vmIdleTimeout=-1          # never idle-shut the distro (would kill the VM)
memory=64GB               # must exceed the 32GB guest by a wide margin
processors=16
nestedVirtualization=true
```

A 48 GB cap left only ~31 GB actually available inside WSL and a 32 GB guest
would not fit. After editing, run `wsl --shutdown` (this stops **all** distros)
and verify:

```powershell
wsl -d Ubuntu-24.04 -- free -g          # want ~62 GB total
```

Then confirm the guest agrees, rather than trusting the QEMU flag:

```powershell
wsl -d Ubuntu-24.04 -- bash -lc "sshpass -p <your-guest-password> ssh -o StrictHostKeyChecking=no -p 10022 dragos@127.0.0.1 'sysctl -n hw.memsize'"
# 34359738368 = 32 GB
```

> RAM/CPU defaults live in **three** places and must be kept in sync:
> `.vscode/tasks.json` (`start mac VM`), `scripts/mac-branch.ps1`, and
> `KIND_DEFAULTS.mac` in `src/lib/providers/local-kvm.ts`. They disagreed once
> and the guest silently ran at 16 GB.

## HiDPI / "everything is huge" fix

### Symptom

After boot, macOS reports:

```
Resolution: 1920 x 1080
UI Looks like: 960 x 540 @ 75.00Hz
```

The framebuffer is 1920×1080 but the UI is rendered at 2× scale (960×540
logical points). Windows, dock, and text are all twice the size they
should be.

### Root cause

QEMU's std-VGA EDID in 8.2 doesn't include physical screen dimensions
(no `xmax`/`ymax` mm property is exposed). With no physical size, macOS
falls back to assuming a high-DPI panel and engages 2× scaling.

OpenCore's `UIScale=01` NVRAM variable does **not** help — that only
affects OpenCanopy's picker, not macOS itself once the kernel boots.

The `/Library/Displays/Contents/Resources/Overrides/DisplayVendorID-…/`
plist trick is shadowed by the same-named override under
`/System/Library/...` which is SIP-protected and can't be removed.

### Fix — `displayplacer` LaunchAgent

[displayplacer](https://github.com/jakehilborn/displayplacer) is a small
CLI that calls `CGSConfigureDisplayMode` to switch resolutions at runtime.
It is installed at `/usr/local/bin/displayplacer` inside the guest, and a
LaunchAgent runs it at every login:

```bash
# /usr/local/bin/displayplacer is the v1.4.0 intel build
# ~/Library/LaunchAgents/com.vmui.display.plist:
displayplacer "id:FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF \
               res:1920x1080 hz:85 color_depth:4 \
               enabled:true scaling:off origin:(0,0) degree:0"
```

`scaling:off` is the key — that switches macOS out of HiDPI mode for the
QEMU virtual display. After the agent runs (about a second after login):

```
Resolution: 1920 x 1080
UI Looks like: 1920 x 1080 @ 85.00Hz
```

### Re-applying after a fresh install

If you reinstall macOS or the LaunchAgent is missing, run from any
WSL shell while the VM is running and SSH is up on port 10022:

```bash
sshpass -p "<password>" ssh -p 10022 dragos@127.0.0.1 << 'EOF'
curl -sL -o /tmp/displayplacer \
  https://github.com/jakehilborn/displayplacer/releases/download/v1.4.0/displayplacer-intel-v140
chmod +x /tmp/displayplacer
echo '<password>' | sudo -S install -m 755 /tmp/displayplacer /usr/local/bin/displayplacer

mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.vmui.display.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.vmui.display</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/displayplacer</string>
    <string>id:FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF res:1920x1080 hz:85 color_depth:4 enabled:true scaling:off origin:(0,0) degree:0</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
launchctl unload ~/Library/LaunchAgents/com.vmui.display.plist 2>/dev/null || true
launchctl load   ~/Library/LaunchAgents/com.vmui.display.plist
EOF
```

## Troubleshooting

### `Failed to get shared "write" lock` on `OpenCore.qcow2`

A previous `qemu-nbd -c /dev/nbd0 OpenCore.qcow2` (typically from a
crashed UIScale-patch run) is still holding the image. `watchdog-mac.ps1`
now pre-cleans this on every restart, but to do it manually:

```bash
wsl -d Ubuntu-24.04 -- bash -lc '
  sudo umount -l /tmp/vmui-oc-mnt 2>/dev/null
  sudo qemu-nbd -d /dev/nbd0
  sudo rmdir /tmp/vmui-oc-mnt 2>/dev/null
  sudo fuser -v ~/OSX-KVM/OpenCore/OpenCore.qcow2  # should be empty
'
```

### VM boots into UEFI shell instead of macOS

The OpenCore boot disk attaches at `sata.2` and the Mac HDD at `sata.4`.
If you see the OVMF UEFI shell, OpenCore likely failed to enumerate
disks. Verify with:

```bash
wsl -d Ubuntu-24.04 -- bash -lc 'ls -la ~/OSX-KVM/{OpenCore/OpenCore.qcow2,mac_hdd_ng.img}'
```

Both files must exist. `OpenCore.qcow2` is mounted with `snapshot=on` so
config changes require either rebuilding the image or editing it via
`qemu-nbd` while the VM is stopped.

### Watchdog spins / restart-loops

Tail the logs to see what QEMU is rejecting:

```bash
wsl -d Ubuntu-24.04 -- bash -lc 'tail -40 /tmp/vmui-mac.log'
type .watchdog-logs\watchdog-*.log | Select-Object -Last 30
```

Common causes: missing `/dev/kvm`, file lock on `OpenCore.qcow2`,
unsupported `-device` property in this QEMU version, port already in use.

### Capture a VNC screenshot for diagnosis

```bash
wsl -d Ubuntu-24.04 -- bash -lc '
  python3 -c "
import socket,json
s=socket.socket(); s.connect((\"127.0.0.1\",4444))
def r():
    b=b\"\"
    while b\"\\n\" not in b: b+=s.recv(4096)
    return json.loads(b.split(b\"\\n\")[0])
r(); s.send((json.dumps({\"execute\":\"qmp_capabilities\"})+\"\\n\").encode()); r()
s.send((json.dumps({\"execute\":\"screendump\",\"arguments\":{\"filename\":\"/tmp/vmui-screen.ppm\"}})+\"\\n\").encode()); r()
"
  convert /tmp/vmui-screen.ppm /mnt/e/gh/vmui/.watchdog-logs/screen.png
'
```

### Stop the VM cleanly

The VS Code task `vmui: stop mac VM` does this; manually it's:

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'watchdog-mac\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
wsl -d Ubuntu-24.04 -- bash -lc 'pkill -9 -f "[q]emu-system-x86_64"; rm -f /tmp/vmui-mac.*'
```

## Disk branches (qcow2 overlays)

`mac_hdd_ng.img` is a FROZEN golden base (`chmod 444`, macOS 15.7.5 24G624)
plus a full byte copy at `mac_hdd_ng.golden-15.7.5.img`. It is never booted
directly. Every bootable disk is a thin qcow2 overlay on top of it, so an OS
upgrade is testable and revertible without ever writing to the base.

| Branch              | Contents                                    |
| ------------------- | ------------------------------------------- |
| `mac-tahoe.qcow2`   | macOS Tahoe 26.6.2 (25G83) — **default**    |
| `mac-retry.qcow2`   | macOS Sequoia 15.7.9 (24G830)               |
| `mac-current.qcow2` | macOS Sequoia 15.7.5 (24G624), the original |

```powershell
.\scripts\mac-branch.ps1 -List                 # inventory + which is booted
.\scripts\mac-branch.ps1 -Use mac-current      # switch branch and reboot
.\scripts\mac-branch.ps1 -Reset mac-tahoe      # discard a branch, recreate from base
.\scripts\mac-branch.ps1 -Stop
```

The default branch is the `MAC_DISK` fallback in `scripts/boot-mac.sh`, so it
applies to every launch path (web UI, VS Code tasks, bare watchdog). Override
per-launch with `-MacDisk <branch>.qcow2` on `spawn-watchdog.ps1`.

### ⚠️ macOS OS installs need a narrow SMP topology

`-smp 8,cores=4` **hangs** the macOS installer's pre-boot environment: every
vCPU pegs at 100% while nothing is written and the frame never changes, so it
looks like a slow install rather than a hang. Verified 2026-08-18 — the same
update that wedged for an hour at 8t/4c completed in 15 min at 4t/2c.

Always install/upgrade with:

```powershell
.\scripts\mac-branch.ps1 -Use <branch> -Cores 2 -Threads 4
```

Wide SMP is fine at runtime; restore it after the upgrade. The CPU _model_ is
not the lever — upstream OSX-KVM requires `Skylake-Client,-hle,-rtm` for
Sequoia and Tahoe.

Watch an install and get an automatic hang verdict (samples guest SSH, qcow2
growth and screen MD5; calls HANG after 15 min of no growth + no frame change):

```bash
wsl -d Ubuntu-24.04 -- bash -lc 'bash /mnt/e/gh/vmui/scripts/mac-watch-install.sh mac-tahoe.qcow2 150 15.7.5'
```

## Remote display: use SPICE, not VNC

Three transports are exposed. They are **not** equivalent:

| Port    | Transport             | Notes                                                                            |
| ------- | --------------------- | -------------------------------------------------------------------------------- |
| `:5930` | **SPICE** ← preferred | QEMU pushes damage rectangles; per-tile adaptive JPEG/LZ; separate input channel |
| `:5900` | QEMU VNC              | Generic framebuffer diffing. Noticeably laggier                                  |
| `:5901` | Apple Screen Sharing  | Works, but the client must be pinned to RFB 3.8 (see below)                      |

```powershell
.\scripts\mac-connect-spice.ps1              # needs: winget install RedHat.VirtViewer
```

> **First thing to check when "it got laggy":** which transport is actually
> connected. `remote-viewer` dies on `wsl --shutdown` and something can
> silently reconnect on VNC `:5900`.
>
> ```bash
> wsl -d Ubuntu-24.04 -- bash -lc "ss -tn state established | grep -cE ':5930|:5900'"
> ```
>
> Having a VNC client attached **as well as** SPICE makes QEMU encode the
> framebuffer twice. Close the one you are not using.

Apple Screen Sharing on `:5901` rejects standard VNC clients with
`protocol error: key length is too long`. Apple advertises the non-standard
banner `RFB 003.889`; clients that follow it negotiate Apple-DH instead of
legacy VNC auth. Run `scripts/mac-enable-vnc-legacy.sh` once, then force the
client to RFB 3.8 (TigerVNC: `-RFBVersion 3.8`), password `<vnc-pass>` (RFB caps
VNC passwords at 8 characters).

## Known limitations (do not re-investigate)

All of the following trace to one fact: **there is no GPU**.
`MTLCreateSystemDefaultDevice()` returns `NULL`, and the framebuffer driver is
`AppleBochVGAFB` with `IOFBMemorySize` = exactly one 1920×1080 frame.

| Symptom                                        | Cause                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1px square border around rounded windows/menus | Tahoe's window stroke, drawn opaque because there is no Metal device to composite it. **Not** a shadow or accessibility setting — toggling `disableWindowShadows` produces a byte-identical `rgb(62,62,62)` pixel                                      |
| Cursor lags while video is smooth              | `IOFBCursorInfo` is empty = no hardware cursor, so every pointer move is a framebuffer damage rect                                                                                                                                                     |
| VRAM stuck at "7 MB"                           | `AppleBochVGAFB` self-sizes to one frame; `vgamem_mb` is ignored                                                                                                                                                                                       |
| `screencapture` fails                          | No GPU display stream. Use QMP `screendump` instead                                                                                                                                                                                                    |
| No sound                                       | QEMU streams audio over SPICE correctly (`-audiodev spice`), but macOS attaches only an `AppleUSBAudioControlNub` to `usb-audio` and never loads `AppleHDA` for `ich9-intel-hda` (needs an ACPI `HDEF` device with a `layout-id` injected by OpenCore) |

Things tried that made it **worse**, and should not be repeated:
`vmware-svga` (VRAM 7 MB → 3 MB, no mode set, dead GUI) and
`VGA,refresh_rate=30` (broke mouse input over VNC).

The only real fix is a macOS-supported **AMD** GPU (RX 580 / RX 6600) passed
through from a hypervisor that exposes IOMMU. WSL2 cannot do this —
`/sys/kernel/iommu_groups/` is empty because WSL2 is itself a Hyper-V guest —
and macOS has no driver for NVIDIA Ampere or Intel Raptor Lake graphics.

Also ruled out, so nobody spends a day on them: `AppleParavirtGPU.kext` ships
in Tahoe and matches PCI `106b:eeee`, but it is the guest half of Apple's
closed ParavirtualizedGraphics.framework and QEMU cannot implement the host
half; and there is no macOS virtio-gpu driver at all (`AppleVirtIO.kext`
covers socket, sound, input, storage and biometrics, not graphics).

The passthrough route is written up in [`vfio/`](../vfio/README.md). It is
**reference material, not a plan** — it needs hardware this machine does not
have and would mean giving up Windows as the primary OS. See
"Is this worth doing?" there before considering it.

## File map

| Path                                                                              | Role                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [scripts/boot-mac.sh](../scripts/boot-mac.sh)                                     | The QEMU command line. Synced into `~/OSX-KVM/` on every launch.   |
| [scripts/mac-branch.ps1](../scripts/mac-branch.ps1)                               | Branch manager: `-List` / `-Use` / `-Reset` / `-Stop`.             |
| [scripts/mac-connect-spice.ps1](../scripts/mac-connect-spice.ps1)                 | Connect over SPICE (preferred transport).                          |
| [scripts/mac-perf-tune.sh](../scripts/mac-perf-tune.sh)                           | Post-upgrade tuning: Spotlight off, animations off, no sleep.      |
| [scripts/mac-skip-setup-assistant.sh](../scripts/mac-skip-setup-assistant.sh)     | Dismiss the post-upgrade MiniBuddy wizard.                         |
| [scripts/mac-enable-autologin.sh](../scripts/mac-enable-autologin.sh)             | Auto-login so restarts land on the desktop, not the login window.  |
| [scripts/mac-enable-vnc-legacy.sh](../scripts/mac-enable-vnc-legacy.sh)           | Let standard VNC clients use Screen Sharing on `:5901`.            |
| [scripts/mac-restore-window-shadows.sh](../scripts/mac-restore-window-shadows.sh) | Undo the `CHROME_HEADLESS` shadow suppression.                     |
| [scripts/mac-fix-tahoe-electron-lag.sh](../scripts/mac-fix-tahoe-electron-lag.sh) | Tahoe Electron `_cornerMask` workaround (`REVERT=1` to undo).      |
| [scripts/mac-fix-audio-output.sh](../scripts/mac-fix-audio-output.sh)             | Select the QEMU sound card over BlackHole as default output.       |
| [scripts/mac-watch-install.sh](../scripts/mac-watch-install.sh)                   | Install watcher; distinguishes real progress from a spin-hang.     |
| [scripts/mac-guest-shutdown.sh](../scripts/mac-guest-shutdown.sh)                 | Clean in-guest shutdown over SSH.                                  |
| [scripts/run-mac-foreground.sh](../scripts/run-mac-foreground.sh)                 | WSL-side runner; the foreground process whose lifetime gates QEMU. |
| [scripts/watchdog-mac.ps1](../scripts/watchdog-mac.ps1)                           | Windows-side restart loop; holds the WSL handle.                   |
| [scripts/spawn-watchdog.ps1](../scripts/spawn-watchdog.ps1)                       | Detached launcher used by the web UI Server Action.                |
| [src/lib/providers/local-kvm.ts](../src/lib/providers/local-kvm.ts)               | `LocalKvmProvider` (verify, list, start, stop, stats, QMP).        |
