#!/usr/bin/env bash
# Compose stack smoke (P4-03): the file validates, refuses unpinned images, and the Vatra service
# comes up healthy read-only with cap_drop ALL. HA/ESPHome are skipped here (heavy pulls); their
# healthchecks are exercised on the Pi image (P5).
#   bash deploy/vatra/compose-smoke.sh <local image tag built by image-smoke.sh>
set -euo pipefail
D="sudo docker"
OUT=test-results/image/compose.txt
mkdir -p test-results/image; : > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }
IMG="${1:-vatra:smoke}"

# 1) missing pins are refused
if $D compose -f deploy/vatra/compose.yaml config >/dev/null 2>&1; then say "FAIL: compose accepted missing image pins"; exit 1; fi
say "unpinned config refused: ok"

# 2) a full config validates
ROOT=$(mktemp -d); sudo mkdir -p /srv/vatra/data /srv/vatra/mosquitto/config /srv/vatra/mosquitto/data
printf 'listener 1883 127.0.0.1\nallow_anonymous true\n' | sudo tee /srv/vatra/mosquitto/config/mosquitto.conf >/dev/null
sudo chown -R 1000:1000 /srv/vatra/data /srv/vatra/mosquitto
MOSQ=$($D pull -q eclipse-mosquitto:2 >/dev/null && $D inspect --format '{{index .RepoDigests 0}}' eclipse-mosquitto:2)
cat > "$ROOT/.env" <<EOF
VATRA_IMAGE=$IMG
HA_IMAGE=ghcr.io/home-assistant/home-assistant@sha256:0000000000000000000000000000000000000000000000000000000000000000
ESPHOME_IMAGE=ghcr.io/esphome/esphome@sha256:0000000000000000000000000000000000000000000000000000000000000000
MOSQUITTO_IMAGE=$MOSQ
EOF
$D compose --env-file "$ROOT/.env" -f deploy/vatra/compose.yaml config -q && say "pinned config valid: ok"

# 3) vatra + mosquitto up, healthy, hardened
# the e2e harness's own `next start` holds :3737 on this VM; the stack uses host networking
sudo fuser -k 3737/tcp 2>/dev/null || true
for _ in $(seq 1 10); do sudo fuser 3737/tcp >/dev/null 2>&1 || break; sleep 1; done
sudo fuser 3737/tcp >/dev/null 2>&1 && { say "port 3737 still busy"; exit 1; }
$D compose --env-file "$ROOT/.env" -f deploy/vatra/compose.yaml up -d vatra mosquitto
for i in $(seq 1 60); do
  s=$($D inspect -f '{{.State.Health.Status}}' vatra 2>/dev/null || echo none)
  [ "$s" = healthy ] && break; sleep 3
done
say "vatra health: $s"
[ "$s" = healthy ] || { $D logs vatra | tail -n 40; exit 1; }
say "read_only: $($D inspect -f '{{.HostConfig.ReadonlyRootfs}}' vatra)  cap_drop: $($D inspect -f '{{.HostConfig.CapDrop}}' vatra)"
[ "$($D inspect -f '{{.HostConfig.ReadonlyRootfs}}' vatra)" = true ] || exit 1
say "discover: $(curl -fsS http://127.0.0.1:3737/api/discover)"
say "/srv/vatra/data: $(sudo ls /srv/vatra/data | tr '\n' ' ')"
$D compose --env-file "$ROOT/.env" -f deploy/vatra/compose.yaml down -v >/dev/null
say "COMPOSE OK"
