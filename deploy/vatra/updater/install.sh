#!/usr/bin/env bash
# Install vatra-updater on a hub host (Pi image firstboot / x86 image / by hand), as root.
#   sudo bash deploy/vatra/updater/install.sh [--no-timer]
# Puts a checksum-pinned cosign in /usr/local/bin, the updater in /opt/vatra/updater, the config
# in /srv/vatra/updater.json (kept if present) and enables the nightly timer.
set -euo pipefail
COSIGN_VERSION=v3.1.4
declare -A COSIGN_SHA=(
  [amd64]=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
  [arm64]=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2
)
here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
[ -n "${COSIGN_SHA[$arch]:-}" ] || { echo "unsupported arch $arch"; exit 1; }
if ! /usr/local/bin/cosign version 2>/dev/null | grep -q "${COSIGN_VERSION#v}"; then
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-${arch}"
  echo "${COSIGN_SHA[$arch]}  $tmp" | sha256sum -c - >/dev/null
  install -m 0755 "$tmp" /usr/local/bin/cosign
  rm -f "$tmp"
fi

install -d -m 0755 /opt/vatra/updater
install -m 0755 "$here/vatra_updater.py" /opt/vatra/updater/vatra_updater.py
install -d -m 0755 /srv/vatra
[ -f /srv/vatra/updater.json ] || install -m 0644 "$here/updater.example.json" /srv/vatra/updater.json
ln -sf /opt/vatra/updater/vatra_updater.py /usr/local/bin/vatra-updater
install -m 0644 "$here/vatra-updater.service" "$here/vatra-updater.timer" /etc/systemd/system/
systemctl daemon-reload
[ "${1:-}" = "--no-timer" ] || systemctl enable --now vatra-updater.timer
echo "vatra-updater installed (cosign $(/usr/local/bin/cosign version 2>/dev/null | awk '/GitVersion/{print $2}'))"
