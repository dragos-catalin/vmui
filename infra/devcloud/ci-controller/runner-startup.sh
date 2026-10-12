#!/usr/bin/env bash
# devcloud JIT runner VM (DC-041). One VM = one JIT runner = exactly one job, then power off.
# The ci-controller deletes the VM on the `completed` webhook; a powered-off (TERMINATED) or
# over-age gha-* VM is deleted by the controller janitor; max-run-duration (DELETE) is the backstop.
# The VM has NO service account: the job holds no GCP credentials.
# On a devcloud-ci-* image (DC-042, /opt/devcloud/baked) the runner starts at once; on stock Ubuntu
# 24.04 (no baked image for the toolchain yet) it bootstraps node/chrome/runner first (~1-2 min).
# Serial markers: `::runner-online <s>s` = seconds since kernel boot when the runner listens (the
# controller copies it into the job record as bootSec).
set -uo pipefail
exec > >(tee -a /var/log/devcloud-runner.log) 2>&1
md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
T0=$(date +%s)
IDLE_MIN="$(md attributes/idle-minutes 2>/dev/null || echo 20)"
VER="$(md attributes/runner-version 2>/dev/null || echo 2.338.0)"
bye() { echo "::runner-exit $(date -Is) after $(( $(date +%s) - T0 ))s"; sync; shutdown -h now; }
trap bye EXIT

R=/opt/actions-runner; mkdir -p "$R"
if [ -f /opt/devcloud/baked ]; then
  echo "::image $(cat /opt/devcloud/image.json 2>/dev/null)"
else
  export DEBIAN_FRONTEND=noninteractive
  echo "::bootstrap start $(date -Is)"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends git curl jq zstd unzip ca-certificates build-essential python3 >/dev/null
  # Chrome for Lighthouse CI (ubuntu-latest ships it).
  curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y -qq /tmp/chrome.deb >/dev/null || echo "::warn chrome install failed"
  id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
  echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
  curl -fsSL "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz" | tar -xz -C "$R"
  "$R/bin/installdependencies.sh" >/dev/null 2>&1 || true
  cat > "$R/.env" <<'EOF'
LANG=C.UTF-8
DEVCLOUD_RUNNER=1
EOF
  chown -R runner:runner "$R"
  echo "::bootstrap done $(( $(date +%s) - T0 ))s"
fi

JIT="$(md attributes/jit-config)"
mkfifo /tmp/runner.out
sudo -u runner -H bash -c "cd $R && ./run.sh --jitconfig '$JIT'" > /tmp/runner.out 2>&1 &
RUNNER_PID=$!
unset JIT
( while IFS= read -r line; do
    echo "$line"
    case "$line" in *"Listening for Jobs"*) echo "::runner-online $(cut -d. -f1 /proc/uptime)s" ;; esac
  done < /tmp/runner.out ) &

# Idle watchdog: a Worker_ log appears the moment a job is assigned.
for _ in $(seq 1 $((IDLE_MIN * 6))); do
  sleep 10
  kill -0 "$RUNNER_PID" 2>/dev/null || break
  if ls "$R"/_diag/Worker_*.log >/dev/null 2>&1; then echo "::job-assigned $(date -Is)"; break; fi
done
if ! ls "$R"/_diag/Worker_*.log >/dev/null 2>&1 && kill -0 "$RUNNER_PID" 2>/dev/null; then
  echo "::idle no job within ${IDLE_MIN} min"; kill "$RUNNER_PID"; exit 0
fi
wait "$RUNNER_PID"
