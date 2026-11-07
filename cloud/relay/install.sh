#!/usr/bin/env bash
# Idempotent install of vatra-relay on Debian 12. Run as root from a directory holding:
#   vatra-relay            (linux/amd64 binary: GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/relay)
#   vatra-relay.service
# Re-running upgrades the binary and unit and restarts the service; /etc/vatra-relay.env and the
# state dir (control TLS key = the pin hubs trust) are never overwritten.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -x "$here/vatra-relay" ] || [ -f "$here/vatra-relay" ] || { echo "missing $here/vatra-relay" >&2; exit 1; }

if ! id vatra-relay >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/vatra-relay --shell /usr/sbin/nologin vatra-relay
fi

install -m 0755 "$here/vatra-relay" /usr/local/bin/vatra-relay.new
mv -f /usr/local/bin/vatra-relay.new /usr/local/bin/vatra-relay
install -m 0644 "$here/vatra-relay.service" /etc/systemd/system/vatra-relay.service
install -d -m 0700 -o vatra-relay -g vatra-relay /var/lib/vatra-relay

if [ ! -f /etc/vatra-relay.env ]; then
  umask 077
  cat > /etc/vatra-relay.env <<'EOF'
# vatra-relay environment (root:root 0600). Fill in, then: systemctl restart vatra-relay
VATRA_CLOUD_DOMAIN=vatra.dragoscatalin.ro
# base64url raw 32-byte Ed25519 public key of secret vatra-cloud-signing-key
VATRA_CLOUD_SIGNING_PUB=
# secret vatra-relay-admin-token (POST 127.0.0.1:9090/admin/kill)
VATRA_RELAY_ADMIN_TOKEN=
# comma list of hub ids refused at hello and on new client connections
VATRA_CLOUD_DENY_HUBS=
EOF
  chmod 0600 /etc/vatra-relay.env
  echo "created /etc/vatra-relay.env - set VATRA_CLOUD_SIGNING_PUB before starting" >&2
fi

systemctl daemon-reload
systemctl enable vatra-relay.service >/dev/null
if grep -Eq '^VATRA_CLOUD_SIGNING_PUB=.+' /etc/vatra-relay.env; then
  systemctl restart vatra-relay.service
  for _ in $(seq 1 20); do
    if pin="$(curl -fsS http://127.0.0.1:9090/pin 2>/dev/null)"; then
      echo "VATRA_CLOUD_RELAY_PIN=$pin"
      exit 0
    fi
    sleep 0.5
  done
  echo "vatra-relay did not answer on 127.0.0.1:9090; see: journalctl -u vatra-relay" >&2
  exit 1
else
  echo "vatra-relay installed but not started (VATRA_CLOUD_SIGNING_PUB empty)" >&2
fi
