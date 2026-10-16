#!/usr/bin/env bash
# vmui — boot macOS in QEMU/KVM with VNC + QMP control surface
# Designed for WSL2 Ubuntu; connect from Windows with any VNC client to localhost:5900
set -euo pipefail

cd "$(dirname "$0")"

ALLOCATED_RAM="${ALLOCATED_RAM:-16384}"   # MiB
CPU_SOCKETS="1"
CPU_CORES="${CPU_CORES:-4}"               # macOS works best with <=8 cores; 4 is the sweet spot
CPU_THREADS="${CPU_THREADS:-8}"

VNC_PORT="${VNC_PORT:-0}"                 # QEMU adds 5900; 0 means port 5900
QMP_PORT="${QMP_PORT:-4444}"
SSH_FORWARD_PORT="${SSH_FORWARD_PORT:-10022}"
SPICE_PORT="${SPICE_PORT:-5930}"          # connect with virt-viewer / remote-viewer
ARD_FORWARD_PORT="${ARD_FORWARD_PORT:-5901}"  # host:5901 -> guest:5900 (Apple Screen Sharing)
NAME="${VM_NAME:-vmui-mac}"
# Address VNC/SPICE listen on. 0.0.0.0 locally (WSL2 -> Windows); the devcloud GCE host
# (infra/devcloud/mac, DC-053) sets 127.0.0.1 so the unauthenticated displays are reachable
# only through the IAP SSH tunnel.
MAC_BIND="${MAC_BIND:-0.0.0.0}"

# SPICE tuning.
#
# The macOS framebuffer driver (AppleBochVGAFB) exposes NO hardware cursor
# ("IOFBCursorInfo" is empty), so macOS composites the pointer straight into
# the framebuffer and SPICE never negotiates a cursor channel. Every mouse
# move therefore arrives as a framebuffer damage rectangle.
#
# `streaming-video=all` (the QEMU default is `filter`) makes the server treat
# rapidly-changing regions as a video stream. That is right for actual video
# but wrong for a moving cursor: the pointer rect gets buffered into a stream
# and lags. `off` sends those rects immediately as normal image updates.
#
# `agent-mouse=off` keeps pointer handling on the emulated absolute tablet
# rather than a guest agent — there is no spice-vdagent for macOS, so the
# agent path can only add latency.
MAC_SPICE_STREAMING="${MAC_SPICE_STREAMING:-off}"
MAC_SPICE_AGENT_MOUSE="${MAC_SPICE_AGENT_MOUSE:-off}"

# Which macOS system disk to boot.
#
# `mac_hdd_ng.img` is the FROZEN golden base (chmod 444, macOS 15.7.5) and is
# never booted directly — every bootable disk is a qcow2 overlay on top of it,
# so an OS upgrade can be tested and reverted without touching the base.
# Branches are managed with scripts/mac-branch.ps1 (-List / -Use / -Reset).
#
#   mac-tahoe.qcow2   macOS Tahoe 26.6.2 (25G83)   <- default
#   mac-retry.qcow2   macOS Sequoia 15.7.9 (24G830)
#   mac-current.qcow2 macOS Sequoia 15.7.5 (24G624, the original)
MAC_DISK="${MAC_DISK:-mac-tahoe.qcow2}"

# Audio backend.
#
#   spice  stream guest audio to the connected SPICE client (remote-viewer on
#          Windows), so you actually hear the Mac. Requires a SPICE session;
#          with no client attached the guest still sees a working sound card,
#          the samples are simply discarded.
#   wav    dump audio to $MAC_AUDIO_WAV instead. Useful for capturing output
#          headlessly; this was the previous default and meant sound was
#          silently written to a file rather than played anywhere.
#   none   no sound device wiring at all.
MAC_AUDIO="${MAC_AUDIO:-spice}"
MAC_AUDIO_WAV="${MAC_AUDIO_WAV:-/tmp/vmui-mac-audio.wav}"

# Which emulated sound card to expose.
#
#   hda        Intel HD Audio (ich9) + line-out codec. macOS has a native
#              AppleHDA path, so this is the one most likely to produce a real
#              CoreAudio output device. Default.
#   usb-audio  QEMU's USB audio card. Enumerates fine (visible in `info usb`
#              and ioreg) but on Tahoe macOS attaches only an
#              AppleUSBAudioControlNub and never instantiates an
#              AppleUSBAudioEngine, so CoreAudio sees NO output device
#              (verified 2026-08-19; `multi=off` did not help).
#   ac97       Legacy Intel 82801AA. Last resort.
MAC_AUDIO_DEVICE="${MAC_AUDIO_DEVICE:-hda}"
MAC_AUDIO_MULTI="${MAC_AUDIO_MULTI:-off}"   # usb-audio only

case "$MAC_AUDIO_DEVICE" in
  hda)
    SOUND_DEV=(-device "ich9-intel-hda,id=sound0"
               -device "hda-output,bus=sound0.0,cad=0,audiodev=audio0")
    ;;
  usb-audio)
    SOUND_DEV=(-device "usb-audio,audiodev=audio0,bus=xhci.0,multi=$MAC_AUDIO_MULTI")
    ;;
  ac97)
    SOUND_DEV=(-device "AC97,audiodev=audio0")
    ;;
  *)
    echo "ERROR: unsupported MAC_AUDIO_DEVICE=$MAC_AUDIO_DEVICE (expected hda|usb-audio|ac97)" >&2
    exit 2
    ;;
esac

case "$MAC_AUDIO" in
  spice) AUDIO_DEV=(-audiodev "spice,id=audio0") ;;
  wav)   AUDIO_DEV=(-audiodev "wav,id=audio0,path=$MAC_AUDIO_WAV") ;;
  none)  AUDIO_DEV=(-audiodev "none,id=audio0") ;;
  *)
    echo "ERROR: unsupported MAC_AUDIO=$MAC_AUDIO (expected spice|wav|none)" >&2
    exit 2
    ;;
esac

# Display adapter.
#
# DO NOT change this line without testing interactively over VNC. Two things
# were tried on 2026-08-18 and both regressed:
#   vmware-svga            -> VRAM 7 MB -> 3 MB, no mode set, GUI never came up
#                             (macOS has no built-in VMware SVGA driver; it
#                             ships with VMware Fusion Tools).
#   VGA + refresh_rate=30  -> broke mouse input over VNC.
# The stock line below is the known-good configuration.
#
# VNC encoding: measured 166 qemu ticks/5s idle vs 817 while the guest
# repaints, with WindowServer inside the guest at 0.0% — the cost is QEMU
# encoding a 1920x1080 framebuffer, not macOS drawing it. `lossy=on` lets the
# encoder use JPEG for busy tiles, which cuts that encode cost substantially.
# It affects only the encoder, never the display device or the input path.
MAC_VNC_LOSSY="${MAC_VNC_LOSSY:-on}"

# Required by macOS guest
if ! cat /sys/module/kvm/parameters/ignore_msrs 2>/dev/null | grep -q Y; then
  echo 1 | sudo tee /sys/module/kvm/parameters/ignore_msrs >/dev/null || true
fi

MY_OPTIONS="+ssse3,+sse4.2,+popcnt,+avx,+aes,+xsave,+xsaveopt,check"

# This is the EXACT config that successfully booted macOS Sequoia and wrote
# 33 GB before the SSV-sealing pause. Skylake-Client's QEMU CPU definition
# already includes AVX2, BMI1, BMI2, FMA — adding them explicitly is a no-op,
# but adding +xsavec,+xgetbv1 triggers a guest triple-fault on QEMU 6.2.
# -hle,-rtm strip TSX bits Apple's kernel rejects on synthesized CPU models.
CPU="Skylake-Client,-hle,-rtm,kvm=on,vendor=GenuineIntel,+invtsc,vmware-cpuid-freq=on,$MY_OPTIONS"

# We deliberately omit the GUI display and use VNC instead so vmui can connect
# from Windows (WSLg windows don't survive headless server-mode invocations).
# QMP is exposed on a TCP socket for control by vmui.

exec qemu-system-x86_64 \
  -name "$NAME" \
  -enable-kvm -m "$ALLOCATED_RAM" \
  -cpu "$CPU" \
  -machine q35 \
  -smp "$CPU_THREADS",cores="$CPU_CORES",sockets="$CPU_SOCKETS" \
  -device qemu-xhci,id=xhci \
  -device usb-kbd,bus=xhci.0 -device usb-tablet,bus=xhci.0 \
  -device usb-ehci,id=ehci \
  -device isa-applesmc,osk="ourhardworkbythesewordsguardedpleasedontsteal(c)AppleComputerInc" \
  -drive if=pflash,format=raw,readonly=on,file="OVMF_CODE_4M.fd" \
  -drive if=pflash,format=raw,file="OVMF_VARS-1920x1080.fd" \
  -smbios type=2 \
  "${AUDIO_DEV[@]}" \
  "${SOUND_DEV[@]}" \
  -device ich9-ahci,id=sata \
  -drive id=OpenCoreBoot,if=none,snapshot=on,format=qcow2,file="OpenCore/OpenCore.qcow2" \
  -device ide-hd,bus=sata.2,drive=OpenCoreBoot \
  -drive id=MacHDD,if=none,file="$MAC_DISK",format=qcow2 \
  -device ide-hd,bus=sata.4,drive=MacHDD \
  -netdev user,id=net0,hostfwd=tcp:"$MAC_BIND":"$SSH_FORWARD_PORT"-:22,hostfwd=tcp:"$MAC_BIND":"$ARD_FORWARD_PORT"-:5900 \
  -device vmxnet3,netdev=net0,id=net0,mac=52:54:00:c9:18:27 \
  -monitor none \
  -device VGA,edid=on,xres=1920,yres=1080,vgamem_mb=128 \
  -vnc "$MAC_BIND:$VNC_PORT,lossy=$MAC_VNC_LOSSY" \
  -spice port="$SPICE_PORT",addr="$MAC_BIND",disable-ticketing=on,image-compression=auto_glz,jpeg-wan-compression=auto,zlib-glz-wan-compression=auto,streaming-video="$MAC_SPICE_STREAMING",agent-mouse="$MAC_SPICE_AGENT_MOUSE",playback-compression=off \
  -device virtio-serial-pci \
  -chardev spicevmc,id=spicechannel0,name=vdagent \
  -device virtserialport,chardev=spicechannel0,name=com.redhat.spice.0 \
  -qmp tcp:127.0.0.1:"$QMP_PORT",server=on,wait=off \
  -no-reboot \
  -d guest_errors -D /tmp/vmui-mac.qemu.log \
  -pidfile /tmp/vmui-mac.pid
