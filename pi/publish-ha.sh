#!/usr/bin/env bash
# Serve Home Assistant at https://home.dragoscatalin.ro from the Pi.
#   Caddy :443 (LAN IP) -> HA :80. Certificate: Let's Encrypt via lego, DNS-01 through
#   Brivio (`--dns exec` -> /usr/local/bin/brivio-acme-hook -> POST brivio.ro/api/dns/acme
#   with a brv_dns_ token that may only write _acme-challenge* TXT in dragoscatalin.ro).
#   The A record points at the LAN IP so the Nest Hub (LAN only) can cast; the
#   Pi advertises 192.168.100.0/24 as a Tailscale subnet route so the phone
#   reaches the same name when away.
# Files staged by scripts/pi-publish-ha.ps1: /tmp/brivio-acme-hook.sh, /tmp/brivio-acme.token,
#   /tmp/caddy-wait-network.conf. Env: LE_EMAIL, DOMAIN (default home.dragoscatalin.ro),
#   LAN_IP (default 192.168.100.232), TS_AUTHKEY (optional)
set -euo pipefail
DOMAIN="${DOMAIN:-home.dragoscatalin.ro}"
LAN_IP="${LAN_IP:-192.168.100.232}"
: "${LE_EMAIL:?}"
STATE=/srv/homepi/publish
sudo mkdir -p "$STATE" && sudo chown "$USER" "$STATE"

# ---- tailscale (subnet router) ----
if ! tailscale status >/dev/null 2>&1 || tailscale status 2>&1 | grep -q "Logged out"; then
  echo "tailscale: joining"
  sudo tailscale up --hostname homepi --advertise-routes=192.168.100.0/24 --ssh ${TS_AUTHKEY:+--auth-key="$TS_AUTHKEY"}
else
  sudo tailscale set --advertise-routes=192.168.100.0/24 --hostname homepi || true
fi
echo 1 | sudo tee /proc/sys/net/ipv4/ip_forward >/dev/null
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-tailscale.conf >/dev/null

# ---- lego ----
if ! command -v lego >/dev/null; then
  V=$(curl -fsSL https://api.github.com/repos/go-acme/lego/releases/latest | grep -oE '"tag_name": *"v[^"]+"' | grep -oE 'v[0-9.]+')
  curl -fsSL "https://github.com/go-acme/lego/releases/download/${V}/lego_${V}_linux_arm64.tar.gz" | sudo tar -xz -C /usr/local/bin lego
fi
cd "$STATE"
if [ -f /tmp/brivio-acme-hook.sh ]; then sudo install -m755 /tmp/brivio-acme-hook.sh /usr/local/bin/brivio-acme-hook && rm -f /tmp/brivio-acme-hook.sh; fi
if [ -f /tmp/brivio-acme.token ]; then sudo install -m600 -o root -g root /tmp/brivio-acme.token "$STATE/brivio-acme.token" && rm -f /tmp/brivio-acme.token; fi
sudo test -s "$STATE/brivio-acme.token" || { echo "missing $STATE/brivio-acme.token" >&2; exit 1; }
# lego waits until BOTH Brivio authoritatives (ns1/ns2.fabricai.ro) serve the TXT.
LEGO_ARGS="run --accept-tos --email $LE_EMAIL --dns exec --dns.resolvers 80.97.27.170:53,80.97.27.78:53 -d $DOMAIN --renew-days 30"
LEGO_ENV="EXEC_PATH=/usr/local/bin/brivio-acme-hook EXEC_PROPAGATION_TIMEOUT=300 EXEC_POLLING_INTERVAL=5"
sudo env $LEGO_ENV lego $LEGO_ARGS --no-random-sleep 2>&1 | tail -3
sudo chown -R "$USER" "$STATE/.lego"
CRT="$STATE/.lego/certificates/$DOMAIN.crt"; KEY="$STATE/.lego/certificates/$DOMAIN.key"
test -f "$CRT"

# ---- caddy ----
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y caddy >/dev/null
fi
sudo cp "$CRT" /etc/caddy/ha.crt && sudo cp "$KEY" /etc/caddy/ha.key && sudo chown caddy:caddy /etc/caddy/ha.* && sudo chmod 600 /etc/caddy/ha.key
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
{
	auto_https off
	admin localhost:2019
}

https://$DOMAIN {
	bind $LAN_IP
	tls /etc/caddy/ha.crt /etc/caddy/ha.key
	encode zstd gzip
	reverse_proxy 127.0.0.1:80 {
		header_up X-Forwarded-Proto https
		header_up X-Real-IP {remote_host}
		flush_interval -1
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
	}
	log {
		output file /var/log/caddy/ha-access.log {
			roll_size 10mb
			roll_keep 3
		}
	}
}
EOF
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
# Caddy binds the LAN IP: wait for the network at boot and retry (it stayed down 2026-09-18..10-06).
if [ -f /tmp/caddy-wait-network.conf ]; then
	sudo mkdir -p /etc/systemd/system/caddy.service.d
	sudo install -m644 /tmp/caddy-wait-network.conf /etc/systemd/system/caddy.service.d/10-wait-network.conf && rm -f /tmp/caddy-wait-network.conf
	sudo systemctl daemon-reload
fi
sudo systemctl enable --now caddy >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

# ---- renewal: daily lego run + copy + reload ----
sudo tee /usr/local/bin/ha-cert-renew >/dev/null <<EOF
#!/usr/bin/env bash
set -e
cd $STATE
# lego exits 0 without touching the files when >30 days remain; compare mtimes.
before=\$(stat -c %Y '$CRT')
env $LEGO_ENV lego $LEGO_ARGS >>/var/log/ha-cert-renew.log 2>&1 || { echo "\$(date -Is) lego failed" >>/var/log/ha-cert-renew.log; exit 1; }
[ "\$(stat -c %Y '$CRT')" = "\$before" ] && exit 0
cp '$CRT' /etc/caddy/ha.crt; cp '$KEY' /etc/caddy/ha.key; chown caddy:caddy /etc/caddy/ha.*; chmod 600 /etc/caddy/ha.key
systemctl reload caddy
echo "\$(date -Is) renewed + caddy reloaded" >>/var/log/ha-cert-renew.log
EOF
sudo chmod 700 /usr/local/bin/ha-cert-renew
echo '30 4 * * * root /usr/local/bin/ha-cert-renew' | sudo tee /etc/cron.d/ha-cert-renew >/dev/null

# ---- HA: trust the proxy (needed or HA rejects X-Forwarded-For with 400) ----
CFG=/srv/homepi/ha/configuration.yaml
if ! grep -q "^http:" "$CFG"; then
  printf '\nhttp:\n  use_x_forwarded_for: true\n  trusted_proxies:\n    - 127.0.0.1\n    - ::1\n' | sudo tee -a "$CFG" >/dev/null
  echo "ha: http: block added (restart needed)"
fi
echo "done: https://$DOMAIN -> 127.0.0.1:80"
