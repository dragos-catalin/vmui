#!/usr/bin/env bash
# Assemble the Vatra x86 A/B disk (P5-04) from the qcow2 Packer built with -var ab=1 (rootfs-ab.sh
# already ran inside it). Runs as root on the build host.
#   bash ab-image.sh <packer.qcow2> <version> <out dir>
# GPT layout (16 GiB virtual, sparse):
#   1 vatra-esp       512 MiB vfat  systemd-boot, loader entries vatra-a/b.conf, /vatra/{a,b}/kernel+initrd
#                                   (= Rugix's config partition, read-only at /run/rugix/mounts/config)
#   2 vatra-system-a    4 GiB EROFS the rootfs (read-only, booted with init=/usr/bin/rugix-ctrl)
#   3 vatra-system-b    4 GiB empty until the first OS update
#   4 vatra-data       rest   ext4  persisted state (Rugix copies /srv/vatra etc. from the slot at first boot)
# Out: <out>/vatra-hub-x86-ab-<version>.qcow2, <out>/vatra-os-x86-<version>.rugixb + os-index.json,
#      <out>/rootfs/ (kept for building follow-up bundles), <out>/partuuids.env
set -euo pipefail
QCOW="$1"; VERSION="$2"; OUT="$3"
X="$(cd "$(dirname "$0")" && pwd)"
OS="$X/../os"
mkdir -p "$OUT"
for t in qemu-img sgdisk mkfs.erofs mkfs.vfat mcopy losetup; do command -v "$t" >/dev/null || { echo "needs $t"; exit 1; }; done

# --- 1. the provisioned rootfs out of the Packer qcow2 (raw copy + loop: no nbd module needed) ---
SRCRAW="$OUT/packer.raw"
qemu-img convert -O raw "$QCOW" "$SRCRAW"
SL="$(losetup --show -frP "$SRCRAW")"
trap 'umount /mnt/vatra-src 2>/dev/null || true; losetup -d "$SL" 2>/dev/null || true' EXIT
udevadm settle
ROOTP=""
for p in "$SL"p*; do
  [ "$(blkid -o value -s TYPE "$p" 2>/dev/null)" = ext4 ] && { ROOTP="$p"; break; }
done
[ -n "$ROOTP" ] || { echo "no ext4 root in $QCOW"; lsblk "$SL"; exit 1; }
mkdir -p /mnt/vatra-src
mount -o ro "$ROOTP" /mnt/vatra-src
grep -q '^AB=1' /mnt/vatra-src/etc/vatra-os-release || { echo "$QCOW was not built with -var ab=1"; exit 1; }
R="$OUT/rootfs"
rm -rf "$R"; mkdir -p "$R"
tar --xattrs --xattrs-include='*' --acls --numeric-owner -C /mnt/vatra-src -cf - . | tar --xattrs --xattrs-include='*' --acls --numeric-owner -C "$R" -xf -
umount /mnt/vatra-src
losetup -d "$SL"
rm -f "$SRCRAW"
trap - EXIT
# cloud-image leftovers that would fight the A/B boot
rm -rf "$R/boot/grub" "$R/boot/efi"/* 2>/dev/null || true
install -d "$R/boot/efi"

# --- 2. slot payloads + the release bundle for this version ------------------------------------
bash "$OS/bundle.sh" --platform x86 --rootfs "$R" --version "$VERSION" --out "$OUT"
P="$OUT/payloads-x86-$VERSION/payloads"
SYS_BYTES=$(stat -c %s "$P/system.erofs")
[ "$SYS_BYTES" -lt $((4 * 1024 * 1024 * 1024)) ] || { echo "system.erofs ($SYS_BYTES bytes) does not fit a 4 GiB slot"; exit 1; }

# --- 3. the disk ------------------------------------------------------------------------------
RAW="$OUT/disk.raw"
rm -f "$RAW"; truncate -s 16G "$RAW"
UA="$(cat /proc/sys/kernel/random/uuid)"; UB="$(cat /proc/sys/kernel/random/uuid)"
sgdisk -o \
  -n 1:1MiB:+512MiB -t 1:ef00 -c 1:vatra-esp \
  -n 2:0:+4GiB -t 2:8304 -c 2:vatra-system-a -u 2:"$UA" \
  -n 3:0:+4GiB -t 3:8304 -c 3:vatra-system-b -u 3:"$UB" \
  -n 4:0:0 -t 4:8300 -c 4:vatra-data "$RAW" >/dev/null
printf 'PARTUUID_A=%s\nPARTUUID_B=%s\n' "$UA" "$UB" > "$OUT/partuuids.env"
LOOP="$(losetup --show -fP "$RAW")"
trap 'losetup -d "$LOOP" 2>/dev/null || true' EXIT
udevadm settle

dd if="$P/system.erofs" of="${LOOP}p2" bs=4M conv=fsync status=none
mkfs.ext4 -q -L vatra-data -E lazy_itable_init=0 "${LOOP}p4"
mkfs.vfat -F 32 -n VATRA-ESP "${LOOP}p1" >/dev/null

E="$OUT/esp"
rm -rf "$E"; mkdir -p "$E/EFI/BOOT" "$E/EFI/systemd" "$E/loader/entries" "$E/vatra/a" "$E/vatra/b"
cp "$R/usr/lib/systemd/boot/efi/systemd-bootx64.efi" "$E/EFI/BOOT/BOOTX64.EFI"
cp "$R/usr/lib/systemd/boot/efi/systemd-bootx64.efi" "$E/EFI/systemd/systemd-bootx64.efi"
cp "$P/vmlinuz" "$E/vatra/a/vmlinuz"
cp "$P/initrd.img" "$E/vatra/a/initrd.img"
echo "Slot B kernel + initrd are written here by the first OS update (Rugix file slots)." > "$E/vatra/b/README.txt"
printf 'default vatra-a.conf\ntimeout 2\nconsole-mode keep\neditor no\n' > "$E/loader/loader.conf"
entry() { # $1 slot letter, $2 partuuid
  cat > "$E/loader/entries/vatra-$1.conf" <<EOF
title   Vatra hub (slot ${1^^})
linux   /vatra/$1/vmlinuz
initrd  /vatra/$1/initrd.img
options root=PARTUUID=$2 rootfstype=erofs ro fsck.mode=skip systemd.gpt_auto=0 init=/usr/bin/rugix-ctrl console=tty0 console=ttyS0,115200 rootwait
EOF
}
entry a "$UA"; entry b "$UB"
(cd "$E" && mcopy -s -i "${LOOP}p1" ./* ::/)
sync
losetup -d "$LOOP"
trap - EXIT

IMG="$OUT/vatra-hub-x86-ab-$VERSION.qcow2"
qemu-img convert -c -O qcow2 "$RAW" "$IMG"
rm -f "$RAW"
echo "A/B disk $(basename "$IMG"): $(du -h "$IMG" | cut -f1) (system.erofs $((SYS_BYTES / 1048576)) MiB, slot A=$UA B=$UB)"
