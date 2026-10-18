#!/usr/bin/env bash
# Startup script of the ONE-OFF bake VM (scripts/e2e-cloud/bake-image.ps1).
# Installs everything a vmui e2e run needs, so a run VM boots straight into work.
# Powers the VM off when done; bake-image.ps1 then snapshots the disk into image
# family vmui-e2e-runner. Versions arrive as metadata (read from the repo).
set -euxo pipefail
exec > >(tee -a /var/log/vmui-bake.log) 2>&1

md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
PW_VERSION="$(md playwright-version)"
LH_VERSION="$(md lighthouse-version)"
BUNDLE="$(md bundle || true)"
MARKER="$(md marker)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  git curl ca-certificates jq unzip zstd xz-utils xxd build-essential python3 psmisc tzdata \
  fonts-noto-color-emoji fonts-liberation fonts-noto-core
# Romanian wall clock, same as the workstation (date formatting in screenshots).
timedatectl set-timezone Europe/Bucharest || ln -sf /usr/share/zoneinfo/Europe/Bucharest /etc/localtime

# Node: newest 24.x tarball from nodejs.org (not a distro package).
NODE_TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk '/linux-x64\.tar\.xz$/ {print $2; exit}')"
test -n "$NODE_TARBALL"
curl -fsSL "https://nodejs.org/dist/latest-v24.x/${NODE_TARBALL}" | tar -xJ -C /usr/local --strip-components=1
node --version
# corepack: pnpm comes from the repo's packageManager field at run time.
npm install -g corepack@latest
corepack enable

# Unprivileged user that runs every job.
id runner || useradd -m -s /bin/bash runner
echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner

# Playwright chromium + OS deps for the lockfile's Playwright, in a path runner owns
# (`playwright install` takes a lock INSIDE this dir; read-only = EACCES after minutes).
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
echo 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' >> /etc/environment
npx -y "playwright@${PW_VERSION}" install --with-deps chromium
chown -R runner:runner /opt/ms-playwright
chmod -R a+rX /opt/ms-playwright

# Lighthouse CLI (global binary, uses CHROME_PATH = Playwright's chromium).
npm install -g "lighthouse@${LH_VERSION}"
lighthouse --version

# Warm pnpm store from vmui's lockfile: a run then links instead of downloading.
if [ -n "$BUNDLE" ]; then
  mkdir -p /tmp/warm && cd /tmp/warm
  gcloud storage cp "$BUNDLE" src.tgz
  tar -xzf src.tgz
  chown -R runner:runner /tmp/warm
  # A warm store is an optimisation: a failure must not lose the whole bake.
  sudo -u runner -H bash -lc "corepack enable --install-directory ~/.local/bin >/dev/null 2>&1; export PATH=~/.local/bin:\$PATH; cd /tmp/warm && pnpm config set store-dir /home/runner/.pnpm-store && pnpm fetch" \
    || echo "WARN pnpm fetch failed; image ships a cold store"
  cd / && rm -rf /tmp/warm
fi

apt-get clean
rm -rf /var/lib/apt/lists/*
echo BAKE_OK
# Serial output is unreadable once the VM is TERMINATED: leave a marker in GCS.
echo ok | gcloud storage cp - "$MARKER" || true
shutdown -h now
