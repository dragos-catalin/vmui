#!/bin/bash
# devcloud DC-053: macOS (OSX-KVM) host on a GCE C4 VM with nested virtualization.
# Runs as the GCE startup script on every boot. Idempotent.
#   - installs QEMU 8.2 + tools, sets kvm ignore_msrs (macOS needs it)
#   - mounts the persistent data disk (device name "mac-data") at /var/lib/vmui-mac
#   - first boot only: pulls the disk chain from gs://<bucket>/<prefix>/ onto the data disk
#   - writes + starts vmui-mac.service (scripts/boot-mac.sh from the metadata, bound to 127.0.0.1)
#   - writes + starts vmui-mac-idle.timer: no session for <idle-min> -> the VM SUSPENDS itself with
#     macOS still running (role devcloudMacSelfStop on this instance only). Verified 2026-10-17:
#     suspend 31 s / resume 22 s, same QEMU pid, guest live. Suspended = only disk + RAM-image cost.
set -u
MD=http://metadata.google.internal/computeMetadata/v1/instance
md() { curl -fsS -H 'Metadata-Flavor: Google' "$MD/attributes/$1" 2>/dev/null; }
log() { echo "::mac-host $*" | tee /dev/ttyS0; logger -t vmui-mac "$*"; }

BUCKET=$(md mac-bucket); PREFIX=$(md mac-prefix); DISK=$(md mac-disk); IDLE_MIN=$(md mac-idle-min)
RAM=$(md mac-ram-mb); CORES=$(md mac-cores); THREADS=$(md mac-threads)
: "${PREFIX:=v1}" "${DISK:=mac-tahoe.qcow2}" "${IDLE_MIN:=15}" "${RAM:=32768}" "${CORES:=8}" "${THREADS:=16}"
DATA=/var/lib/vmui-mac
log "boot $(date -u +%FT%TZ) vmx=$(grep -cw vmx /proc/cpuinfo) clocksource=$(cat /sys/devices/system/clocksource/clocksource0/current_clocksource)"

if ! command -v qemu-system-x86_64 >/dev/null || ! command -v convert >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq qemu-system-x86 qemu-utils ovmf imagemagick python3 >/dev/null 2>&1
fi
echo 'options kvm ignore_msrs=1 report_ignored_msrs=0' > /etc/modprobe.d/kvm-mac.conf
echo 1 > /sys/module/kvm/parameters/ignore_msrs 2>/dev/null || true

# --- data disk (persistent, survives stop/start; snapshots are taken of THIS disk)
DEV=/dev/disk/by-id/google-mac-data
if [ -e "$DEV" ]; then
  blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -q -L vmui-mac "$DEV"
  mkdir -p "$DATA"
  mountpoint -q "$DATA" || mount -o discard,defaults "$DEV" "$DATA"
  grep -q vmui-mac /etc/fstab || echo "LABEL=vmui-mac $DATA ext4 discard,defaults,nofail 0 2" >> /etc/fstab
else
  log "WARN no mac-data disk attached; using the boot disk"; mkdir -p "$DATA"
fi

# --- first boot: pull the disk chain (base keeps its relative backing name)
cd "$DATA"
for f in OpenCore/OpenCore.qcow2 OVMF_CODE_4M.fd OVMF_VARS-1920x1080.fd mac_hdd_ng.img "$DISK"; do
  if [ ! -s "$f" ]; then
    mkdir -p "$(dirname "$f")"; T0=$(date +%s)
    gcloud storage cp "gs://$BUCKET/$PREFIX/$f" "$f.part" -q && mv "$f.part" "$f" \
      && log "pulled $f in $(( $(date +%s) - T0 ))s" || log "ERROR pull $f"
  fi
done
chmod 444 mac_hdd_ng.img 2>/dev/null || true
md boot-mac > boot-mac.sh && chmod +x boot-mac.sh

# --- QEMU service: boot-mac.sh unchanged, but every listener on loopback (IAP/Tailscale reach it)
cat > /etc/systemd/system/vmui-mac.service <<EOF
[Unit]
Description=vmui macOS guest (OSX-KVM, DC-053)
After=network-online.target
[Service]
WorkingDirectory=$DATA
Environment=MAC_DISK=$DISK ALLOCATED_RAM=$RAM CPU_CORES=$CORES CPU_THREADS=$THREADS MAC_AUDIO=none MAC_BIND=127.0.0.1
ExecStart=$DATA/boot-mac.sh
ExecStop=/usr/local/bin/vmui-mac-shutdown
TimeoutStopSec=330
# boot-mac.sh passes -no-reboot, so a guest RESTART (macOS updates restart 2-3 times) exits QEMU with
# status 0. Restart=always brings it straight back; `systemctl stop` (vmui-mac-shutdown, -Stop) is
# never restarted by systemd. A shutdown from inside macOS also comes back: the idle timer is what
# puts an unused Mac to sleep here, not the guest's own power menu (2026-10-17, 26.7.1 update).
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/vmui-mac-qmp <<'EOF'
#!/usr/bin/env python3
# vmui-mac-qmp <hmp command> | shot <file.ppm>   (QMP on 127.0.0.1:4444)
import json, socket, sys
s = socket.create_connection(("127.0.0.1", 4444), timeout=10); f = s.makefile("rw")
f.readline(); f.write(json.dumps({"execute": "qmp_capabilities"}) + "\n"); f.flush(); f.readline()
if sys.argv[1] == "shot":
    f.write(json.dumps({"execute": "screendump", "arguments": {"filename": sys.argv[2]}}) + "\n")
elif sys.argv[1] == "powerdown":
    f.write(json.dumps({"execute": "system_powerdown"}) + "\n")
else:
    f.write(json.dumps({"execute": "human-monitor-command", "arguments": {"command-line": " ".join(sys.argv[1:])}}) + "\n")
f.flush(); print(f.readline().strip())
EOF
chmod +x /usr/local/bin/vmui-mac-qmp

# clean guest shutdown: ACPI power button (macOS honours it), wait up to 300 s
cat > /usr/local/bin/vmui-mac-shutdown <<'EOF'
#!/bin/bash
PID=$(cat /tmp/vmui-mac.pid 2>/dev/null) || exit 0
kill -0 "$PID" 2>/dev/null || exit 0
/usr/local/bin/vmui-mac-qmp powerdown >/dev/null 2>&1
for _ in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || exit 0; sleep 5; done
kill -TERM "$PID" 2>/dev/null; sleep 5; kill -KILL "$PID" 2>/dev/null; exit 0
EOF
chmod +x /usr/local/bin/vmui-mac-shutdown

# --- idle stop: "in use" = a connection to a guest port (SSH/VNC/SPICE/Screen Sharing arrive on
# 127.0.0.1 through the IAP SSH tunnel) or an interactive login on the host (a pts session).
# A bare tunnel with nothing using it does not keep the VM up.
cat > /usr/local/bin/vmui-mac-idle <<EOF
#!/bin/bash
STATE=/var/lib/vmui-mac/.last-active
guest=\$(ss -Htn state established '( sport = :10022 or sport = :5900 or sport = :5901 or sport = :5930 )' | wc -l)
ttys=\$(who | grep -c pts)
busy=\$(( guest + ttys ))
if [ "\$busy" -gt 0 ] || [ ! -f "\$STATE" ]; then date +%s > "\$STATE"; exit 0; fi
idle=\$(( \$(date +%s) - \$(cat "\$STATE") ))
[ "\$idle" -lt $(( IDLE_MIN * 60 )) ] && exit 0
logger -t vmui-mac "idle \${idle}s >= ${IDLE_MIN}m: suspending the VM (guest keeps running state)"
echo "::mac-host idle-suspend" > /dev/ttyS0
rm -f "\$STATE"
NAME=\$(curl -fsS -H 'Metadata-Flavor: Google' $MD/name)
ZONE=\$(curl -fsS -H 'Metadata-Flavor: Google' $MD/zone | awk -F/ '{print \$NF}')
gcloud compute instances suspend "\$NAME" --zone "\$ZONE" --quiet
EOF
chmod +x /usr/local/bin/vmui-mac-idle
cat > /etc/systemd/system/vmui-mac-idle.service <<'EOF'
[Unit]
Description=vmui mac idle check
[Service]
Type=oneshot
ExecStart=/usr/local/bin/vmui-mac-idle
EOF
cat > /etc/systemd/system/vmui-mac-idle.timer <<'EOF'
[Unit]
Description=vmui mac idle check every minute
[Timer]
OnBootSec=5min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF
rm -f "$DATA/.last-active"

# --- optional Tailscale (faster VNC/SPICE than IAP), personal tailnet taild1532d. The secret
# `devcloud-mac-tailscale-authkey` (dragos-devcloud, this SA has secretAccessor) holds an OAuth
# client secret (`tskey-client-...?ephemeral=false&preauthorized=true`, client "devcloud mac enrol
# DC053", scope auth_keys, tag:devcloud-mac only). tailscaled mints its own key from it, so it never
# expires like a 90-day auth key, and the node is tagged (no key expiry, policy in vmui
# infra/tailscale-home-acl.hujson: owner -> 10022/5900/5901/5930 + Tailscale SSH, node -> nothing).
# Without the secret the host stays IAP-only. Guest ports are served with `tailscale serve` (tcp),
# QEMU stays bound to 127.0.0.1. Re-running is idempotent (`up` on an enrolled node is a no-op).
TS_KEY=$(gcloud secrets versions access latest --secret=devcloud-mac-tailscale-authkey --project="$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/project/project-id)" 2>/dev/null)
if [ -n "$TS_KEY" ]; then
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
  tailscale up --auth-key="$TS_KEY" --advertise-tags=tag:devcloud-mac --hostname=vmui-mac --ssh --accept-dns=false >/dev/null 2>&1 \
    && for p in 10022 5900 5901 5930; do tailscale serve --bg --tcp "$p" "tcp://127.0.0.1:$p" >/dev/null 2>&1; done
  log "tailscale $(tailscale status --self --peers=false 2>/dev/null | awk 'NR==1{print $1, $2}')"
fi
unset TS_KEY
systemctl daemon-reload
systemctl enable --now vmui-mac.service vmui-mac-idle.timer
sleep 3
log "vmui-mac $(systemctl is-active vmui-mac) disk=$DISK ram=${RAM}MB cores=$CORES threads=$THREADS idle=${IDLE_MIN}m"
log "host-setup done"
