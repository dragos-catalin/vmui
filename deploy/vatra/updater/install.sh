#!/usr/bin/env bash
# Install vatra-updater on a hub host (by hand / x86 image), as root, or into an image rootfs at
# build time (Pi image hook: --root <rootfs> --arch arm64, nothing runs inside the rootfs).
#   sudo bash deploy/vatra/updater/install.sh [--no-timer] [--root DIR] [--arch amd64|arm64]
# Puts a checksum-pinned cosign in /usr/local/bin, the updater in /opt/vatra/updater, the config
# in /srv/vatra/updater.json (kept if present) and enables the nightly timer.
set -euo pipefail
COSIGN_VERSION=v3.1.4
declare -A COSIGN_SHA=(
  [amd64]=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
  [arm64]=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2
)
here="$(cd "$(dirname "$0")" && pwd)"
R="" timer=1 arch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-timer) timer=0 ;;
    --root) R="${2%/}"; shift ;;
    --arch) arch="$2"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

[ -n "$arch" ] || arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
[ -n "${COSIGN_SHA[$arch]:-}" ] || { echo "unsupported arch $arch"; exit 1; }
have_cosign() { [ -z "$R" ] && /usr/local/bin/cosign version 2>/dev/null | grep -q "${COSIGN_VERSION#v}"; }
if ! have_cosign; then
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${arch}"
  echo "${COSIGN_SHA[$arch]}  $tmp" | sha256sum -c - >/dev/null
  install -D -m 0755 "$tmp" "$R/usr/local/bin/cosign"
  rm -f "$tmp"
fi

install -d -m 0755 "$R/opt/vatra/updater" "$R/usr/local/bin" "$R/etc/systemd/system"
install -m 0755 "$here/vatra_updater.py" "$R/opt/vatra/updater/vatra_updater.py"
install -d -m 0755 "$R/srv/vatra"
[ -f "$R/srv/vatra/updater.json" ] || install -m 0644 "$here/updater.example.json" "$R/srv/vatra/updater.json"
ln -sf /opt/vatra/updater/vatra_updater.py "$R/usr/local/bin/vatra-updater"
install -m 0644 "$here/vatra-updater.service" "$here/vatra-updater.timer" "$R/etc/systemd/system/"
if [ -n "$R" ]; then
  [ "$timer" = 1 ] && systemctl --root="$R" enable vatra-updater.timer
  echo "vatra-updater installed into $R (cosign ${COSIGN_VERSION}, $arch)"
  exit 0
fi
systemctl daemon-reload
[ "$timer" = 1 ] && systemctl enable --now vatra-updater.timer
echo "vatra-updater installed (cosign $(/usr/local/bin/cosign version 2>/dev/null | awk '/GitVersion/{print $2}'))"
