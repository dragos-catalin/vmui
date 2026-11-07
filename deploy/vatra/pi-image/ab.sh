#!/usr/bin/env bash
# Turn a classic Vatra Pi card image (rpi-image-gen output: 1 boot FAT, 2 root ext4) into the A/B
# card (P5-04). Runs as root on the native arm64 build host after build.sh produced the image.
#   bash ab.sh <vatra-hub-piN.img> <pi4|pi5> <version> <out dir>
# MBR layout of the result (rpi-tryboot boot flow, Rugix Ctrl):
#   1 config   64 MiB FAT32  autoboot.txt (tryboot_a_b, boot_partition=2 / [tryboot] 3), the setup
#                            note and vatra-wifi.txt (bound to /boot/firmware at runtime)
#   2 boot-a  256 MiB FAT32  firmware, kernel, DTBs, config.txt, cmdline.txt (root=PARTUUID of 5)
#   3 boot-b  256 MiB FAT32  empty until the first OS update
#   4 extended
#   5 system-a  4 GiB EROFS
#   6 system-b  4 GiB EROFS (empty)
#   7 data    512 MiB ext4   grown to the card by vatra-firstboot
# Out: <out>/vatra-hub-<board>-ab-<version>.img, <out>/vatra-os-<board>-<version>.rugixb, os-index.json
set -euo pipefail
IMG="$1"; BOARD="$2"; VERSION="$3"; OUT="$4"
PI="$(cd "$(dirname "$0")" && pwd)"
OS="$PI/../os"
SRC="$(cd "$PI/../../.." && pwd)"
case "$BOARD" in pi4|pi5) ;; *) echo "board pi4|pi5"; exit 1 ;; esac
[ "$(dpkg --print-architecture)" = arm64 ] || { echo "needs a native arm64 host (chroot into the rootfs)"; exit 1; }
for t in sfdisk mkfs.erofs mkfs.vfat mcopy losetup; do command -v "$t" >/dev/null || { echo "needs $t"; exit 1; }; done
mkdir -p "$OUT"

# --- 1. rootfs + firmware out of the classic image ---------------------------------------------
SL="$(losetup --show -frP "$IMG")"
M=/mnt/vatra-pi-src
cleanup() { umount -R "$M" 2>/dev/null || true; losetup -d "$SL" 2>/dev/null || true; }
trap cleanup EXIT
udevadm settle
mkdir -p "$M"
mount -o ro "${SL}p2" "$M"
mkdir -p /tmp/vatra-pi-fw && mount -o ro "${SL}p1" /tmp/vatra-pi-fw
R="$OUT/rootfs-$BOARD"
rm -rf "$R"; mkdir -p "$R"
tar --xattrs --xattrs-include='*' --acls --numeric-owner -C "$M" -cf - . | tar --xattrs --xattrs-include='*' --acls --numeric-owner -C "$R" -xf -
mkdir -p "$R/boot/firmware"
cp -a /tmp/vatra-pi-fw/. "$R/boot/firmware/"
umount /tmp/vatra-pi-fw; umount "$M"; losetup -d "$SL"; trap - EXIT

# --- 2. A/B-ready rootfs (chroot: same arch) ---------------------------------------------------
mkdir -p "$R/tmp/vatra-src/deploy"
cp -a "$SRC/deploy/vatra" "$R/tmp/vatra-src/deploy/"
cp /etc/resolv.conf "$R/etc/resolv.conf.ab" 2>/dev/null || true
mount --bind /proc "$R/proc"; mount --bind /sys "$R/sys"; mount --bind /dev "$R/dev"
trap 'umount "$R/proc" "$R/sys" "$R/dev" 2>/dev/null || true' EXIT
[ -s "$R/etc/resolv.conf" ] || cp /etc/resolv.conf "$R/etc/resolv.conf"
chroot "$R" bash /tmp/vatra-src/deploy/vatra/os/rootfs-ab.sh --platform "$BOARD" --version "$VERSION" --src /tmp/vatra-src
umount "$R/proc" "$R/sys" "$R/dev"; trap - EXIT
rm -rf "$R/tmp/vatra-src" "$R/etc/resolv.conf.ab"
# Rugix's rpi-tryboot flow rewrites cmdline.txt of the slot it installs into; the factory slot A
# gets the same treatment here (root = PARTUUID of partition 5, init = rugix-ctrl)
DISKID="0x$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
PU_A="${DISKID#0x}-05"
fw="$R/boot/firmware"
sed -i -E "s#root=[^ ]+#root=PARTUUID=$PU_A#; s# init=[^ ]+##; s#rootfstype=[^ ]+#rootfstype=erofs#; s#\$# init=/usr/bin/rugix-ctrl#" "$fw/cmdline.txt"
grep -q rootfstype=erofs "$fw/cmdline.txt" || sed -i 's#$# rootfstype=erofs#' "$fw/cmdline.txt"
grep -q '^auto_initramfs=1' "$fw/config.txt" || echo 'auto_initramfs=1' >> "$fw/config.txt"

# --- 3. bundle (also gives the slot payloads) ----------------------------------------------------
bash "$OS/bundle.sh" --platform "$BOARD" --rootfs "$R" --version "$VERSION" --out "$OUT"
P="$OUT/payloads-$BOARD-$VERSION/payloads"

# --- 4. the card -----------------------------------------------------------------------------
CARD="$OUT/vatra-hub-$BOARD-ab-$VERSION.img"
rm -f "$CARD"; truncate -s 9700M "$CARD"
sfdisk -q "$CARD" <<EOF
label: dos
label-id: $DISKID
start=8192, size=64MiB, type=c
size=256MiB, type=c
size=256MiB, type=c
type=5
size=4GiB, type=83
size=4GiB, type=83
size=512MiB, type=83
EOF
CL="$(losetup --show -fP "$CARD")"
trap 'losetup -d "$CL" 2>/dev/null || true' EXIT
udevadm settle
mkfs.vfat -F 32 -n CONFIG "${CL}p1" >/dev/null
dd if="$P/boot.vfat" of="${CL}p2" bs=4M conv=fsync status=none
mkfs.vfat -F 32 -n BOOT-B "${CL}p3" >/dev/null
dd if="$P/system.erofs" of="${CL}p5" bs=4M conv=fsync status=none
mkfs.ext4 -q -L data "${CL}p7"
mcopy -i "${CL}p1" "$OS/pi/autoboot.txt" ::/autoboot.txt
sync; losetup -d "$CL"; trap - EXIT
echo "A/B card $(basename "$CARD"): $(du -h --apparent-size "$CARD" | cut -f1) raw, $(du -h "$CARD" | cut -f1) allocated; bundle $(du -h "$OUT/vatra-os-$BOARD-$VERSION.rugixb" | cut -f1)"
