#!/usr/bin/env bash
# Whole-hub backup moved to another hub (P5-06), on the real image.
#   node scripts/e2e-cloud/run.mjs --cmd "bash deploy/vatra/backup-smoke.sh" --fetch test-results
# Hub A (claimed, one session) -> encrypted backup -> fresh hub B restores it with its setup code
# -> B restarts on its own (restart policy), is claimed, accepts A's session, holds A's master key.
set -euo pipefail
OUT=test-results/backup/smoke.txt
mkdir -p test-results/backup; : > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }
fail() { say "FAIL: $*"; exit 1; }
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1
D="sudo docker"
W=$(mktemp -d)

T0=$(date +%s)
$D build -q -t vatra:bk . >/dev/null 2>"$W/build.log" || { tail -n 40 "$W/build.log"; fail build; }
say "image built in $(( $(date +%s) - T0 ))s"

hub() { # $1 name  $2 port
  $D run -d --name "$1" --restart unless-stopped -p "127.0.0.1:$2:3737" -v "$1:/data" vatra:bk >/dev/null
  for _ in $(seq 1 60); do
    [ "$($D inspect -f '{{.State.Health.Status}}' "$1")" = healthy ] && return 0
    sleep 2
  done
  $D logs "$1" | tail -n 30; fail "$1 not healthy"
}
claimed() { curl -fsS --max-time 60 "http://127.0.0.1:$1/api/discover" | python3 -c 'import json,sys; print(json.load(sys.stdin)["claimed"])'; }
keyhash() { $D exec "$1" sha256sum /data/vatra-master.key | cut -c1-16; }

hub hub-a 14001
# the image ships Next's traced standalone tree (pnpm symlinks): resolve modules as server.js does
$D cp scripts/e2e-cloud/seed.cjs hub-a:/tmp/seed.cjs
BSQ=$($D exec hub-a sh -c 'find /app/node_modules -maxdepth 6 -type d -name better-sqlite3 2>/dev/null | head -1')
say "better-sqlite3 in image: ${BSQ:-none}"
[ -n "$BSQ" ] || { $D exec hub-a sh -c 'ls /app/node_modules | head -40' | tee -a "$OUT"; fail "better-sqlite3 not in the image"; }
timeout 60 $D exec -e VMUI_DB_PATH=/data/vmui.db -e E2E_SESSION_OUT=/data/sess -e NODE_PATH="$(dirname "$BSQ")" hub-a node /tmp/seed.cjs </dev/null \
  | tee -a "$OUT" || fail "seed failed"
SESS=$($D exec hub-a cat /data/sess | tr -d '\r\n')
[ "$(claimed 14001)" = True ] || fail "hub A not claimed after seed"
say "hub A claimed (seeded admin + session)"

# weak passphrase refused, then a real backup
code=$(curl -s --max-time 60 -o /dev/null -w '%{http_code}' -b "vmui_session=$SESS" -H 'content-type: application/json' -d '{"passphrase":"short"}' http://127.0.0.1:14001/api/backup)
[ "$code" = 400 ] || fail "weak passphrase answered $code"
code=$(curl -s --max-time 60 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"passphrase":"long enough passphrase"}' http://127.0.0.1:14001/api/backup)
[ "$code" = 307 ] || [ "$code" = 401 ] || fail "anonymous backup answered $code"
curl -fsS --max-time 60 -o "$W/a.vatrabk" -b "vmui_session=$SESS" -H 'content-type: application/json' -d '{"passphrase":"long enough passphrase"}' http://127.0.0.1:14001/api/backup
head -c 8 "$W/a.vatrabk" | grep -q VATRABK1 || fail "not a backup file"
grep -qa "SQLite format 3" "$W/a.vatrabk" && fail "database visible in clear"
say "backup: weak 400, anonymous $code, owner $(stat -c %s "$W/a.vatrabk") bytes, encrypted"

hub hub-b 14002
[ "$(claimed 14002)" = False ] || fail "hub B should start unclaimed"
SETUP=$($D exec hub-b cat /data/vatra-setup-code.txt | tr -d '\r\n')
[ "$(keyhash hub-a)" != "$(keyhash hub-b)" ] || fail "hubs share a key before restore"

post() { # $1 setup code  $2 passphrase -> http code
  curl -s --max-time 60 -o "$W/r.json" -w '%{http_code}' -F "setupCode=$1" -F "passphrase=$2" -F "file=@$W/a.vatrabk" http://127.0.0.1:14002/api/backup/restore
}
c=$(post 000000 "long enough passphrase"); [ "$c" = 403 ] || fail "wrong setup code answered $c"
c=$(post "$SETUP" "wrong passphrase!!"); [ "$c" = 400 ] || fail "wrong passphrase answered $c"
grep -q backup_passphrase "$W/r.json" || fail "wrong passphrase code: $(cat "$W/r.json")"
say "restore refusals: wrong setup code 403, wrong passphrase 400 backup_passphrase"
c=$(post "$SETUP" "long enough passphrase"); [ "$c" = 200 ] || fail "restore answered $c: $(cat "$W/r.json")"
say "restore accepted: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["restarting"], d["info"]["appVersion"])' "$W/r.json")"

# B exits, Docker restarts it, instrumentation swaps the staged files in
sleep 3
for _ in $(seq 1 60); do curl -fsS --max-time 60 -o /dev/null http://127.0.0.1:14002/api/discover 2>/dev/null && break; sleep 2; done
say "hub B restarts: $($D inspect -f '{{.RestartCount}}' hub-b) restart(s)"
[ "$(claimed 14002)" = True ] || fail "hub B not claimed after restore"
[ "$(keyhash hub-a)" = "$(keyhash hub-b)" ] || fail "hub B does not hold hub A's master key"
c2=$(curl -s --max-time 60 -o /dev/null -w '%{http_code}' -b "vmui_session=$SESS" http://127.0.0.1:14002/settings)
[ "$c2" = 200 ] || fail "hub A's session not accepted on B ($c2)"
$D exec hub-b sh -c 'ls /data | grep -c pre-restore' | grep -q '^[1-9]' || fail "replaced files not kept"
say "hub B: claimed, same master key, A's session -> /settings $c2, old files kept as *.pre-restore"
c=$(post "$SETUP" "long enough passphrase"); [ "$c" = 401 ] || fail "restore on claimed hub without session answered $c"
say "claimed hub refuses anonymous restore: 401"
$D rm -f hub-a hub-b >/dev/null; $D volume rm hub-a hub-b >/dev/null
say "BACKUP SMOKE OK"
