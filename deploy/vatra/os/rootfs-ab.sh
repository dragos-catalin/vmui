#!/usr/bin/env bash
# Make a provisioned Vatra rootfs A/B-ready (P5-04). Runs as root INSIDE the target system: the
# Packer build VM on x86 (provision.sh, VATRA_AB=1) or a chroot of the Pi rootfs (pi-image/ab.sh).
#   bash rootfs-ab.sh --platform x86|pi4|pi5 --version <semver> --src <dir holding deploy/vatra>
# Installs the pinned Rugix Ctrl as /usr/bin/rugix-ctrl (it runs as init: overlay root over the
# read-only EROFS slot, persisted state from the data partition), its config, /etc/vatra-os-release,
# the health unit, and an initramfs that can mount EROFS. The system slot image itself is made by
# bundle.sh / the image scripts from this rootfs.
set -euo pipefail
PLATFORM="" VERSION="" SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    --src) SRC="${2%/}"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done
case "$PLATFORM" in x86) ARCH=amd64; FLAVOR=x86 ;; pi4|pi5) ARCH=arm64; FLAVOR=pi ;; *) echo "--platform x86|pi4|pi5"; exit 1 ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "--version semver"; exit 1; }
OS="$SRC/deploy/vatra/os"
[ -f "$OS/rugix-pin.sh" ] || { echo "--src must hold deploy/vatra/os"; exit 1; }
# shellcheck source=rugix-pin.sh
. "$OS/rugix-pin.sh"
export DEBIAN_FRONTEND=noninteractive

apt_lists() { [ -n "$(find /var/lib/apt/lists -maxdepth 1 -name '*_Packages*' 2>/dev/null | head -n1)" ] || apt-get update -qq; }
dpkg -s initramfs-tools >/dev/null 2>&1 || { apt_lists; apt-get install -y -qq --no-install-recommends initramfs-tools >/dev/null; }

# the root is mounted by the initramfs: EROFS is a module on Debian and on the Pi kernels. Built
# before systemd-boot bits arrive, so no kernel-install hook looks for an ESP in the build VM.
grep -qx erofs /etc/initramfs-tools/modules 2>/dev/null || echo erofs >> /etc/initramfs-tools/modules
grep -qx overlay /etc/initramfs-tools/modules || echo overlay >> /etc/initramfs-tools/modules
update-initramfs -u -k all >/dev/null 2>&1 || update-initramfs -c -k all >/dev/null

if [ "$FLAVOR" = x86 ]; then
  # only the EFI binary (copied to the image's ESP by ab-image.sh) and bootctl (the systemd-boot
  # boot flow sets LoaderEntryOneShot / LoaderEntryDefault with it); never the `systemd-boot`
  # package, whose hooks try to install into an ESP the BIOS build VM does not have
  apt_lists
  apt-get install -y -qq --no-install-recommends systemd-boot-efi >/dev/null
  command -v bootctl >/dev/null || apt-get install -y -qq --no-install-recommends systemd-boot-tools >/dev/null 2>&1 || true
  command -v bootctl >/dev/null || { echo "bootctl missing: the systemd-boot boot flow needs it"; exit 1; }
  [ -f /usr/lib/systemd/boot/efi/systemd-bootx64.efi ] || { echo "systemd-bootx64.efi missing"; exit 1; }
fi

rugix_fetch "$ARCH" /tmp/rugix
install -m 0755 /tmp/rugix/rugix-ctrl /usr/bin/rugix-ctrl
rm -rf /tmp/rugix

install -d -m 0755 /etc/rugix/state
install -m 0644 "$OS/$FLAVOR/system.toml" /etc/rugix/system.toml
install -m 0644 "$OS/$FLAVOR/bootstrapping.toml" /etc/rugix/bootstrapping.toml
install -m 0644 "$OS/state/state.toml" /etc/rugix/state.toml
install -m 0644 "$OS/state/vatra.toml" /etc/rugix/state/vatra.toml
printf 'AB=1\nPLATFORM=%s\nVERSION=%s\nRUGIX=%s\n' "$PLATFORM" "$VERSION" "$RUGIX_VERSION" > /etc/vatra-os-release

install -d /opt/vatra/bin /etc/systemd/system /etc/systemd/system/multi-user.target.wants /etc/systemd/system/local-fs.target.wants
install -m 0755 "$OS/vatra-os-health" /opt/vatra/bin/vatra-os-health
install -m 0644 "$OS/vatra-os-health.service" /etc/systemd/system/vatra-os-health.service
ln -sf /etc/systemd/system/vatra-os-health.service /etc/systemd/system/multi-user.target.wants/vatra-os-health.service
if [ "$FLAVOR" = x86 ]; then
  install -m 0755 "$OS/vatra-esp-slot" /opt/vatra/bin/vatra-esp-slot
  install -d /efi
  install -m 0644 "$OS/x86/efi.mount" /etc/systemd/system/efi.mount
  ln -sf /etc/systemd/system/efi.mount /etc/systemd/system/local-fs.target.wants/efi.mount
else
  install -m 0644 "$OS/pi/vatra-boot-firmware.service" /etc/systemd/system/vatra-boot-firmware.service
  ln -sf /etc/systemd/system/vatra-boot-firmware.service /etc/systemd/system/local-fs.target.wants/vatra-boot-firmware.service
  # the classic image mounted the boot partition by fstab / boot-firmware.mount; the A/B one binds
  systemctl mask boot-firmware.mount >/dev/null 2>&1 || true
fi
if [ -d /etc/ssh ]; then
  install -d /etc/ssh/sshd_config.d
  install -m 0644 "$OS/sshd-vatra-hostkeys.conf" /etc/ssh/sshd_config.d/50-vatra-hostkeys.conf
fi
# identity files are persisted as bind-mounted files: they must exist in the image
for f in /etc/hostname /etc/hosts; do [ -e "$f" ] || : > "$f"; done
install -d -m 0755 /etc/NetworkManager/system-connections /var/lib/vatra /var/log/journal /var/lib/containerd

if [ "$FLAVOR" = x86 ]; then
  # no root line: / is Rugix's overlay; the ESP is Rugix's config partition (/run/rugix/mounts/config)
  cat > /etc/fstab <<'EOF'
# Vatra A/B (P5-04): / = overlay over the EROFS system slot, set up by rugix-ctrl (init); the ESP
# is mounted read-only at /run/rugix/mounts/config and the data partition at /run/rugix/mounts/data.
EOF
  # grub stays installed but unused; systemd-boot from the ESP boots the slots
  systemctl disable grub-common.service >/dev/null 2>&1 || true
else
  cat > /etc/fstab <<'EOF'
# Vatra A/B (P5-04): / = overlay over the EROFS system slot; rugix-ctrl mounts the config
# partition at /boot/firmware and the data partition at /run/rugix/mounts/data.
EOF
fi
echo "rootfs A/B-ready: $PLATFORM $VERSION, rugix-ctrl $RUGIX_VERSION ($(/usr/bin/rugix-ctrl --version 2>/dev/null | head -n1 || echo '?'))"
