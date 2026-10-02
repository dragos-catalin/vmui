#!/bin/sh
# Reads EGRESS_PASS_<APP>=<password> lines on stdin, writes the 3proxy users
# include file (MD5-crypt hashes, user = lowercase <APP>). Cleartext never
# touches the Pi's disk.
set -eu
out="${1:?usage: gen-passwd.sh <passwd-file>}"
tmp="$out.tmp"
: > "$tmp"
while IFS='=' read -r key val; do
  case "$key" in EGRESS_PASS_*) ;; *) continue ;; esac
  val=$(printf '%s' "$val" | tr -d '\r"')
  [ -n "$val" ] || continue
  user=$(printf '%s' "${key#EGRESS_PASS_}" | tr 'A-Z' 'a-z')
  hash=$(printf '%s' "$val" | openssl passwd -1 -stdin)
  printf '"%s:CR:%s"\n' "$user" "$hash" >> "$tmp"
done
[ -s "$tmp" ] || { echo "no EGRESS_PASS_* lines" >&2; rm -f "$tmp"; exit 1; }
chmod 640 "$tmp"
sudo chown root:65534 "$tmp"
# in place (same inode): the container bind-mounts this file
sudo sh -c 'cat "$1" > "$2"' _ "$tmp" "$out"
sudo chown root:65534 "$out"; sudo chmod 640 "$out"; sudo rm -f "$tmp"
echo "users: $(sudo cat "$out" | wc -l)"
