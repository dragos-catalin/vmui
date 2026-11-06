#!/usr/bin/env bash
# Boot a COPY of a built Vatra Pi image in QEMU (machine virt, same rootfs, Debian's generic arm64
# kernel from the build host, its modules copied into the copy) and check it from inside and out.
#   bash deploy/vatra/pi-image/smoke.sh <vatra-hub-pi5.img> <out dir>
# Boot 1: virtio NIC on a restricted user network (DHCP, no internet) -> offline first boot,
#         baked stack, unclaimed hub, setup code on the boot partition; the host reads
#         /api/discover through a port forward.
# Boot 2: no NIC, two mac80211_hwsim radios -> hotspot + WPA2 + captive portal + DNS, reached by a
#         client radio moved into a network namespace. Also proves a second boot is clean.
# The Pi boot chain (firmware, config.txt, rpi kernel) is not emulated; that is real-hardware QA.
set -euo pipefail
IMG="$1"; OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
W=/srv/vatra-smoke
rm -rf "$W"; mkdir -p "$W/mnt"
say() { echo "== $*" | tee -a "$OUT/smoke.txt"; }

KVER="$(ls /lib/modules | grep -E -- '-arm64$' | grep -v cloud | sort -V | tail -n1)"
[ -n "$KVER" ] && [ -f "/boot/vmlinuz-$KVER" ] && [ -f "/boot/initrd.img-$KVER" ] || { say "no generic arm64 kernel on the host"; exit 1; }
say "kernel $KVER; image $(basename "$IMG")"
# The build VM's initrd carries GCE hooks (gce-disk-expand grows partitions before root mounts,
# which would hide vatra-firstboot's growpart): build a clean one on this throwaway host.
# (it also rewrites the MBR disk signature, so PARTUUID fstab entries stop matching)
apt-get purge -y -qq gce-disk-expand >/dev/null 2>&1 || true
rm -f /usr/share/initramfs-tools/scripts/*/*gce* /usr/share/initramfs-tools/hooks/*gce* /etc/initramfs-tools/scripts/*/*gce* 2>/dev/null || true
printf 'virtio_blk\nvirtio_pci\next4\n' >> /etc/initramfs-tools/modules
mkinitramfs -o "$W/initrd.img" "$KVER"
if lsinitramfs "$W/initrd.img" | grep -qiE 'gce|disk-expand|growroot'; then say "smoke initrd still resizes disks"; exit 1; fi

cp --sparse=always "$IMG" "$W/hub.img"
truncate -s 12G "$W/hub.img"
SIG0="$(sfdisk --disk-id "$W/hub.img")"
# the image's MBR still ends at the old size; growpart in firstboot extends partition 2

mount_copy() {
  LOOP="$(losetup -fP --show "$W/hub.img")"
  for _ in 1 2 3 4 5; do [ -b "${LOOP}p2" ] && break; sleep 1; done
  mount "${LOOP}p2" "$W/mnt"
  mount "${LOOP}p1" "$W/mnt/boot/firmware"
}
umount_copy() { sync; umount "$W/mnt/boot/firmware" "$W/mnt"; losetup -d "$LOOP"; }

mount_copy
R="$W/mnt"
cp -a "/lib/modules/$KVER" "$R/lib/modules/"
install -m 0755 "$HERE/smoke/vatra-smoke-guest.sh" "$R/usr/local/sbin/vatra-smoke-guest"
install -m 0644 "$HERE/smoke/vatra-smoke.service" "$R/etc/systemd/system/vatra-smoke.service"
ln -sf /etc/systemd/system/vatra-smoke.service "$R/etc/systemd/system/multi-user.target.wants/vatra-smoke.service"
# no Pi hardware here: services bound to it would only add noise
for u in rpi-eeprom-update.service; do ln -sf /dev/null "$R/etc/systemd/system/$u"; done
grep -E '^(VATRA_VERSION|VATRA_IMAGE|MOSQUITTO_IMAGE)=' "$R/srv/vatra/.env" | tee -a "$OUT/smoke.txt"
say "fstab: $(grep -v '^#' "$R/etc/fstab" | tr '\n' ';')"
umount_copy

ACCEL=(-accel tcg,thread=multi -cpu max)
[ -e /dev/kvm ] && ACCEL=(-accel kvm -cpu host)
boot() {
  local phase=$1; shift
  say "boot $phase ($(date -u +%T), ${ACCEL[1]})"
  # emergency/rescue masked: a failed mount must show up as a smoke failure, not a locked-root
  # sulogin prompt that hangs QEMU until the timeout
  timeout 45m qemu-system-aarch64 -machine virt "${ACCEL[@]}" -smp 4 -m 4096 -nographic -no-reboot \
    -kernel "/boot/vmlinuz-$KVER" -initrd "$W/initrd.img" \
    -append "root=/dev/vda2 rootwait rw console=ttyAMA0 vatra.smoke=$phase systemd.show_status=0 systemd.mask=emergency.service systemd.mask=rescue.service" \
    -drive "file=$W/hub.img,format=raw,if=virtio,cache=unsafe" "$@" \
    > "$OUT/console-$phase.log" 2>&1 || say "qemu exit $? (boot $phase)"
  grep '^SMOKE' "$OUT/console-$phase.log" | tee -a "$OUT/smoke.txt" || true
}

# boot 1, with the host probing the hub through the port forward
( for _ in $(seq 1 1200); do
    if b="$(curl -fsS --max-time 3 http://127.0.0.1:13737/api/discover 2>/dev/null)"; then echo "$b" > "$W/host-discover.json"; break; fi
    sleep 5
  done ) &
PROBE=$!
boot 1 -netdev user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:13737-:3737 -device virtio-net-pci,netdev=n0,romfile=
kill "$PROBE" 2>/dev/null || true

mount_copy
echo mac80211_hwsim > "$W/mnt/etc/modules-load.d/vatra-smoke-hwsim.conf"
echo 'options mac80211_hwsim radios=2' > "$W/mnt/etc/modprobe.d/vatra-smoke-hwsim.conf"
umount_copy
boot 2 -nic none

mount_copy
SIG1="$(sfdisk --disk-id "$W/hub.img")"
[ "$SIG0" = "$SIG1" ] && say "disk signature kept ($SIG1)" || { say "disk signature changed $SIG0 -> $SIG1"; ok_sig=0; }
cp "$W/mnt/boot/firmware/vatra-setup.txt" "$OUT/vatra-setup.txt" 2>/dev/null || true
for p in 1 2; do cp "$W/mnt/var/lib/vatra-smoke/smoke-$p.txt" "$OUT/" 2>/dev/null || true; done
journal="$(ls -d "$W"/mnt/var/log/journal/* 2>/dev/null | head -n1)"
if [ -n "$journal" ]; then
  journalctl -D "$journal" --no-pager -u vatra-stack -u vatra-netsetup -u vatra-firstboot -u boot-firmware.mount \
    -u systemd-remount-fs -u systemd-fsck@* > "$OUT/units.log" 2>&1 || true
  journalctl -D "$journal" --no-pager -p warning > "$OUT/warnings.log" 2>&1 || true
fi
umount_copy
# the setup code is a per-hub secret of this throwaway copy only; keep the artefact masked anyway
[ -f "$OUT/vatra-setup.txt" ] && sed -i -E 's/(code: |configurare: )[0-9]{3} [0-9]{3}/\1*** ***/' "$OUT/vatra-setup.txt"

ok=1
[ "${ok_sig:-1}" = 1 ] || ok=0
for p in 1 2; do grep -q "SMOKE phase $p pass" "$OUT/smoke-$p.txt" 2>/dev/null || { say "boot $p did not pass"; ok=0; }; done
if [ -f "$W/host-discover.json" ] && grep -q '"claimed":false' "$W/host-discover.json"; then
  say "host -> hub /api/discover: $(cat "$W/host-discover.json")"
else
  say "host never reached /api/discover"; ok=0
fi
[ "$ok" = 1 ] && say "SMOKE OK" || { say "SMOKE FAILED"; exit 1; }
