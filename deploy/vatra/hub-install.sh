#!/usr/bin/env bash
# Install the Vatra hub stack into a root filesystem (P5-01 Pi image hook, P5-05 x86 Packer build).
#   bash deploy/vatra/hub-install.sh --root <dir> --arch arm64|amd64 --bake <dir> --platform pi|x86
# <bake> holds vatra.env (the pinned stack) and images/*.tar.zst (loaded at first boot, so the hub
# answers and can be claimed with no internet). Needs docker + avahi + python3 + zstd installed in
# <root> already. Nothing is started; units are enabled offline.
set -euo pipefail
R="" ARCH="" B="" PLATFORM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) R="${2%/}"; shift ;;
    --arch) ARCH="$2"; shift ;;
    --bake) B="$2"; shift ;;
    --platform) PLATFORM="$2"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done
V="$(cd "$(dirname "$0")" && pwd)"            # deploy/vatra
O="$V/pi-image/layer/vatra-hub.d/customize.overlay"
[ -n "$ARCH" ] && [ -f "$B/vatra.env" ] || { echo "usage: --root DIR --arch A --bake DIR --platform pi|x86"; exit 1; }
case "$PLATFORM" in pi|x86) ;; *) echo "--platform pi|x86"; exit 1 ;; esac

bash "$V/updater/install.sh" --root "$R" --arch "$ARCH"

# shared appliance files (on the Pi the layer overlay already put them in place)
if [ "$PLATFORM" = x86 ]; then
  install -d "$R/opt/vatra/bin" "$R/etc/systemd/system" "$R/etc/docker"
  install -m 0755 "$O"/opt/vatra/bin/* "$R/opt/vatra/bin/"
  for u in vatra-firstboot.service vatra-stack.service vatra-bootnote.path; do
    install -m 0644 "$O/etc/systemd/system/$u" "$R/etc/systemd/system/$u"
  done
  install -m 0644 "$V/x86/vatra-bootnote.service" "$R/etc/systemd/system/vatra-bootnote.service"
  install -m 0644 "$O/etc/docker/daemon.json" "$R/etc/docker/daemon.json"
fi

install -d -m 0755 "$R/srv/vatra" "$R/opt/vatra/images" "$R/srv/vatra/ha" "$R/srv/vatra/esphome" \
  "$R/srv/vatra/mosquitto/config" "$R/srv/vatra/mosquitto/data"
install -d -m 0750 "$R/srv/vatra/data"
install -m 0644 "$V/compose.yaml" "$R/srv/vatra/compose.yaml"
install -m 0600 "$B/vatra.env" "$R/srv/vatra/.env"
printf 'listener 1883\nallow_anonymous true\npersistence true\npersistence_location /mosquitto/data/\n' \
  > "$R/srv/vatra/mosquitto/config/mosquitto.conf"
# the Vatra container runs as uid 1000 (node), mosquitto as 1883
chown -R 1000:1000 "$R/srv/vatra/data"
chown -R 1883:1883 "$R/srv/vatra/mosquitto"
cp "$B"/images/*.tar.zst "$R/opt/vatra/images/"
install -D -m 0644 "$V/../../pi/avahi-vmui.service" "$R/etc/avahi/services/vatra.service"
chmod 0755 "$R"/opt/vatra/bin/*

units=(vatra-firstboot.service vatra-stack.service vatra-bootnote.path docker.service avahi-daemon.service)
[ "$PLATFORM" = pi ] && units+=(vatra-netsetup.service NetworkManager.service)
systemctl --root="${R:-/}" enable "${units[@]}"
echo "vatra hub ($PLATFORM/$ARCH): $(grep -c '_IMAGE=' "$R/srv/vatra/.env") images pinned, $(ls "$R/opt/vatra/images" | wc -l) baked"
