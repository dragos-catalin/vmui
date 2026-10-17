#!/usr/bin/env bash
# vmui — load local guest credentials for the bash scripts.
#
# Credentials used to live as plaintext literals in ~24 tracked files. This
# repo is PUBLIC, so they now live in .private/credentials.env, which is
# gitignored. Source this file instead of hardcoding a password.
#
#   source "$(dirname "$0")/lib/guest-credentials.sh"
#   sshpass -p "$MAC_GUEST_PASS" ssh ... "$MAC_GUEST_USER@127.0.0.1"
#
# Precedence: an already-exported env var always wins, so CI or a one-off
# `MAC_GUEST_PASS=... ./script.sh` overrides the file without editing it.
#
# Exports: MAC_GUEST_USER/PASS, WIN_GUEST_USER/PASS, UBUNTU_GUEST_USER/PASS,
#          MAC_VNC_PASS

# Resolve the repo root from this file's location, so it works whether the
# script was launched from the repo, from ~/OSX-KVM, or from /tmp.
_gc_self="${BASH_SOURCE[0]:-$0}"
_gc_dir="$(cd "$(dirname "$_gc_self")" 2>/dev/null && pwd)"
_gc_root="$(cd "$_gc_dir/../.." 2>/dev/null && pwd)"

for _gc_candidate in \
  "${VMUI_CREDENTIALS_FILE:-}" \
  "$_gc_root/.private/credentials.env" \
  "/mnt/e/gh/vmui/.private/credentials.env" \
  "$HOME/.vmui/credentials.env"
do
  [ -n "$_gc_candidate" ] || continue
  if [ -f "$_gc_candidate" ]; then
    # Only assign vars that are not already set in the environment.
    while IFS='=' read -r _gc_k _gc_v; do
      # The file is edited on Windows and is usually CRLF; a trailing CR breaks
      # `export` ("invalid variable name") and would end up inside the password.
      _gc_k="${_gc_k%$'\r'}"
      _gc_v="${_gc_v%$'\r'}"
      case "$_gc_k" in ''|\#*) continue ;; esac
      _gc_k="${_gc_k// /}"
      [ -n "${!_gc_k:-}" ] && continue
      export "$_gc_k=$_gc_v"
    done < "$_gc_candidate"
    break
  fi
done
unset _gc_self _gc_dir _gc_root _gc_candidate _gc_k _gc_v

# Fall back to the historical defaults so a fresh clone still runs against a
# stock guest. Override by creating .private/credentials.env.
: "${MAC_GUEST_USER:=dragos}"
: "${WIN_GUEST_USER:=dragos}"
: "${UBUNTU_GUEST_USER:=dragos}"

if [ -z "${MAC_GUEST_PASS:-}" ] || [ -z "${WIN_GUEST_PASS:-}" ] || [ -z "${UBUNTU_GUEST_PASS:-}" ]; then
  echo "ERROR: guest credentials not found." >&2
  echo "  Create .private/credentials.env (see .private/README.md), or export" >&2
  echo "  MAC_GUEST_PASS / WIN_GUEST_PASS / UBUNTU_GUEST_PASS before running." >&2
  return 1 2>/dev/null || exit 1
fi

: "${MAC_VNC_PASS:=${MAC_GUEST_PASS:0:8}}"
