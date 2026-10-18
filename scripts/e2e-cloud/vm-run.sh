#!/usr/bin/env bash
# Startup script of a vmui cloud e2e VM (launched by scripts/e2e-cloud/run.mjs).
# Contract — everything under gs://<bucket>/runs/<id>/:
#   in:  src.tgz (working tree)
#   out: log (streamed every 15 s), report.tgz, results.tgz, fetch.tgz, meta.json,
#        exit-code (written LAST)
# The VM deletes itself in the EXIT trap; --max-run-duration is the backstop.
set -uo pipefail

md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
attr() { md "attributes/$1" 2>/dev/null || true; }

RUN_ID="$(attr run-id)"
BUCKET="$(attr bucket)"
PW_ARGS="$(attr pw-args | base64 -d)"
CMD="$(attr cmd | base64 -d)"
FETCH="$(attr fetch | base64 -d)"
KEEP="$(attr keep)"
NAME="$(md name)"
ZONE="$(md zone | awk -F/ '{print $NF}')"
RUN="gs://${BUCKET}/runs/${RUN_ID}"
W=/home/runner/work
LOG=/var/log/vmui-e2e.log
T0=$(date +%s)
: > "$LOG"; chmod 644 "$LOG"
exec > >(tee -a "$LOG") 2>&1

phase() { echo "::phase $1 $(( $(date +%s) - T0 ))s"; }

finish() {
  local code=$?
  [ -f /tmp/pw-exit ] && code="$(cat /tmp/pw-exit)"
  phase "done exit=$code"
  # Never `kill 0`: that signals the whole process group, i.e. this trap itself.
  for p in "${SYNC_PID:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  pkill -u runner -f 'next start' 2>/dev/null || true
  [ -f /tmp/next.log ] && { echo "---- next start log (tail) ----"; tail -n 80 /tmp/next.log; }
  if cd "$W" 2>/dev/null; then
    [ -d playwright-report ] && tar -czf /tmp/report.tgz playwright-report && gcloud storage cp -q /tmp/report.tgz "$RUN/report.tgz"
    [ -d test-results ] && tar -czf /tmp/results.tgz test-results && gcloud storage cp -q /tmp/results.tgz "$RUN/results.tgz"
    if [ -n "$FETCH" ]; then
      # shellcheck disable=SC2086
      tar -czf /tmp/fetch.tgz $FETCH 2>/dev/null && gcloud storage cp -q /tmp/fetch.tgz "$RUN/fetch.tgz"
    fi
  fi
  printf '{"runId":"%s","machine":"%s","zone":"%s","seconds":%s,"phases":"%s","exit":%s}\n' \
    "$RUN_ID" "$(md machine-type | awk -F/ '{print $NF}')" "$ZONE" "$(( $(date +%s) - T0 ))" \
    "$(grep -o '::phase [a-z-]* [0-9]*s' "$LOG" | awk '{print $2"="$3}' | paste -sd, -)" "$code" > /tmp/meta.json
  gcloud storage cp -q /tmp/meta.json "$RUN/meta.json"
  gcloud storage cp -q "$LOG" "$RUN/log"
  echo "$code" > /tmp/exit-code && gcloud storage cp -q /tmp/exit-code "$RUN/exit-code"
  [ "$KEEP" != "1" ] && gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet --delete-disks=all
}
trap finish EXIT

( while sleep 15; do gcloud storage cp -q "$LOG" "$RUN/log" 2>/dev/null; done ) &
SYNC_PID=$!

phase boot
mkdir -p "$W" && cd "$W"
gcloud storage cp -q "$RUN/src.tgz" /tmp/src.tgz && tar -xzf /tmp/src.tgz -C "$W" || exit 1
chown -R runner:runner "$W"
phase fetched

export TZ=Europe/Bucharest CI=1 VMUI_E2E_CLOUD=1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
export NEXT_TELEMETRY_DISABLED=1 HUSKY=0
export VMUI_DB_PATH=/home/runner/vmui-e2e.db
# Throwaway per-run master key; never echoed (set -x is off on purpose).
VMUI_MASTER_KEY="$(head -c32 /dev/urandom | xxd -p -c64)"
export VMUI_MASTER_KEY
# Throwaway kiosk token so /display renders the real (paired) kiosk in the audit.
ESP_DISPLAY_TOKEN="e2e$(head -c12 /dev/urandom | xxd -p -c24)"
export ESP_DISPLAY_TOKEN
as_runner() { sudo -u runner -H --preserve-env bash -lc "export PATH=~/.local/bin:\$PATH; cd $W && $1"; }

# pnpm version from package.json (corepack). The desktop app is not needed: filtered install
# first, full install as the fallback.
as_runner "corepack enable --install-directory ~/.local/bin >/dev/null 2>&1; pnpm --version" || true
as_runner "pnpm config set store-dir /home/runner/.pnpm-store && (pnpm install --frozen-lockfile --prefer-offline --filter 'vmui...' || pnpm install --frozen-lockfile --prefer-offline)" || exit 1
# Browsers: only when the image's chromium is not the one this lockfile's Playwright expects.
if ! as_runner "node -e \"const fs=require('fs');process.exit(fs.existsSync(require('@playwright/test').chromium.executablePath())?0:1)\"" 2>/dev/null; then
  as_runner "pnpm exec playwright install chromium" || exit 1
fi
phase install

as_runner "NODE_ENV=production NODE_OPTIONS=--max-old-space-size=12288 pnpm build:only" || exit 1
phase build
as_runner "NODE_ENV=production nohup pnpm exec next start -H 127.0.0.1 -p 3737 > /tmp/next.log 2>&1 &"
code=000
for _ in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3737/api/health || true)"
  [ "$code" != "000" ] && break
  sleep 2
done
[ "$code" = "000" ] && { echo "server never answered /api/health"; exit 1; }
echo "health=$code"
# /api/health imported the db module, so the schema exists now.
as_runner "node scripts/e2e-cloud/seed.cjs" || exit 1
export PW_BASE_URL=http://127.0.0.1:3737 PW_SESSION_FILE=/tmp/e2e-session
phase server

phase tests
if [ -n "$CMD" ]; then
  as_runner "$CMD"; echo $? > /tmp/pw-exit
else
  as_runner "pnpm exec playwright test $PW_ARGS"; echo $? > /tmp/pw-exit
fi
exit 0
