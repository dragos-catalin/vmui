#!/usr/bin/env bash
# vatra-updater end to end on a throwaway VM (P5-03), against real Docker, a local registry and
# real cosign signatures (key mode: keyless needs a GitHub OIDC token, the logic is identical).
#   node scripts/e2e-cloud/run.mjs --cmd "bash deploy/vatra/updater/updater-smoke.sh" --fetch test-results
# Proves: install.sh, first install, signed update with snapshot, refused downgrade / tampered
# manifest / unsigned image, a broken release rolls back .env AND /srv/vatra/data, manual rollback.
set -euo pipefail
OUT=test-results/updater/smoke.txt
mkdir -p test-results/updater; : > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }
fail() { say "FAIL: $*"; sudo cat /srv/vatra/data/update-status.json 2>/dev/null | tee -a "$OUT" || true; exit 1; }

command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1
D="sudo docker"
REG=localhost:5000
W=$(mktemp -d)

# --- installer (pinned cosign, units) --------------------------------------------------------
sudo bash deploy/vatra/updater/install.sh --no-timer | tee -a "$OUT"
systemctl cat vatra-updater.service >/dev/null && say "units installed: ok"
U() { sudo /usr/local/bin/vatra-updater "$@" --config /srv/vatra/updater.json; }

# --- images: 0.4.0, 0.5.0 (real builds), broken 0.6.0, unsigned 0.5.1 -------------------------
$D run -d --name reg -p 127.0.0.1:5000:5000 registry:2 >/dev/null
build() { # $1 version
  local ctx="$W/ctx-$1"; mkdir -p "$ctx"
  tar --exclude=./node_modules --exclude=./.next --exclude=./test-results --exclude=./.git -cf - . | tar -xf - -C "$ctx"
  sed -i -E "s/\"version\": \"[^\"]+\"/\"version\": \"$1\"/" "$ctx/package.json"
  $D build -q -t "$REG/vatra:$1" "$ctx" >/dev/null 2>"$W/build-$1.log" || { tail -n 40 "$W/build-$1.log"; fail "build $1"; }
}
T0=$(date +%s); build 0.4.0; build 0.5.0; say "two real builds in $(( $(date +%s) - T0 ))s"
printf 'FROM %s/vatra:0.5.0\nCMD ["sh","-c","echo broken > /data/marker; exit 1"]\n' "$REG" | $D build -q -t "$REG/vatra:0.6.0" - >/dev/null
printf 'FROM %s/vatra:0.5.0\nLABEL unsigned=1\n' "$REG" | $D build -q -t "$REG/vatra:0.5.1" - >/dev/null
digest() { $D push "$REG/vatra:$1" | awk '/digest:/{print $3}'; }
declare -A IMG
for v in 0.4.0 0.5.0 0.6.0 0.5.1; do IMG[$v]="$REG/vatra@$(digest $v)"; done
MOSQ=$($D pull -q eclipse-mosquitto:2 >/dev/null && $D inspect --format '{{index .RepoDigests 0}}' eclipse-mosquitto:2)

cd "$W"
export COSIGN_PASSWORD=""
cosign() { /usr/local/bin/cosign "$@"; }
cosign generate-key-pair >/dev/null 2>&1
for v in 0.4.0 0.5.0 0.6.0; do
  cosign sign --yes --key cosign.key --use-signing-config=false --tlog-upload=false --allow-insecure-registry "${IMG[$v]}" >/dev/null 2>"sign-$v.log" || { cat "sign-$v.log"; exit 1; }
done
cd - >/dev/null
say "images signed: 0.4.0 0.5.0 0.6.0 (0.5.1 left unsigned)"

manifest() { # $1 version  $2 image ; writes + signs $W/stable.json
  python3 - "$1" "$2" "$MOSQ" > "$W/stable.json" <<'PY'
import json, sys
v, img, mosq = sys.argv[1:]
print(json.dumps({"schema": 1, "channel": "stable", "version": v, "apiVersion": 1, "minClient": 1,
                  "images": {"VATRA_IMAGE": img, "MOSQUITTO_IMAGE": mosq}}, indent=2))
PY
  (cd "$W" && cosign sign-blob --yes --key cosign.key --use-signing-config=false --tlog-upload=false --bundle stable.json.sigstore stable.json >/dev/null 2>sign-blob.log) || { cat "$W/sign-blob.log"; exit 1; }
}

# --- hub layout as the image ships it ---------------------------------------------------------
sudo fuser -k 3737/tcp 2>/dev/null || true
sudo mkdir -p /srv/vatra/data /srv/vatra/mosquitto/config /srv/vatra/mosquitto/data
printf 'listener 1883 127.0.0.1\nallow_anonymous true\n' | sudo tee /srv/vatra/mosquitto/config/mosquitto.conf >/dev/null
sudo chown -R 1000:1000 /srv/vatra/data /srv/vatra/mosquitto
sudo cp deploy/vatra/compose.yaml /srv/vatra/compose.yaml
Z=sha256:0000000000000000000000000000000000000000000000000000000000000000
printf 'TZ=Europe/Bucharest\nHA_IMAGE=ghcr.io/home-assistant/home-assistant@%s\nESPHOME_IMAGE=ghcr.io/esphome/esphome@%s\n' "$Z" "$Z" | sudo tee /srv/vatra/.env >/dev/null
sudo cp "$W/cosign.pub" /srv/vatra/cosign.pub
sudo tee /srv/vatra/updater.json >/dev/null <<EOF
{ "channel": "stable", "manifest_url": "file://$W/stable.json", "verify": "key",
  "public_key": "/srv/vatra/cosign.pub", "insecure_ignore_tlog": true, "allow_insecure_registry": true,
  "health_timeout": { "default": 120 } }
EOF
ver() { curl -fsS http://127.0.0.1:3737/api/discover | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'; }
pin() { sudo grep '^VATRA_IMAGE=' /srv/vatra/.env | cut -d= -f2; }
rc() { set +e; U "$@" >>"$W/u.log" 2>&1; local c=$?; set -e; echo "$c"; }

# 1) first install
manifest 0.4.0 "${IMG[0.4.0]}"
c=$(rc apply); [ "$c" = 0 ] || { tail -n 30 "$W/u.log"; fail "first install exit $c"; }
[ "$(ver)" = 0.4.0 ] || fail "discover version $(ver)"
say "1 first install 0.4.0: ok (exit 0, healthy)"
echo v4 | sudo tee /srv/vatra/data/marker >/dev/null

# 2) signed update with snapshot
manifest 0.5.0 "${IMG[0.5.0]}"
c=$(rc apply); [ "$c" = 0 ] || { tail -n 30 "$W/u.log"; fail "update exit $c"; }
[ "$(ver)" = 0.5.0 ] || fail "discover version after update $(ver)"
n=$(sudo ls /srv/vatra/snapshots | wc -l); [ "$n" -ge 1 ] || fail "no snapshot"
say "2 update 0.4.0 -> 0.5.0: ok (snapshot $(sudo ls /srv/vatra/snapshots | tail -1))"
echo v5 | sudo tee /srv/vatra/data/marker >/dev/null

# 3) refusals leave the hub untouched
before=$(pin)
manifest 0.4.0 "${IMG[0.4.0]}"; c=$(rc apply); [ "$c" = 1 ] && [ "$(pin)" = "$before" ] || fail "downgrade not refused ($c)"
say "3a downgrade 0.5.0 -> 0.4.0 refused: ok"
manifest 0.5.1 "${IMG[0.5.1]}"; c=$(rc apply); [ "$c" = 1 ] && [ "$(pin)" = "$before" ] || fail "unsigned image not refused ($c)"
say "3b unsigned image refused: ok"
manifest 0.6.0 "${IMG[0.6.0]}"; sudo sed -i "s#${IMG[0.6.0]}#${IMG[0.5.1]}#" "$W/stable.json"
c=$(rc apply); [ "$c" = 1 ] && [ "$(pin)" = "$before" ] || fail "tampered manifest not refused ($c)"
say "3c tampered manifest refused: ok"

# 4) broken release rolls back image pin and state
manifest 0.6.0 "${IMG[0.6.0]}"
c=$(rc apply); [ "$c" = 2 ] || { tail -n 30 "$W/u.log"; fail "broken release exit $c (want 2)"; }
[ "$(pin)" = "$before" ] || fail "pin not restored"
[ "$(sudo cat /srv/vatra/data/marker)" = v5 ] || fail "state not restored: $(sudo cat /srv/vatra/data/marker)"
[ "$(ver)" = 0.5.0 ] || fail "not serving 0.5.0 after rollback"
[ "$(sudo stat -c %u /srv/vatra/data/vmui.db)" = 1000 ] || fail "restored db lost its owner"
say "4 broken 0.6.0 rolled back: ok (pin + /srv/vatra/data restored, serving 0.5.0)"
say "   status: $(sudo python3 -c 'import json; s=json.load(open("/srv/vatra/data/update-status.json")); print(s["result"], s["version"])')"

# 5) manual rollback restores the newest snapshot and stays healthy
c=$(rc rollback); [ "$c" = 0 ] && [ "$(ver)" = 0.5.0 ] || fail "manual rollback exit $c"
say "5 manual rollback: ok"

say "--- updater log (tail) ---"; tail -n 25 "$W/u.log" | tee -a "$OUT"
$D compose --env-file /srv/vatra/.env -f /srv/vatra/compose.yaml down >/dev/null 2>&1 || true
say "UPDATER SMOKE OK"
