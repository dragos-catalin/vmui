# Vatra Cloud services (`cloud/`)

Go module `vatra.cloud` (Go 1.24, standard library only) implementing
[docs/product/cloud/CONTRACT.md](../docs/product/cloud/CONTRACT.md). The hub side lives in
`src/lib/cloud/`.

| Binary                      | Where                                          | What                                                                            |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `cmd/push` → `vatra-push`   | Cloud Run (min 1, max 1: limits are in memory) | push handles, APNs / FCM send, relay-token issuer                               |
| `cmd/acme` → `vatra-acme`   | Cloud Run                                      | ACME DNS-01 proxy to Brivio for `_acme-challenge.<hubId>.<domain>`              |
| `cmd/relay` → `vatra-relay` | e2-micro VM (Debian 12, systemd)               | SNI relay: `:443` passthrough, `:8443` hub control/data, `127.0.0.1:9090` admin |

Shared packages: `internal/hubauth` (hub id + hub JWT verifier, jti replay cache, allow/deny lists),
`internal/relaytoken` (`rt1.` tokens), `internal/httpx` (JSON, `*_FILE` env, fixed-window limits),
`internal/relaytest` (Go hub client used by the relay integration tests).

```powershell
cd cloud; go vet ./...; go test ./... -count=1
$env:GOOS='linux'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'; go build -o vatra-relay ./cmd/relay; Remove-Item Env:GOOS,Env:GOARCH,Env:CGO_ENABLED
```

## Environment

Every service: `VATRA_CLOUD_DOMAIN` (default `vatra.dragoscatalin.ro`), `VATRA_CLOUD_DENY_HUBS`.
`VATRA_CLOUD_ALLOW_HUBS` gates ACME and relay tokens only (empty = everyone, `*` = everyone).
Variables marked _file_ may instead be given as `<NAME>_FILE` (path to a mounted secret).

### vatra-push

| Variable                                                                | Notes                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `PORT`                                                                  | default 8080                                                                 |
| `VATRA_PUSH_HANDLE_KEY` _file_                                          | 32 bytes, base64 (std or url). Missing → handles/push answer 503             |
| `APNS_KEY` _file_                                                       | `.p8` PEM text; with `APNS_KEY_ID` _file_, `APNS_TEAM_ID` _file_             |
| `APNS_TOPIC`                                                            | default `ro.vatra.app`                                                       |
| `FCM_SERVICE_ACCOUNT_JSON` _file_                                       | service account JSON with `firebase.messaging` rights                        |
| `VATRA_CLOUD_SIGNING_KEY` _file_                                        | Ed25519 PKCS8 PEM; signs relay tokens                                        |
| `VATRA_CLOUD_RELAY`                                                     | returned to hubs; default `relay.<domain>:8443`                              |
| `VATRA_CLOUD_RELAY_PIN`                                                 | relay SPKI pin, printed by `vatra-relay` at start / `GET 127.0.0.1:9090/pin` |
| `VATRA_CLOUD_ALLOW_HUBS`, `VATRA_CLOUD_DENY_HUBS`, `VATRA_CLOUD_DOMAIN` | see above                                                                    |

### vatra-acme

`PORT`, `BRIVIO_ACME_URL` (default `https://brivio.ro/api/dns/acme`), `BRIVIO_ACME_TOKEN` _file_
(the `brv_dns_` token, never logged), `VATRA_CLOUD_DOMAIN`, `VATRA_CLOUD_ALLOW_HUBS`,
`VATRA_CLOUD_DENY_HUBS`.

### vatra-relay

Flags override env: `-listen` / `VATRA_RELAY_LISTEN` (`:443`), `-control` / `VATRA_RELAY_CONTROL`
(`:8443`), `-admin` / `VATRA_RELAY_ADMIN` (`127.0.0.1:9090`), `-domain` / `VATRA_CLOUD_DOMAIN`,
`-state` / `VATRA_RELAY_STATE_DIR` (`/var/lib/vatra-relay`). `VATRA_CLOUD_SIGNING_PUB` (base64url
raw 32 bytes, or PEM SPKI) or `VATRA_CLOUD_SIGNING_PUB_FILE`, `VATRA_RELAY_ADMIN_TOKEN`,
`VATRA_CLOUD_DENY_HUBS`. The control TLS key is generated once in the state dir; deleting it changes
the pin every hub trusts.

## Secrets (Secret Manager)

| Secret                    | Consumer → variable                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `vatra-acme-dns-token`    | vatra-acme → `BRIVIO_ACME_TOKEN`                                                          |
| `vatra-cloud-signing-key` | vatra-push → `VATRA_CLOUD_SIGNING_KEY`; its public half → relay `VATRA_CLOUD_SIGNING_PUB` |
| `vatra-push-handle-key`   | vatra-push → `VATRA_PUSH_HANDLE_KEY`                                                      |
| `apns-auth-key-p8`        | vatra-push → `APNS_KEY`                                                                   |
| `apns-key-id`             | vatra-push → `APNS_KEY_ID`                                                                |
| `apple-team-id`           | vatra-push → `APNS_TEAM_ID`                                                               |
| `vatra-relay-admin-token` | relay VM `/etc/vatra-relay.env` → `VATRA_RELAY_ADMIN_TOKEN`                               |

FCM uses a service account JSON (`FCM_SERVICE_ACCOUNT_JSON`), mounted from its own secret.

## Deploy outline (nothing here deploys by itself)

1. Keys: `openssl genpkey -algorithm ed25519 -out signing.pem` → secret `vatra-cloud-signing-key`;
   public half as base64url raw for the relay. `openssl rand -base64 32` → `vatra-push-handle-key`.
2. Relay VM: build linux/amd64, copy `vatra-relay` + `relay/vatra-relay.service` + `relay/install.sh`,
   `sudo ./install.sh`, fill `/etc/vatra-relay.env`, re-run; it prints `VATRA_CLOUD_RELAY_PIN`.
   Firewall: 443 and 8443 open, 9090 stays on loopback.
3. Cloud Run, from a clean tree (`deploy-clean.ps1`): build `Dockerfile.push` / `Dockerfile.acme`
   with context `cloud/`, deploy with the secrets above as env vars; vatra-push with
   `--min-instances 1 --max-instances 1` (in-memory limits and jti cache).
4. DNS: `push.<domain>`, `acme.<domain>` → Cloud Run domain mappings; `relay.<domain>` and
   `*.<domain>` → relay VM static IP.
5. Verify: `GET /health` on both services, `curl 127.0.0.1:9090/health` on the VM, then a hub enrol
   end to end.
