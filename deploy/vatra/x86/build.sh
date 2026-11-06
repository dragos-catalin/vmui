#!/usr/bin/env bash
# Build the Vatra x86-64 virtual appliance with Packer (QEMU/KVM) and smoke-boot it. Runs as root
# on a cloud VM with nested virtualisation:
#   node scripts/e2e-cloud/run.mjs --nested --machine n2-standard-8 --max-run 3h \
#     --cmd "bash deploy/vatra/x86/build.sh" --fetch test-results
# Out: test-results/x86-image/ (logs, SHA256SUMS, smoke); qcow2 + OVA + VHDX to $RUN/x86-image/.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
X="$SRC/deploy/vatra/x86"
OUT="$SRC/test-results/x86-image"
PACKER_VERSION=1.16.2
mkdir -p "$OUT"
say() { echo "== $*" | tee -a "$OUT/build.txt"; }
step() { echo "::phase $1 $(( $(date +%s) - ${T0:=$(date +%s)} ))s"; }
[ "$(dpkg --print-architecture)" = amd64 ] || { say "needs an amd64 host"; exit 1; }
VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$SRC/package.json")"

step deps
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl unzip jq zstd qemu-system-x86 qemu-utils \
  genisoimage xorriso openssh-client >/dev/null
ACCEL=kvm
[ -e /dev/kvm ] || { ACCEL=tcg; say "no /dev/kvm: TCG (slow)"; }
if ! command -v docker >/dev/null; then
  install -d /etc/docker
  echo '{"features":{"containerd-snapshotter":true}}' > /etc/docker/daemon.json
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
fi
if ! command -v packer >/dev/null; then
  curl -fsSL -o /tmp/packer.zip "https://releases.hashicorp.com/packer/${PACKER_VERSION}/packer_${PACKER_VERSION}_linux_amd64.zip"
  curl -fsSL -o /tmp/packer.sums "https://releases.hashicorp.com/packer/${PACKER_VERSION}/packer_${PACKER_VERSION}_SHA256SUMS"
  (cd /tmp && grep "linux_amd64.zip" packer.sums | sed 's/packer_.*_linux_amd64.zip/packer.zip/' | sha256sum -c -) >/dev/null
  unzip -q -o /tmp/packer.zip -d /usr/local/bin
fi
say "packer $(packer version | head -n1), accel $ACCEL"

step stack
BAKE=/srv/vatra-bake
bash "$SRC/deploy/vatra/bake.sh" amd64 "$BAKE" "$OUT" | tee -a "$OUT/build.txt"

step packer
SEED=/srv/vatra-seed; rm -rf "$SEED"; mkdir -p "$SEED"
ssh-keygen -q -t ed25519 -N '' -f "$SEED/packer_key"
echo "instance-id: vatra-build" > "$SEED/meta-data"
cat > "$SEED/user-data" <<EOF
#cloud-config
users:
  - name: packer
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$SEED/packer_key.pub")
EOF
W=/srv/vatra-x86; rm -rf "$W"; mkdir -p "$W"
cd "$W"
packer init "$X" >"$OUT/packer-init.log" 2>&1
P=/srv/vatra-payload; rm -rf "$P"; mkdir -p "$P/src/deploy" "$P/src/pi"
cp -a "$SRC/deploy/vatra" "$P/src/deploy/"; cp "$SRC/pi/avahi-vmui.service" "$P/src/pi/"; cp -a "$BAKE" "$P/bake"
tar -C "$P" -cf /srv/vatra-payload.tar src bake
PACKER_LOG=0 packer build -color=false -var "version=$VERSION" -var "payload=/srv/vatra-payload.tar" -var "seed_dir=$SEED" \
  -var "accel=$ACCEL" "$X" > "$OUT/packer.log" 2>&1 || { tail -n 60 "$OUT/packer.log"; say "packer failed"; exit 1; }
rm -rf "$SEED"
QCOW="$W/output/vatra-hub-x86-$VERSION.qcow2"
say "qcow2 $(du -h "$QCOW" | cut -f1)"

step smoke
bash "$X/smoke.sh" "$QCOW" "$OUT" "$ACCEL" || { say "SMOKE FAILED"; exit 1; }

step package
DIST=/srv/vatra-x86-dist; rm -rf "$DIST"; mkdir -p "$DIST"
cp "$QCOW" "$DIST/"
qemu-img convert -O vhdx -o subformat=dynamic "$QCOW" "$DIST/vatra-hub-x86-$VERSION.vhdx"
qemu-img convert -O vmdk -o subformat=streamOptimized "$QCOW" "$W/vatra-hub-x86-$VERSION-disk1.vmdk"
bash "$X/ova.sh" "$W/vatra-hub-x86-$VERSION-disk1.vmdk" "$VERSION" "$DIST/vatra-hub-x86-$VERSION.ova"
(cd "$DIST" && sha256sum ./* | sed 's| \./| |') > "$OUT/SHA256SUMS"
cp "$OUT/SHA256SUMS" "$DIST/"
ls -la "$DIST" | tee -a "$OUT/build.txt"
if [ -n "${RUN:-}" ] && declare -F gsput >/dev/null; then
  for f in "$DIST"/*; do gsput "$f" "x86-image/$(basename "$f")"; done
  say "uploaded to $RUN/x86-image/"
fi
say "X86 IMAGE OK"
