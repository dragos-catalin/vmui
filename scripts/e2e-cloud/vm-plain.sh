#!/usr/bin/env bash
# Startup script of a plain cloud VM (run.mjs --plain / --arm64 / --nested): Debian 13, no app build.
# Same bucket contract as vm-run.sh: in src.tgz; out log (every 15 s), fetch.tgz, meta.json,
# exit-code (LAST). GCS + self-delete go through the metadata token and the REST APIs, so the
# image needs nothing but curl. --max-run-duration deletes the VM if this never finishes.
set -uo pipefail

MD=http://metadata.google.internal/computeMetadata/v1
md() { curl -fsS -H 'Metadata-Flavor: Google' "$MD/instance/$1"; }
attr() { md "attributes/$1" 2>/dev/null || true; }
token() { curl -fsS -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" | sed -E 's/.*"access_token":"([^"]+)".*/\1/'; }
# object names here are [A-Za-z0-9._/-] only
urlenc() { printf '%s' "$1" | sed 's|/|%2F|g'; }

RUN_ID="$(attr run-id)"
BUCKET="$(attr bucket)"
CMD="$(attr cmd | base64 -d)"
FETCH="$(attr fetch | base64 -d)"
KEEP="$(attr keep)"
NAME="$(md name)"
ZONE="$(md zone | awk -F/ '{print $NF}')"
PROJECT="$(curl -fsS -H 'Metadata-Flavor: Google' "$MD/project/project-id")"
export RUN="gs://${BUCKET}/runs/${RUN_ID}" RUN_ID BUCKET
export HOME=/root
W=/root/work
LOG=/var/log/vmui-plain.log
T0=$(date +%s)
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

# gsput <local file> <object name under runs/<id>/>   (exported for the command)
gsput() {
  curl -fsS -X POST -H "Authorization: Bearer $(token)" -H 'Content-Type: application/octet-stream' \
    --upload-file "$1" -o /dev/null \
    "https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=$(urlenc "runs/${RUN_ID}/$2")"
}
gsget() {
  curl -fsS -H "Authorization: Bearer $(token)" -o "$2" \
    "https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/$(urlenc "runs/${RUN_ID}/$1")?alt=media"
}
export -f gsput token urlenc
export BUCKET RUN_ID
export MD

phase() { echo "::phase $1 $(( $(date +%s) - T0 ))s"; }

finish() {
  local code=$?
  [ -f /tmp/cmd-exit ] && code="$(cat /tmp/cmd-exit)"
  phase "done exit=$code"
  [ -n "${SYNC_PID:-}" ] && kill "$SYNC_PID" 2>/dev/null
  if [ -n "$FETCH" ] && cd "$W" 2>/dev/null; then
    # shellcheck disable=SC2086
    tar -czf /tmp/fetch.tgz $FETCH 2>/dev/null && gsput /tmp/fetch.tgz fetch.tgz
  fi
  printf '{"runId":"%s","machine":"%s","zone":"%s","seconds":%s,"phases":"%s","exit":%s}\n' \
    "$RUN_ID" "$(md machine-type | awk -F/ '{print $NF}')" "$ZONE" "$(( $(date +%s) - T0 ))" \
    "$(grep -o '::phase [a-z0-9-]* [0-9]*s' "$LOG" | awk '{print $2"="$3}' | paste -sd, -)" "$code" > /tmp/meta.json
  gsput /tmp/meta.json meta.json
  gsput "$LOG" log
  echo "$code" > /tmp/exit-code && gsput /tmp/exit-code exit-code
  if [ "$KEEP" != "1" ]; then
    curl -fsS -X DELETE -H "Authorization: Bearer $(token)" -o /dev/null \
      "https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/${NAME}"
  fi
}
trap finish EXIT

( while sleep 15; do gsput "$LOG" log 2>/dev/null; done ) &
SYNC_PID=$!

phase boot
mkdir -p "$W" && cd "$W"
gsget src.tgz /tmp/src.tgz && tar -xzf /tmp/src.tgz -C "$W" || exit 1
echo "arch=$(dpkg --print-architecture) kernel=$(uname -r) cpus=$(nproc) mem=$(free -g | awk '/Mem:/{print $2}')G"
phase fetched

phase cmd
bash -c "$CMD"; echo $? > /tmp/cmd-exit
exit 0
