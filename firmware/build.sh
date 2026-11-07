#!/usr/bin/env bash
# Build Vatra firmware images into firmware-dist/<id>/.
#   bash firmware/build.sh                      # every firmware/images/*.yaml
#   bash firmware/build.sh vatra-button-c3 ...  # only these ids
#   VERSION=1.2.0 bash firmware/build.sh        # default 0.0.0-dev+<sha|date>
# Needs python3 (venv) and git; installs them with apt-get when run as root on
# Debian/Ubuntu and they are missing. Every image is attempted; the exit code
# is non-zero if any failed.
set -euo pipefail

ESPHOME_VERSION=2026.10.2
FW="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$FW")"
DIST="$ROOT/firmware-dist"
VENV="${VATRA_VENV:-$FW/.venv}"

need_apt=()
command -v python3 >/dev/null 2>&1 || need_apt+=(python3)
python3 -c 'import venv, ensurepip' >/dev/null 2>&1 || need_apt+=(python3-venv)
command -v git >/dev/null 2>&1 || need_apt+=(git)
if [ "${#need_apt[@]}" -gt 0 ]; then
  if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "${need_apt[@]}" >/dev/null
  else
    echo "missing: ${need_apt[*]} (install them, or run as root on Debian/Ubuntu)" >&2
    exit 2
  fi
fi

if [ -z "${VERSION:-}" ]; then
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  VERSION="0.0.0-dev+${sha:-$(date -u +%Y%m%d%H%M)}"
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "VERSION '$VERSION' is not semver" >&2
  exit 2
fi

if [ ! -x "$VENV/bin/esphome" ] || [ "$("$VENV/bin/esphome" version 2>/dev/null | awk '{print $NF}')" != "$ESPHOME_VERSION" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q "esphome==$ESPHOME_VERSION"
fi
ESPHOME="$VENV/bin/esphome"
echo "esphome $("$ESPHOME" version | awk '{print $NF}') · version $VERSION"

if [ "$#" -gt 0 ]; then
  ids=("$@")
else
  ids=()
  for f in "$FW"/images/*.yaml; do ids+=("$(basename "$f" .yaml)"); done
fi

mkdir -p "$DIST"
declare -a rows=()
failed=0
for id in "${ids[@]}"; do
  yaml="$FW/images/$id.yaml"
  if [ ! -f "$yaml" ]; then
    echo "::error unknown image $id" >&2
    rows+=("$id|missing|-|-|-"); failed=1; continue
  fi
  echo "::group::$id"
  t0=$(date +%s)
  # ninja redraws its progress with bare \r: one endless "line" that breaks
  # line-based log collectors (the GCE startup-script runner died on it).
  set +e
  "$ESPHOME" -s version "$VERSION" compile "$yaml" 2>&1 | stdbuf -oL tr '\r' '\n'
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -eq 0 ]; then
    secs=$(( $(date +%s) - t0 ))
    # build_path in vatra-base.yaml resolves under firmware/images/.esphome/
    build="$FW/images/.esphome/build/$id"
    factory="$(find "$build" -name firmware.factory.bin -print -quit 2>/dev/null || true)"
    if [ -z "$factory" ]; then
      echo "::error $id: no firmware.factory.bin under $build" >&2
      rows+=("$id|no-bin|$secs|-|-"); failed=1; echo "::endgroup::"; continue
    fi
    bindir="$(dirname "$factory")"
    ota="$bindir/firmware.ota.bin"
    [ -f "$ota" ] || ota="$bindir/firmware.bin"
    out="$DIST/$id"
    rm -rf "$out"; mkdir -p "$out"
    cp "$factory" "$out/$id-$VERSION.factory.bin"
    cp "$ota" "$out/$id-$VERSION.ota.bin"
    python3 "$FW/manifest.py" --image "$yaml" --dir "$out" --version "$VERSION"
    rows+=("$id|ok|$secs|$(stat -c %s "$out/$id-$VERSION.factory.bin")|$(stat -c %s "$out/$id-$VERSION.ota.bin")")
  else
    secs=$(( $(date +%s) - t0 ))
    echo "::error $id: compile failed after ${secs}s" >&2
    rows+=("$id|FAILED|$secs|-|-"); failed=1
  fi
  echo "::endgroup::"
done

if compgen -G "$DIST/*/manifest.json" >/dev/null; then
  python3 "$FW/manifest.py" --index "$DIST"
fi

echo
printf '%-22s %-7s %8s %12s %12s\n' image result seconds factory_B ota_B
for r in "${rows[@]}"; do
  IFS='|' read -r a b c d e <<<"$r"
  printf '%-22s %-7s %8s %12s %12s\n' "$a" "$b" "$c" "$d" "$e"
done
exit "$failed"
