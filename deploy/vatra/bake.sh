#!/usr/bin/env bash
# Bake the Vatra stack for an image build (P5-01 Pi, P5-05 x86): the Vatra + Mosquitto images
# saved as zstd tarballs (loaded at first boot) and the pinned .env the card/disk ships with.
#   bash deploy/vatra/bake.sh <arm64|amd64> <bake dir> [log dir]
# Env: VATRA_IMAGE_REF = use a released image (by digest) instead of building this tree.
# Needs docker (containerd image store) + jq + zstd on a host of the same architecture.
set -euo pipefail
ARCH="$1"; BAKE="$2"; LOGS="${3:-/tmp}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(jq -r .version "$SRC/package.json")"
pin() { jq -r ".images.$1" "$SRC/deploy/vatra/pins.json"; }
MOSQ="$(pin MOSQUITTO_IMAGE)"
rm -rf "$BAKE"; install -d -m 0755 "$BAKE/images"
if [ -n "${VATRA_IMAGE_REF:-}" ]; then
  VIMG="$VATRA_IMAGE_REF"
  docker pull -q --platform "linux/$ARCH" "$VIMG" >/dev/null
else
  VIMG="vatra:$VERSION"
  docker build --progress=plain --platform "linux/$ARCH" -t "$VIMG" "$SRC" > "$LOGS/docker-build.log" 2>&1 \
    || { grep -vE '^#[0-9]+ [0-9.]+ (Downloading|Progress)' "$LOGS/docker-build.log" | tail -n 80; echo "vatra image build failed"; exit 1; }
fi
docker pull -q --platform "linux/$ARCH" "$MOSQ" >/dev/null
# A single-platform save keeps only this platform's manifest, so after `docker load` the pinned
# multi-arch INDEX digest no longer resolves locally and compose goes to the registry (offline =
# no hub). Baked images are therefore referenced by a local tag that names the pinned digest;
# vatra-updater moves them to signed digests on its first run.
MOSQ_LOCAL="vatra-baked/mosquitto:${MOSQ##*sha256:}"
MOSQ_LOCAL="${MOSQ_LOCAL:0:41}"
docker tag "$MOSQ" "$MOSQ_LOCAL"
if [ -z "${VATRA_IMAGE_REF:-}" ]; then VIMG_LOCAL="$VIMG"; else
  VIMG_LOCAL="vatra-baked/vatra:${VIMG##*sha256:}"; VIMG_LOCAL="${VIMG_LOCAL:0:38}"
  docker tag "$VIMG" "$VIMG_LOCAL"
fi
docker save --platform "linux/$ARCH" "$VIMG_LOCAL" | zstd -q -T0 -10 -o "$BAKE/images/10-vatra.tar.zst"
docker save --platform "linux/$ARCH" "$MOSQ_LOCAL" | zstd -q -T0 -10 -o "$BAKE/images/20-mosquitto.tar.zst"
cat > "$BAKE/vatra.env" <<EOF
# /srv/vatra/.env as shipped; vatra-updater rewrites the image lines from the signed channel
# manifest (P5-03). Baked images use local tags (vatra-baked/*:<pinned digest prefix>) so the
# hub starts with no internet; HA / ESPHome are pulled by digest once online.
TZ=Europe/Bucharest
VATRA_VERSION=$VERSION
VATRA_IMAGE=$VIMG_LOCAL
HA_IMAGE=$(pin HA_IMAGE)
ESPHOME_IMAGE=$(pin ESPHOME_IMAGE)
MOSQUITTO_IMAGE=$MOSQ_LOCAL
EOF
echo "baked $ARCH: $(du -sh "$BAKE/images" | cut -f1) ($(ls "$BAKE/images" | tr '\n' ' '))"
