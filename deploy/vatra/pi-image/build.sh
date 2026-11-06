#!/usr/bin/env bash
# Build the Vatra Pi 4 + Pi 5 images with rpi-image-gen on a native arm64 Debian host, then boot
# the Pi 5 image in QEMU (smoke.sh). Runs as root on the cloud arm64 VM:
#   node scripts/e2e-cloud/run.mjs --arm64 --machine c4a-standard-16 --max-run 4h \
#     --cmd "bash deploy/vatra/pi-image/build.sh" --fetch test-results
# Env: VATRA_IMAGE_REF (pull a released image instead of building it from this tree),
#      PI_BOARDS (default "pi5 pi4"), SKIP_SMOKE=1.
# Out: test-results/pi-image/ (logs, os_list.json, SHA256SUMS, smoke results); the .img.xz files
# go to $RUN/pi-image/ when $RUN is set (bucket lifecycle: 14 days).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$SRC/test-results/pi-image"
IG_TAG=v2.9.0
BOARDS="${PI_BOARDS:-pi5 pi4}"
mkdir -p "$OUT"
say() { echo "== $*" | tee -a "$OUT/build.txt"; }
step() { echo "::phase $1 $(( $(date +%s) - ${T0:=$(date +%s)} ))s"; }
[ "$(dpkg --print-architecture)" = arm64 ] || { say "needs a native arm64 host"; exit 1; }
VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$SRC/package.json")"
DATE="$(date -u +%F)"
say "vatra $VERSION, rpi-image-gen $IG_TAG, boards: $BOARDS"

step deps
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends git ca-certificates curl zstd xz-utils sudo jq \
  qemu-system-arm qemu-utils dosfstools e2fsprogs fdisk linux-image-arm64 initramfs-tools >/dev/null
if ! command -v docker >/dev/null; then
  install -d /etc/docker
  echo '{"features":{"containerd-snapshotter":true}}' > /etc/docker/daemon.json
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
fi
say "docker $(docker version --format '{{.Server.Version}}'), store $(docker info --format '{{.DriverStatus}}' | head -c 80)"

step stack
BAKE=/srv/vatra-bake
bash "$SRC/deploy/vatra/bake.sh" arm64 "$BAKE" "$OUT" | tee -a "$OUT/build.txt"

step ig-setup
id builder >/dev/null 2>&1 || useradd -m -s /bin/bash builder
echo 'builder ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/builder
IG=/home/builder/rpi-image-gen
[ -d "$IG" ] || sudo -u builder git clone -q --depth 1 --branch "$IG_TAG" https://github.com/raspberrypi/rpi-image-gen.git "$IG"
(cd "$IG" && ./install_deps.sh >"$OUT/install-deps.log" 2>&1) || { tail -n 40 "$OUT/install-deps.log"; exit 1; }
PSRC=/home/builder/vatra
rm -rf "$PSRC"; install -d "$PSRC/deploy" "$PSRC/pi"
cp -a "$SRC/deploy/vatra" "$PSRC/deploy/"
cp -a "$SRC/pi/avahi-vmui.service" "$PSRC/pi/"
find "$PSRC/deploy/vatra/pi-image/layer" -path '*/hooks/*' -type f -exec chmod 0755 {} +
chmod 0755 "$PSRC"/deploy/vatra/pi-image/layer/vatra-hub.d/customize.overlay/opt/vatra/bin/*
chown -R builder:builder "$PSRC" "$BAKE"

declare -A IMG
for b in $BOARDS; do
  step "build-$b"
  log="$OUT/build-$b.log"
  if ! sudo -u builder -H bash -c "cd '$IG' && ./rpi-image-gen build -S '$PSRC/deploy/vatra/pi-image' -c vatra-$b.yaml -- IGconf_vatra_bakedir=$BAKE" >"$log" 2>&1; then
    tail -n 80 "$log"; say "rpi-image-gen failed for $b"; exit 1
  fi
  img="$(find "$IG/work" -name "vatra-hub-$b.img" -type f | head -n1)"
  [ -f "$img" ] || { say "no image for $b"; find "$IG/work" -maxdepth 3 -name '*.img*' | tee -a "$OUT/build.txt"; exit 1; }
  IMG[$b]="$img"
  say "$b: $(du -h --apparent-size "$img" | cut -f1) raw ($(du -h "$img" | cut -f1) allocated)"
done

step smoke
# The Pi 4 image: same layer content as Pi 5, but its rootfs is built for 4K pages (the Pi 5
# 2712 kernel runs 16K pages and its ext4 may use 16K blocks, which the generic 4K-page arm64
# kernel used in QEMU cannot mount). The Pi 5 boot chain itself is real-hardware QA.
SMOKE_IMG="${IMG[pi4]:-${IMG[pi5]:-}}"
if [ "${SKIP_SMOKE:-0}" != 1 ] && [ -n "$SMOKE_IMG" ]; then
  bash "$SRC/deploy/vatra/pi-image/smoke.sh" "$SMOKE_IMG" "$OUT" || { say "SMOKE FAILED"; exit 1; }
fi

step package
DIST=/srv/vatra-dist; rm -rf "$DIST"; mkdir -p "$DIST"
specs=()
for b in $BOARDS; do
  name="vatra-hub-$b-$VERSION.img"
  raw_sha="$(sha256sum "${IMG[$b]}" | cut -d' ' -f1)"
  xz -T0 -6 -c "${IMG[$b]}" > "$DIST/$name.xz"
  specs+=("$b=$DIST/$name.xz:${IMG[$b]}:$raw_sha")
  echo "$raw_sha  $name" >> "$OUT/SHA256SUMS"
  (cd "$DIST" && sha256sum "$name.xz") >> "$OUT/SHA256SUMS"
done
python3 "$SRC/deploy/vatra/pi-image/os_list.py" --version "$VERSION" --date "$DATE" \
  --base-url "https://github.com/dragos-catalin/vmui/releases/download/v$VERSION/" --out "$OUT/os_list.json" "${specs[@]}"
cp "$SRC/public/icons/icon-192.png" "$DIST/vatra-icon-192.png"
cp "$OUT/os_list.json" "$OUT/SHA256SUMS" "$DIST/"
ls -la "$DIST" | tee -a "$OUT/build.txt"
if [ -n "${RUN:-}" ] && declare -F gsput >/dev/null; then
  for f in "$DIST"/*; do gsput "$f" "pi-image/$(basename "$f")"; done
  say "uploaded to $RUN/pi-image/"
fi
say "PI IMAGE OK"
