#!/usr/bin/env bash
# A/B OS smoke on x86 (P5-04): boot the A/B disk in QEMU + OVMF (real systemd-boot, EFI variables
# in a writable OVMF_VARS), then drive vatra-updater the way a hub does:
#   1. boot slot A: Rugix as init, EROFS root, data partition, rugix-ctrl system info shows a/b
#   2. signed manifest with os 1.x+1 -> bundle into slot B -> one-shot reboot -> health -> commit
#   3. signed manifest with a broken OS (docker masked) -> slot A -> health fails -> reboot without
#      commit -> systemd-boot returns to B, update-status.json os.result = fell-back
#   bash ab-smoke-x86.sh <ab dir from ab-image.sh> <version> <out dir> [kvm|tcg]
set -euo pipefail
ABD="$1"; VERSION="$2"; OUT="$3"; ACCEL="${4:-kvm}"
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
X86="$SRC/deploy/vatra/x86"
OS="$SRC/deploy/vatra/os"
W=/srv/vatra-ab-smoke; rm -rf "$W"; mkdir -p "$W" "$OUT"
LOG="$OUT/ab-smoke.txt"; : > "$LOG"
T0=$(date +%s)
say() { echo "== [$(( $(date +%s) - T0 ))s] $*" | tee -a "$LOG"; }
FAIL=0
check() { if [ "$2" = ok ]; then say "ok   $1"; else say "FAIL $1 ($2)"; FAIL=1; fi; }
die() { say "FAIL $*"; guest_dump fail; stop_vm; exit 1; }

bump() { python3 -c 'import sys;a,b,c=sys.argv[1].split("-")[0].split(".");print(f"{a}.{b}.{int(c)+int(sys.argv[2])}")' "$1" "$2"; }
V2="$(bump "$VERSION" 1)"; V3="$(bump "$VERSION" 2)"
say "A/B smoke: image $VERSION, good update $V2, broken update $V3, accel $ACCEL"

# --- host side: cosign (same pin as the updater installer), bundles, signed manifests ----------
COSIGN_VERSION="$(sed -n 's/^COSIGN_VERSION=//p' "$SRC/deploy/vatra/updater/install.sh")"
COSIGN_SHA="$(sed -n 's/^ *\[amd64\]=//p' "$SRC/deploy/vatra/updater/install.sh" | head -n1)"
if ! command -v cosign >/dev/null; then
  curl -fsSL -o /usr/local/bin/cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"
  echo "$COSIGN_SHA  /usr/local/bin/cosign" | sha256sum -c - >/dev/null
  chmod 0755 /usr/local/bin/cosign
fi
export COSIGN_PASSWORD=""
(cd "$W" && cosign generate-key-pair >/dev/null 2>&1)
SRV="$W/srv"; mkdir -p "$SRV"
cp "$W/cosign.pub" "$SRV/cosign.pub"

R="$ABD/rootfs"
t=$(date +%s)
bash "$OS/bundle.sh" --platform x86 --rootfs "$R" --version "$V2" --out "$SRV/v2" | tee -a "$LOG"
ln -sf /dev/null "$R/etc/systemd/system/docker.service"
ln -sf /dev/null "$R/etc/systemd/system/docker.socket"
bash "$OS/bundle.sh" --platform x86 --rootfs "$R" --version "$V3" --out "$SRV/v3" | tee -a "$LOG"
rm -f "$R/etc/systemd/system/docker.service" "$R/etc/systemd/system/docker.socket"
rm -rf "$SRV"/v*/payloads-*
say "two follow-up bundles built in $(( $(date +%s) - t ))s"

manifest() { # $1 = v2|v3 -> $SRV/stable.json + .sigstore, bundle URL on the QEMU host address
  node "$SRC/scripts/channel-manifest.mjs" --channel stable --version "$VERSION" \
    --image "ghcr.io/smoke/vatra@sha256:$(printf '0%.0s' $(seq 64))" \
    --os-index "$SRV/$1/os-index.json" --os-base-url "https://smoke.invalid/$1/" > "$W/m.json"
  sed 's#https://smoke.invalid/#http://10.0.2.2:8000/#g' "$W/m.json" > "$SRV/stable.json"
  (cd "$SRV" && cosign sign-blob --yes --key "$W/cosign.key" --use-signing-config=false --tlog-upload=false \
    --bundle stable.json.sigstore stable.json >/dev/null 2>"$W/sign.log") || { cat "$W/sign.log"; exit 1; }
  python3 -c 'import json,sys;o=json.load(open(sys.argv[1]))["os"];p=o["platforms"]["x86"];print("manifest os",o["version"],p["size"],"bytes sha256",p["sha256"][:16],"hash",p["bundleHash"][:24])' "$SRV/stable.json" | tee -a "$LOG"
}
cat > "$SRV/setup.sh" <<'EOF'
set -e
curl -fsS -o /srv/vatra/cosign.pub http://10.0.2.2:8000/cosign.pub
cat > /srv/vatra/updater.json <<'J'
{ "channel": "stable", "manifest_url": "http://10.0.2.2:8000/stable.json", "verify": "key",
  "public_key": "/srv/vatra/cosign.pub", "insecure_ignore_tlog": true,
  "os_reboot_window": "always", "os_health_timeout": 300, "health_timeout": { "default": 120 } }
J
echo setup-ok
EOF
(cd "$SRV" && python3 -m http.server 8000 --bind 127.0.0.1 >"$W/http.log" 2>&1 &)

# --- the VM -------------------------------------------------------------------------------------
CODE=/usr/share/OVMF/OVMF_CODE_4M.fd; VARS=/usr/share/OVMF/OVMF_VARS_4M.fd
[ -f "$CODE" ] || { CODE=/usr/share/OVMF/OVMF_CODE.fd; VARS=/usr/share/OVMF/OVMF_VARS.fd; }
cp "$VARS" "$W/vars.fd"
# a user's disk is bigger than the 16 GiB image: vatra-firstboot grows the data partition
qemu-img create -q -f qcow2 -b "$ABD/vatra-hub-x86-ab-$VERSION.qcow2" -F qcow2 "$W/hub.qcow2" 32G
qemu-system-x86_64 -machine q35 -accel "$ACCEL" -cpu max -smp 4 -m 4096 -display none \
  -drive "if=pflash,format=raw,unit=0,readonly=on,file=$CODE" -drive "if=pflash,format=raw,unit=1,file=$W/vars.fd" \
  -serial "file:$OUT/ab-console.log" -drive "file=$W/hub.qcow2,if=virtio,cache=unsafe" \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:23737-:3737 -device virtio-net-pci,netdev=n0 \
  -device virtio-serial -chardev "socket,path=$W/qga,server=on,wait=off,id=qga0" \
  -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 \
  -monitor "unix:$W/mon,server,nowait" -daemonize -pidfile "$W/qemu.pid"
stop_vm() {
  echo quit | socat - "UNIX-CONNECT:$W/mon" >/dev/null 2>&1 || kill "$(cat "$W/qemu.pid" 2>/dev/null)" 2>/dev/null || true
}
trap stop_vm EXIT
# g '<shell>' [seconds]: run in the guest through qemu-guest-agent, print stdout ('' if unreachable)
g() { timeout $(( ${2:-60} + 30 )) python3 "$X86/qga-exec.py" "$W/qga" "$1" "${2:-60}" 2>/dev/null || true; }
# waitfor <seconds> <shell> <expected regex>
waitfor() {
  local end=$(( $(date +%s) + $1 )) out
  while [ "$(date +%s)" -lt "$end" ]; do
    out="$(g "$2" 20)"
    if printf '%s' "$out" | grep -qE "$3"; then printf '%s' "$out"; return 0; fi
    sleep 5
  done
  return 1
}
guest_dump() {
  g 'echo "== release"; cat /etc/vatra-os-release; echo "== rugix"; rugix-ctrl system info; echo "== mounts"; findmnt -no TARGET,SOURCE,FSTYPE / /run/rugix/mounts/system /run/rugix/mounts/data /srv/vatra /var/lib/docker /boot/efi; echo "== efi"; bootctl status --no-pager 2>&1 | head -n 30; echo "== status"; cat /srv/vatra/data/update-status.json; echo "== apply log"; tail -n 40 /srv/vatra/data/os-apply.log; echo "== health"; journalctl -b -u vatra-os-health --no-pager | tail -n 30; echo "== docker"; docker ps -a 2>&1 | head' 120 \
    > "$OUT/ab-guest-$1.txt" 2>&1
}
osver='. /etc/vatra-os-release; echo "VER=$VERSION"'
info() { g 'rugix-ctrl system info' 30; }
field() { python3 -c 'import json,sys
try: d=json.loads(sys.stdin.read() or "{}")
except ValueError: d={}
for k in sys.argv[1].split("."):
  c=k.split("_")[0]+"".join(w.title() for w in k.split("_")[1:])
  d=(d.get(k, d.get(c)) if isinstance(d,dict) else None)
print(d)' "$1"; }
health_done='systemctl is-active vatra-os-health; systemctl show -p ExecMainStatus --value vatra-os-health'

# --- 1. first boot on slot A ---------------------------------------------------------------------
say "boot 1 (slot A, $VERSION)"
t=$(date +%s)
waitfor 420 "$osver" "VER=$VERSION" >/dev/null || die "guest agent never answered on boot 1 (see ab-console.log)"
check "booted $VERSION, guest agent up after $(( $(date +%s) - t ))s" ok
for _ in $(seq 1 60); do curl -fsS --max-time 4 http://127.0.0.1:23737/api/discover >/dev/null 2>&1 && break; sleep 5; done
d="$(curl -fsS --max-time 4 http://127.0.0.1:23737/api/discover 2>&1 | head -c 200)"
printf '%s' "$d" | grep -q '"claimed"' && check "hub answers /api/discover after $(( $(date +%s) - t ))s: $d" ok || check "/api/discover" "$d"
I="$(info)"; echo "$I" > "$OUT/rugix-info-1.json"
[ "$(echo "$I" | field boot.active_group)" = a ] && [ "$(echo "$I" | field boot.boot_flow)" = systemd-boot ] \
  && check "rugix-ctrl system info: flow systemd-boot, active a, default $(echo "$I" | field boot.default_group), slots $(echo "$I" | python3 -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin)["slots"])))' 2>/dev/null)" ok \
  || check "rugix-ctrl system info" "$I"
[ "$(echo "$I" | field state.status)" = Active ] && check "state management active (data partition mounted)" ok || check "state management" "$(echo "$I" | field state)"
fs="$(g 'findmnt -no FSTYPE /run/rugix/mounts/system; findmnt -no FSTYPE /run/rugix/mounts/data; touch /usr/x 2>&1 | head -c 80' 20)"
echo "$fs" | head -n1 | grep -qx erofs && echo "$fs" | sed -n 2p | grep -qx ext4 \
  && check "system slot is EROFS, data is ext4: $(echo "$fs" | tr '\n' ' ')" ok || check "filesystems" "$fs"
g 'echo v1-state > /srv/vatra/data/ab-marker' 10 >/dev/null
guest_dump 1
waitfor 300 "$health_done" '^active' >/dev/null || say "warn: vatra-os-health not finished on boot 1"

# --- 2. good update A -> B -------------------------------------------------------------------------
manifest v2
out="$(g 'curl -fsS http://10.0.2.2:8000/setup.sh | sh' 30)"
echo "$out" | grep -q setup-ok || die "guest config: $out"
say "update to $V2 (os-apply detached in the guest)"
t=$(date +%s)
g 'systemd-run --unit=vatra-os-apply-1 --collect /bin/sh -c "/usr/local/bin/vatra-updater os-apply >> /srv/vatra/data/os-apply.log 2>&1"' 20 >/dev/null
waitfor 900 "$osver" "VER=$V2" >/dev/null || die "never booted $V2"
check "rebooted into $V2 $(( $(date +%s) - t ))s after os-apply" ok
waitfor 600 "$health_done" '^active' >/dev/null || die "vatra-os-health did not finish on $V2"
I="$(info)"; echo "$I" > "$OUT/rugix-info-2.json"
st="$(g 'cat /srv/vatra/data/update-status.json' 10)"; echo "$st" > "$OUT/status-2.json"
a="$(echo "$I" | field boot.active_group)"; dflt="$(echo "$I" | field boot.default_group)"
[ "$a" = b ] && [ "$dflt" = b ] && [ "$(echo "$st" | field os.result)" = committed ] \
  && check "slot B committed by the health unit $(( $(date +%s) - t ))s after os-apply (active $a, default $dflt, os.result committed)" ok \
  || check "commit on B" "active=$a default=$dflt os=$(echo "$st" | field os)"
[ "$(g 'cat /srv/vatra/data/ab-marker' 10 | tr -d '\r\n')" = v1-state ] && check "/srv/vatra/data survived the OS switch" ok || check "state across switch" "marker lost"
g 'grep -E "installing OS|rebooting into" /srv/vatra/data/os-apply.log' 10 | tee -a "$LOG"
g 'journalctl -b -u vatra-os-health --no-pager -o cat | grep vatra-updater' 10 | tee -a "$LOG"
guest_dump 2

# --- 3. broken update B -> A falls back to B -------------------------------------------------------
manifest v3
say "update to the broken $V3 (docker masked in its system image)"
t=$(date +%s)
g 'systemd-run --unit=vatra-os-apply-2 --collect /bin/sh -c "/usr/local/bin/vatra-updater os-apply >> /srv/vatra/data/os-apply.log 2>&1"' 20 >/dev/null
if waitfor 900 "$osver" "VER=$V3" >/dev/null; then
  check "booted the broken $V3 on slot A once ($(( $(date +%s) - t ))s)" ok
else
  check "boot into $V3" "never seen (it may have fallen back before the agent answered)"
fi
waitfor 900 "$osver" "VER=$V2" >/dev/null || die "did not come back to $V2"
waitfor 600 "$health_done" '^active' >/dev/null || die "vatra-os-health did not finish after the fallback"
I="$(info)"; echo "$I" > "$OUT/rugix-info-3.json"
st="$(g 'cat /srv/vatra/data/update-status.json' 10)"; echo "$st" > "$OUT/status-3.json"
a="$(echo "$I" | field boot.active_group)"; dflt="$(echo "$I" | field boot.default_group)"
[ "$a" = b ] && [ "$dflt" = b ] && [ "$(echo "$st" | field os.result)" = fell-back ] \
  && check "broken $V3 fell back to committed slot B $(( $(date +%s) - t ))s after os-apply (reason: $(echo "$st" | field os.reason))" ok \
  || check "fallback" "active=$a default=$dflt os=$(echo "$st" | field os)"
curl -fsS --max-time 4 http://127.0.0.1:23737/api/discover >/dev/null 2>&1 && check "hub serving again on $V2" ok || check "hub after fallback" "no /api/discover"
g 'grep -E "installing OS|rebooting into" /srv/vatra/data/os-apply.log | tail -n 2' 10 | tee -a "$LOG"
g 'journalctl --list-boots --no-pager | tail -n 3; journalctl -b -1 -u vatra-os-health --no-pager -o cat | grep vatra-updater; journalctl -b -u vatra-os-health --no-pager -o cat | grep vatra-updater' 15 | tee -a "$LOG"
guest_dump 3

stop_vm; trap - EXIT
grep -aE 'Rugix|rugix' "$OUT/ab-console.log" | head -n 20 > "$OUT/ab-console-rugix.txt" || true
[ "$FAIL" = 0 ] && say "AB SMOKE OK" || { say "AB SMOKE FAILED"; exit 1; }
