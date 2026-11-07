#!/usr/bin/env bash
# Turn an A/B-ready Vatra rootfs (rootfs-ab.sh already ran in it) into the slot payloads and a Rugix
# update bundle (P5-04). Runs as root on the build host (Debian 13, erofs-utils, dosfstools, mtools).
#   bash bundle.sh --platform x86|pi4|pi5 --rootfs <dir> --version <semver> --out <dir>
# Out: <out>/vatra-os-<platform>-<version>.rugixb, <out>/payloads-<platform>-<version>/ (the slot
# images, reused by the image scripts) and <out>/os-index.json (version + file + bundleHash per
# platform, read by scripts/channel-manifest.mjs, which adds sha256 + size to the signed manifest).
# The rootfs's /etc/vatra-os-release VERSION is set to <version> before the EROFS image is made.
set -euo pipefail
PLATFORM="" ROOTFS="" VERSION="" OUTDIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift ;;
    --rootfs) ROOTFS="${2%/}"; shift ;;
    --version) VERSION="$2"; shift ;;
    --out) OUTDIR="${2%/}"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=rugix-pin.sh
. "$HERE/rugix-pin.sh"
case "$PLATFORM" in x86|pi4|pi5) ;; *) echo "--platform x86|pi4|pi5"; exit 1 ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "--version semver"; exit 1; }
[ -f "$ROOTFS/etc/vatra-os-release" ] || { echo "$ROOTFS is not A/B-ready (run rootfs-ab.sh in it)"; exit 1; }
for t in mkfs.erofs mkfs.vfat mcopy; do command -v "$t" >/dev/null || { echo "needs $t (erofs-utils dosfstools mtools)"; exit 1; }; done
HOSTARCH="$(dpkg --print-architecture)"
BUNDLER=/usr/local/bin/rugix-bundler
[ -x "$BUNDLER" ] || { rugix_fetch "$HOSTARCH" /tmp/rugix-host; install -m 0755 /tmp/rugix-host/rugix-bundler "$BUNDLER"; }

sed -i "s/^VERSION=.*/VERSION=$VERSION/" "$ROOTFS/etc/vatra-os-release"
mkdir -p "$OUTDIR"
B="$OUTDIR/payloads-$PLATFORM-$VERSION"
rm -rf "$B"; mkdir -p "$B/payloads"
P="$B/payloads"

# system slot: the whole rootfs as EROFS (lz4hc), read-only by construction; ownership, modes,
# xattrs (file capabilities) are kept. Mount points stay as empty dirs.
mkfs.erofs -zlz4hc -T 0 "$P/system.erofs" "$ROOTFS" >"$B/mkfs-erofs.log" 2>&1 || { tail -n 20 "$B/mkfs-erofs.log"; exit 1; }

block='[payloads.block-encoding]
hash-algorithm = "sha512-256"
chunker = "casync-64"'
xz='[payloads.block-encoding]
hash-algorithm = "sha512-256"
chunker = "casync-64"
compression = { type = "xz", level = 6 }'

if [ "$PLATFORM" = x86 ]; then
  # kernel + initrd of the slot, written by Rugix into the ESP file slots of the spare group
  kver="$(cd "$ROOTFS/boot" && ls vmlinuz-* | sed 's/^vmlinuz-//' | sort -V | tail -n1)"
  [ -f "$ROOTFS/boot/initrd.img-$kver" ] || { echo "no initrd for kernel $kver"; exit 1; }
  cp "$ROOTFS/boot/vmlinuz-$kver" "$P/vmlinuz"
  cp "$ROOTFS/boot/initrd.img-$kver" "$P/initrd.img"
  cat > "$B/rugix-bundle.toml" <<EOF
#:schema https://raw.githubusercontent.com/rugix/rugix/refs/tags/${RUGIX_VERSION}/schemas/rugix-bundle-manifest.schema.json
update-type = "full"
hash-algorithm = "sha512-256"

[[payloads]]
filename = "vmlinuz"
[payloads.delivery]
type = "slot"
slot = "kernel"
$xz

[[payloads]]
filename = "initrd.img"
[payloads.delivery]
type = "slot"
slot = "initrd"
$xz

[[payloads]]
filename = "system.erofs"
[payloads.delivery]
type = "slot"
slot = "system"
$block
EOF
else
  # boot slot: the firmware partition (kernel, DTBs, overlays, config.txt, cmdline.txt, initramfs).
  # Rugix rewrites cmdline.txt's root= / init= for the slot it installs into (rpi-tryboot flow).
  fw="$ROOTFS/boot/firmware"
  [ -f "$fw/config.txt" ] || { echo "no $fw/config.txt in the rootfs"; exit 1; }
  truncate -s 256M "$P/boot.vfat"
  mkfs.vfat -F 32 -n VATRA-BOOT "$P/boot.vfat" >/dev/null
  (cd "$fw" && mcopy -s -i "$P/boot.vfat" ./* ::/)
  cat > "$B/rugix-bundle.toml" <<EOF
#:schema https://raw.githubusercontent.com/rugix/rugix/refs/tags/${RUGIX_VERSION}/schemas/rugix-bundle-manifest.schema.json
update-type = "full"
hash-algorithm = "sha512-256"

[[payloads]]
filename = "boot.vfat"
[payloads.delivery]
type = "slot"
slot = "boot"
$xz

[[payloads]]
filename = "system.erofs"
[payloads.delivery]
type = "slot"
slot = "system"
$block
EOF
fi

NAME="vatra-os-$PLATFORM-$VERSION.rugixb"
"$BUNDLER" bundle "$B" "$OUTDIR/$NAME" >"$B/bundler.log" 2>&1 || { cat "$B/bundler.log"; exit 1; }
HASH="$("$BUNDLER" hash "$OUTDIR/$NAME" | tail -n1 | tr -d '[:space:]')"
[ -n "$HASH" ] || { echo "rugix-bundler hash printed nothing"; exit 1; }
python3 - "$OUTDIR/os-index.json" "$VERSION" "$PLATFORM" "$NAME" "$HASH" <<'PY'
import json, os, sys
path, version, platform, name, bhash = sys.argv[1:]
idx = json.load(open(path)) if os.path.exists(path) else {}
if idx.get("version") != version:
    idx = {"version": version, "platforms": {}}
idx["platforms"][platform] = {"file": name, "bundleHash": bhash}
json.dump(idx, open(path, "w"), indent=2)
PY
echo "bundle $NAME: $(du -h "$OUTDIR/$NAME" | cut -f1), system.erofs $(du -h "$P/system.erofs" | cut -f1), hash $HASH"
