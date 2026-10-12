#!/usr/bin/env bash
# devcloud DC-042: provision a CI runner image on a throwaway bake VM (stock Ubuntu 24.04).
# Toolchain (metadata `toolchain`): node24 | android-jdk21 | rust-tauri-linux | python-uv | flutter | polyglot
#   node24           node 24 + pnpm (codai packageManager) + chrome + actions runner (+ node in the runner
#                    tool cache, so setup-node is a no-op) + git/jq/zstd/build-essential/python3
#   android-jdk21    node24 + Temurin 21 + Android SDK (cmdline-tools, platform/build-tools, NDK)
#   rust-tauri-linux node24 + rustup stable + Tauri 2 Linux deps (webkit2gtk-4.1, appindicator, rsvg)
#   python-uv        node24 + uv + CPython 3.12 (uv-managed)
#   flutter          android-jdk21 + Flutter stable
#   polyglot         everything above
# node24 and polyglot also warm the pnpm store from the codai lockfile (metadata lock-0..lock-N =
# base64 gzip chunks; the bake VM has NO service account). Ends with `::image-setup done` (or
# `::image-setup failed <step>`) on the serial console, then powers off; bake.sh images the disk.
set -uo pipefail
exec > >(tee -a /var/log/devcloud-image-setup.log) 2>&1
md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
TC="$(md attributes/toolchain)"
RUNNER_VER="$(md attributes/runner-version 2>/dev/null || echo 2.338.0)"
PNPM_VER="$(md attributes/pnpm-version 2>/dev/null || echo 12.9.1)"
NODE_MAJOR=24
T0=$(date +%s)
STEP=init
fail() { echo "::image-setup failed $STEP"; sync; shutdown -h now; exit 1; }
step() { STEP="$1"; echo "::step $1 +$(( $(date +%s) - T0 ))s"; }
has() { case " $LAYERS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
case "$TC" in
  node24) LAYERS="base" ;;
  android-jdk21) LAYERS="base jdk android" ;;
  rust-tauri-linux) LAYERS="base rust" ;;
  python-uv) LAYERS="base python" ;;
  flutter) LAYERS="base jdk android flutter" ;;
  polyglot) LAYERS="base jdk android rust python flutter store" ;;
  *) STEP="unknown toolchain '$TC'"; fail ;;
esac
[ "$TC" = node24 ] && LAYERS="$LAYERS store"
echo "::image-setup start toolchain=$TC layers=[$LAYERS] $(date -Is)"
export DEBIAN_FRONTEND=noninteractive

step apt
apt-get update -qq || fail
apt-get install -y -qq --no-install-recommends git git-lfs curl wget jq zstd unzip zip xz-utils ca-certificates gnupg \
  build-essential pkg-config python3 python3-venv rsync openssh-client file ripgrep >/dev/null || fail

# ubuntu-latest parity: PowerShell (codai desktop eval tests shell out to pwsh) + GitHub CLI.
step pwsh-gh
curl -fsSL -o /tmp/msprod.deb https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb && dpkg -i /tmp/msprod.deb >/dev/null || fail
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg || fail
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq && apt-get install -y -qq --no-install-recommends powershell gh >/dev/null || fail
rm -f /tmp/msprod.deb
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' || fail

step node
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null || fail
apt-get install -y -qq nodejs >/dev/null || fail
NODE_VER="$(node -p process.versions.node)"
# pnpm 12 = native binary (Rust rewrite): the release tarball, not the npm shim.
step pnpm
mkdir -p /opt/pnpm
curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VER}/pnpm-linux-x64.tar.gz" | tar -xz -C /opt/pnpm || fail
PNPM_BIN="$(find /opt/pnpm -type f -name pnpm -perm -u+x | head -1)"
echo "::pnpm bin=${PNPM_BIN:-none} files=$(ls /opt/pnpm | tr '\n' ' ')"
[ -n "$PNPM_BIN" ] || fail
for b in pnpm pnpx pn pnx; do [ -e "$(dirname "$PNPM_BIN")/$b" ] && ln -sf "$(dirname "$PNPM_BIN")/$b" "/usr/local/bin/$b"; done
ln -sf "$PNPM_BIN" /usr/local/bin/pnpm
/usr/local/bin/pnpm --version || fail
corepack disable 2>/dev/null || true

step chrome
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb || fail
apt-get install -y -qq /tmp/chrome.deb >/dev/null || fail
rm -f /tmp/chrome.deb

step runner
id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
R=/opt/actions-runner; mkdir -p "$R"
curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VER}/actions-runner-linux-x64-${RUNNER_VER}.tar.gz" | tar -xz -C "$R" || fail
"$R/bin/installdependencies.sh" >/dev/null 2>&1 || fail
printf 'LANG=C.UTF-8\nDEVCLOUD_RUNNER=1\nDEVCLOUD_IMAGE=%s\n' "$TC" > "$R/.env"
# actions/setup-node looks in RUNNER_TOOL_CACHE (default <runner>/_work/_tool) first: seed it with the
# installed node so `node-version: '24'` resolves without a download.
TOOL="$R/_work/_tool/node/${NODE_VER}/x64"
mkdir -p "$TOOL" && cp -a /usr/bin/node "$TOOL/" 2>/dev/null
mkdir -p "$TOOL/bin" && ln -sf /usr/bin/node "$TOOL/bin/node" && ln -sf /usr/lib/node_modules/npm/bin/npm-cli.js "$TOOL/bin/npm" \
  && ln -sf /usr/lib/node_modules/npm/bin/npx-cli.js "$TOOL/bin/npx" && touch "$R/_work/_tool/node/${NODE_VER}/x64.complete"
rm -f "$TOOL/node"
chown -R runner:runner "$R"

if has jdk; then
  step jdk
  curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg || fail
  echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb noble main" > /etc/apt/sources.list.d/adoptium.list
  apt-get update -qq && apt-get install -y -qq temurin-21-jdk >/dev/null || fail
  echo "JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64" >> "$R/.env"
fi

if has android; then
  step android
  A=/opt/android-sdk; mkdir -p "$A/cmdline-tools"
  curl -fsSL -o /tmp/clt.zip "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip" || fail
  unzip -q /tmp/clt.zip -d "$A/cmdline-tools" && mv "$A/cmdline-tools/cmdline-tools" "$A/cmdline-tools/latest" && rm /tmp/clt.zip || fail
  export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
  SDKM="$A/cmdline-tools/latest/bin/sdkmanager"
  yes | "$SDKM" --sdk_root="$A" --licenses >/dev/null 2>&1
  # Latest platform/build-tools/NDK the channel offers (codai phone compileSdk 37).
  LIST="$("$SDKM" --sdk_root="$A" --list 2>/dev/null)"
  # Full package ids (platforms;android-37.0 since API 36.1); stable only (no -rc / ext / preview letters).
  PLAT="$(echo "$LIST" | grep -oE 'platforms;android-[0-9]+(\.[0-9]+)?( |$)' | tr -d ' ' | sort -V | uniq | tail -1)"
  BT="$(echo "$LIST" | grep -oE 'build-tools;[0-9]+\.[0-9]+\.[0-9]+( |$)' | tr -d ' ' | sort -V | uniq | tail -1)"
  NDK="$(echo "$LIST" | grep -oE 'ndk;[0-9]+\.[0-9]+\.[0-9]+( |$)' | tr -d ' ' | sort -V | uniq | tail -1)"
  echo "::android-pick plat=$PLAT bt=$BT ndk=$NDK"
  [ -n "$PLAT" ] && [ -n "$BT" ] && [ -n "$NDK" ] || fail
  "$SDKM" --sdk_root="$A" --install platform-tools "$PLAT" "$BT" "$NDK" >/dev/null || fail
  chown -R runner:runner "$A"
  printf 'ANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\nANDROID_NDK_HOME=%s/%s\n' "$A" "$A" "$A" "${NDK/;//}" >> "$R/.env"
  echo "::android $PLAT $BT $NDK"
fi

if has rust; then
  step rust
  apt-get install -y -qq --no-install-recommends libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libssl-dev libxdo-dev libgtk-3-dev patchelf >/dev/null || fail
  sudo -u runner -H bash -c 'curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable -c clippy,rustfmt' >/dev/null || fail
fi

if has python; then
  step python
  sudo -u runner -H bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh && ~/.local/bin/uv python install 3.12' >/dev/null || fail
fi

if has flutter; then
  step flutter
  sudo -u runner -H bash -c 'git clone -q --depth 1 -b stable https://github.com/flutter/flutter.git ~/flutter && ~/flutter/bin/flutter --disable-analytics >/dev/null && ~/flutter/bin/flutter precache --android --linux >/dev/null' || fail
fi

# PATH for job steps: the runner reads .path (one entry per line, prepended).
{
  echo /home/runner/.cargo/bin; echo /home/runner/.local/bin; echo /home/runner/flutter/bin
  echo /opt/android-sdk/platform-tools; echo /opt/android-sdk/cmdline-tools/latest/bin
  echo /usr/local/sbin; echo /usr/local/bin; echo /usr/sbin; echo /usr/bin; echo /sbin; echo /bin
} > "$R/.path"
chown runner:runner "$R/.env" "$R/.path"

if has store; then
  step store
  W=/tmp/warm; mkdir -p "$W"
  N=0; : > "$W/lock.b64"
  while v="$(md "attributes/lock-$N" 2>/dev/null)"; do printf '%s' "$v" >> "$W/lock.b64"; N=$((N + 1)); done
  if [ "$N" -gt 0 ]; then
    base64 -d "$W/lock.b64" | gunzip > "$W/pnpm-lock.yaml" || fail
    md attributes/pnpm-workspace > "$W/pnpm-workspace.yaml" 2>/dev/null || true
    printf '{"name":"warm","private":true,"packageManager":"pnpm@%s"}\n' "$PNPM_VER" > "$W/package.json"
    chown -R runner:runner "$W"
    sudo -u runner -H bash -c "cd $W && /usr/local/bin/pnpm fetch --reporter=append-only 2>&1 | tail -n 30; exit \${PIPESTATUS[0]}" || fail
    echo "::store $(sudo -u runner -H bash -c "cd /tmp && /usr/local/bin/pnpm store path") $(du -sh /home/runner/.local/share/pnpm 2>/dev/null | cut -f1) from $N chunk(s)"
    rm -rf "$W"
  else
    echo "::store skipped (no lock-0 metadata)"
  fi
fi

step cleanup
mkdir -p /opt/devcloud
cat > /opt/devcloud/image.json <<EOF
{"toolchain":"$TC","layers":"$LAYERS","node":"$NODE_VER","pnpm":"$PNPM_VER","runner":"$RUNNER_VER","bakedAt":"$(date -Is)"}
EOF
touch /opt/devcloud/baked
apt-get clean; rm -rf /var/lib/apt/lists/* /tmp/* /root/.npm /home/runner/.npm /home/runner/.cache/pip
journalctl --rotate >/dev/null 2>&1; journalctl --vacuum-time=1s >/dev/null 2>&1
cloud-init clean --logs >/dev/null 2>&1 || true
rm -f /var/log/devcloud-runner.log
echo "::image-setup done toolchain=$TC in $(( $(date +%s) - T0 ))s"
sync
shutdown -h now
