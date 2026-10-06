#!/usr/bin/env bash
# lego `--dns exec` hook -> Brivio ACME DNS-01 endpoint (DOMAINS_DNS_PLATFORM DD-62).
#   lego calls: <hook> present|cleanup <fqdn.> <value>
# The token (brv_dns_..., scoped to ONE zone and ONLY _acme-challenge* TXT)
# is read from BRIVIO_ACME_TOKEN_FILE (default /srv/homepi/publish/brivio-acme.token).
# Never printed. Brivio NOTIFYs ns2 on every change; lego then waits until the
# authoritative nameservers serve the record before asking the CA to validate.
set -euo pipefail
ACTION="${1:?action}"; FQDN="${2:?fqdn}"; VALUE="${3:-}"
case "$ACTION" in present | cleanup) ;; *) exit 0 ;; esac # timeout etc.
URL="${BRIVIO_ACME_URL:-https://brivio.ro/api/dns/acme}"
TOKEN_FILE="${BRIVIO_ACME_TOKEN_FILE:-/srv/homepi/publish/brivio-acme.token}"
TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"
BODY=$(printf '{"fqdn":"%s","value":"%s","action":"%s"}' "$FQDN" "$VALUE" "$ACTION")
CODE=$(curl -sS -o /tmp/brivio-acme.out -w '%{http_code}' -m 30 -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data "$BODY")
if [ "$CODE" != "200" ]; then
  echo "brivio acme $ACTION $FQDN -> HTTP $CODE $(head -c 300 /tmp/brivio-acme.out)" >&2
  exit 1
fi
echo "brivio acme $ACTION $FQDN ok"
