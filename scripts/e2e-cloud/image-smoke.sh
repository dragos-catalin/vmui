#!/usr/bin/env bash
# Build the hub image on the e2e VM and smoke-test it (P4-01).
#   node scripts/e2e-cloud/run.mjs --cmd "bash scripts/e2e-cloud/image-smoke.sh" --fetch test-results
# Proves: the Dockerfile builds from a clean context, the container answers /api/discover and
# turns healthy, runs as non-root, keeps its state in /data (db + generated master key).
set -euo pipefail
mkdir -p test-results/image
OUT=test-results/image/smoke.txt
: > "$OUT"
say() { echo "$*" | tee -a "$OUT"; }

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1
fi
sudo usermod -aG docker "$(id -un)" || true
D="sudo docker"

say "docker $($D version --format '{{.Server.Version}}')"
T0=$(date +%s)
$D build --progress=plain -t vatra:smoke . > test-results/image/build.log 2>&1 || { tail -n 60 test-results/image/build.log; say "BUILD FAILED"; exit 1; }
say "build ok in $(( $(date +%s) - T0 ))s; size $($D image inspect vatra:smoke --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1048576}')"

$D volume create vatra-smoke >/dev/null
$D run -d --name vatra-smoke -p 13737:3737 -v vatra-smoke:/data vatra:smoke >/dev/null
for i in $(seq 1 60); do
  s=$($D inspect -f '{{.State.Health.Status}}' vatra-smoke 2>/dev/null || echo none)
  [ "$s" = "healthy" ] && break
  [ "$($D inspect -f '{{.State.Running}}' vatra-smoke)" = "true" ] || { $D logs vatra-smoke | tail -n 40; say "CONTAINER EXITED"; exit 1; }
  sleep 3
done
say "health $s after $(( i * 3 ))s"
[ "$s" = "healthy" ] || { $D logs vatra-smoke | tail -n 40; exit 1; }

disc=$(curl -fsS http://127.0.0.1:13737/api/discover)
say "discover $disc"
echo "$disc" | grep -q '"product":"vatra"' || { say "discover: wrong product"; exit 1; }
echo "$disc" | grep -q '"claimed":false' || { say "discover: fresh image must be unclaimed"; exit 1; }
say "uid $($D exec vatra-smoke id -u) (want != 0)"
[ "$($D exec vatra-smoke id -u)" != "0" ] || exit 1
data=$($D exec vatra-smoke ls -1 /data | tr '\n' ' ')
say "/data: $data"
echo "$data" | grep -q 'vmui.db' || { say "db not in /data"; exit 1; }
echo "$data" | grep -q 'vatra-master.key' || { say "master key not generated in /data"; exit 1; }
say "key mode $($D exec vatra-smoke stat -c %a /data/vatra-master.key) (want 600)"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13737/api/v1/app/state)
say "v1 anon $code (want 401)"
[ "$code" = "401" ] || exit 1
$D logs vatra-smoke 2>&1 | grep -iE 'setup code' | sed -E 's/[0-9]{3}-?[0-9]{3}/***/g' | head -1 | tee -a "$OUT" || true
$D rm -f vatra-smoke >/dev/null; $D volume rm vatra-smoke >/dev/null
say "SMOKE OK"
bash deploy/vatra/compose-smoke.sh vatra:smoke
