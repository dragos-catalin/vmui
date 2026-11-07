# Vatra Cloud wire contract (P10, 2026-11-07)

Implements the "Decisions for P10" in [../PLAN.md](../PLAN.md). Every piece (Go services in `cloud/`,
hub in `src/lib/cloud/`, Android, iOS) follows this file; change it here first.

## Names and config

| Value                   | Default                  | Where                                                      |
| ----------------------- | ------------------------ | ---------------------------------------------------------- |
| `VATRA_CLOUD_DOMAIN`    | `vatra.dragoscatalin.ro` | hub + every service. Hub public name = `<hubId>.<domain>`  |
| `VATRA_CLOUD_API`       | `https://push.<domain>`  | hub: push relay + relay-token issuer                       |
| `VATRA_CLOUD_ACME`      | `https://acme.<domain>`  | hub: ACME DNS-01 proxy                                     |
| `VATRA_CLOUD_RELAY`     | `relay.<domain>:8443`    | hub: SNI relay control channel                             |
| `VATRA_CLOUD_RELAY_PIN` | (set by the service)     | sha256 of the relay's TLS SPKI, base64url; the hub pins it |

Until DNS names exist the services also answer on their `*.run.app` / static IP; the hub only needs the
four values above (all overridable by env or the encrypted integrations store).

## Hub identity (self-certifying)

- Each hub has one Ed25519 key pair, generated on first use, stored encrypted (master key) in
  `app_settings` key `cloud.identity`.
- `pub` = raw 32-byte public key, base64url (no padding).
- `hubId` = lowercase RFC 4648 base32 (no padding) of the first 10 bytes of `sha256(raw pub)` → 16
  chars `[a-z2-7]`, a valid DNS label. Services recompute it from `pub`; no registry is needed.

## Hub JWT (hub → any service)

`Authorization: Bearer <jwt>`, compact JWS:

- header `{"alg":"EdDSA","typ":"JWT"}`
- claims `{"iss":hubId,"aud":<audience>,"iat":s,"exp":s,"jti":<16+ url-safe chars>,"pub":<b64url pub>}`
- audiences: `vatra-push`, `vatra-acme`, `vatra-relay-token`
- verifier rules: signature valid under `pub`; `iss == hubId(pub)`; `aud` matches; `exp - iat <= 300`;
  `now` within `[iat - 60, exp]`; `jti` not seen in the last 10 min (in-memory cache); hub not in
  `VATRA_CLOUD_DENY_HUBS`; for ACME and relay tokens also in `VATRA_CLOUD_ALLOW_HUBS` while that list
  is non-empty (beta allow-list; `*` = everyone).
- errors: `401 {"error":"unauthorized"}`, `403 {"error":"not_allowed"}` (allow/deny list).

## ACME DNS-01 proxy (`vatra-acme`, Cloud Run)

lego `httpreq` compatible bodies, hub JWT instead of basic auth:

- `POST /present` and `POST /cleanup`, body `{"fqdn":"_acme-challenge.<hubId>.<domain>.","value":"..."}`
- allowed fqdn is EXACTLY `_acme-challenge.<hubId-of-caller>.<domain>` (trailing dot optional,
  case-insensitive). Anything else → `403 {"error":"forbidden_name"}`.
- forwards to Brivio `POST https://brivio.ro/api/dns/acme {fqdn, value, action}` with the only
  `brv_dns_` token (secret `vatra-acme-dns-token`, zone `dragoscatalin.ro`, TXT `_acme-challenge*`).
- 10 calls / hub / hour. `200 {"ok":true}`; upstream failure → `502 {"error":"dns_failed"}`.
- `GET /health` → `200 {"ok":true,"configured":bool}`.

The hub keeps its own ACME account key and certificate key (Let's Encrypt production; staging when
`VATRA_ACME_STAGING=1`), asks for `<hubId>.<domain>`, renews from ARI's `suggestedWindow` (fallback:
30 days before expiry). Cert + key stored in the data dir `cloud/` (0600).

## Relay token (`vatra-push` service)

- `POST /v1/relay/token` with hub JWT `aud=vatra-relay-token` → `200 {"token":"rt1.<payload>.<sig>","exp":s,"relay":"host:port","pin":"<b64url>","host":"<hubId>.<domain>"}`.
- `payload` = b64url(JSON `{"hub":hubId,"exp":s,"iat":s}`), `sig` = b64url Ed25519 over the ASCII
  string `rt1.<payload>` with the cloud signing key (secret `vatra-cloud-signing-key`, PKCS8 PEM). 24 h.

## SNI relay (`vatra-relay`, Go on the e2-micro VM)

- `:443` public: read the ClientHello (≤ 16 KB, 5 s), parse SNI. `<hubId>.<domain>` with a connected
  hub → ask that hub for a data connection, write a PROXY protocol v2 header (TCP4/TCP6, client →
  relay addresses) followed by the buffered ClientHello bytes, then splice. No hub / bad SNI → close.
- `:8443` hub side, TLS with the relay's own key (self-signed; hubs pin its SPKI sha256).
  First line from the hub, newline-terminated JSON:
  - control: `{"t":"hello","token":"rt1..."}` → relay answers `{"t":"ok","hub":..,"exp":..}` or
    `{"t":"err","error":..}` and closes. While open the relay sends `{"t":"dial","id":"<24 hex>"}` per
    client and `{"t":"ping"}` every 25 s (hub answers `{"t":"pong"}`; 75 s silence = dead). A newer
    control connection for the same hub replaces the old one.
  - data: `{"t":"data","id":"<24 hex>"}` → relay pairs it with the waiting client (10 s timeout) and
    from then on the stream is raw bytes (PROXY v2 header + client TLS).
- limits per hub: 64 concurrent client connections, 20 new/s, 1 control connection; token expiry closes
  the control channel. Kill switch: `VATRA_CLOUD_DENY_HUBS` + `POST /admin/kill {"hub":..}` on
  `127.0.0.1:9090` with `x-admin-token`.
- Health: `GET 127.0.0.1:9090/health` → `{"ok":true,"hubs":n,"conns":n}`; external checks use TCP 443.

Hub side: Node `tls` client to the relay with the pin; on `dial` it opens a data connection, strips
the PROXY v2 header (client IP), feeds the rest into a local `tls.Server` holding the ACME cert, and
proxies HTTP to `127.0.0.1:$PORT` with `x-forwarded-for: <client ip>` (overwritten, never appended)
and `x-forwarded-proto: https`.

## Push relay (`vatra-push`, Cloud Run, min-instances 1, max 1)

### Push handles (registered by the app, stored nowhere)

`POST /v1/handles` (no auth; 30/IP/hour) body
`{"platform":"apns"|"apns-sandbox"|"fcm","token":"...","hub":"<hubId>"}` → `200 {"handle":"h1...."}`.
`handle` = `h1.` + b64url(12-byte nonce ‖ AES-256-GCM(handleKey, JSON `{"p":platform,"t":token,"h":hubId}`, aad `vatra-handle-v1`)).
`handleKey` = secret `vatra-push-handle-key` (32 bytes base64). The hub stores the handle; the relay
decrypts it per send and refuses a handle whose `h` ≠ the calling hub (`403 {"error":"wrong_hub"}`).

### Send

`POST /v1/push` hub JWT `aud=vatra-push`, body:

```json
{ "handle": "h1...", "type": "alert" | "background" | "liveactivity",
  "priority": "high" | "normal", "critical": false, "collapse": "tag-or-id", "ttl": 3600,
  "kind": "intercom", "data": { "v": "1", "id": "<card id>", "e": "<b64url>", "full": "1" | "0", "type": "card" | "dismiss" },
  "activity": { "event": "start", "attributesType": "IntercomAttributes", "attributes": {"cardId":".."}, "state": {"ringing":true,"since":0,"e":"<b64url>"} } }
```

- `data` values are strings, total ≤ 3.5 KB; `kind` ∈ `[a-z_]{1,24}`.
- APNs alert: `aps.alert = {"title-loc-key":"VATRA_PUSH_TITLE_<KIND upper>","loc-key":"VATRA_PUSH_BODY"}`,
  `mutable-content:1`, `category: vatra.<kind>`, `thread-id: collapse`, `interruption-level`
  time-sensitive for high (critical bucket only `critical:true`), `sound: default` for high;
  `vatra` = `data`. Background: `aps.content-available:1`, priority 5. Liveactivity: topic
  `<bundle>.push-type.liveactivity`, `aps.event`, `attributes-type`, `attributes`, `content-state`
  = `activity.state`, `alert` with the same loc keys, stale +120 s, dismissal +300 s.
  Topic `APNS_TOPIC` (default `ro.vatra.app`), key from secrets `apns-auth-key-p8`, `apns-key-id`,
  `apple-team-id`.
- FCM: HTTP v1 data-only `message.data = data + {"kind":kind}`, android priority high/normal, ttl.
- result: `200 {"status":200}`; token gone (APNs 410 / BadDeviceToken / Unregistered, FCM
  UNREGISTERED/404) → `200 {"status":410,"gone":true}`; platform not configured →
  `503 {"error":"not_configured","platform":"fcm"}`; limits → `429 {"error":"rate_limited","retryAfter":s}`.
- limits (UTC day, in memory): 500 / handle, 3000 / hub, separate 200 / hub for `critical:true`.

### End-to-end encryption (hub ↔ app)

- Per device 32-byte AES-256-GCM key, generated by the hub when the app registers push kind `relay`
  and returned ONCE in that response (`e2eKey`, base64url). Stored on the hub encrypted with the
  master key (`paired_devices.push_key`). Re-registering rotates it.
- `e` = b64url(12-byte random nonce ‖ ciphertext ‖ 16-byte tag), AES-256-GCM, aad = UTF-8 card id.
- plaintext = the same JSON as UnifiedPush `upPayload(card)`; when that is > 2800 bytes the plaintext
  is the minimal `{type,id,kind,tag,priority,at,fetch:"1"}` and `full:"0"` → the app calls
  `GET /api/v1/app/push/card?id=<id>` on its hub (member auth, same card visibility as notify).
- The relay, Apple and Google see: platform token, hub id, card id, kind, priority, timing.

### Hub ↔ app registration

- `GET /api/v1/app/push` adds `relay: {"url": VATRA_CLOUD_API, "hub": hubId} | null` (null when the
  owner has not enabled Vatra Cloud push).
- `PUT /api/v1/app/push` adds `{"kind":"relay","platform":"apns"|"apns-sandbox"|"fcm","handle":"h1...","activityHandle":"h1..."|null}`
  → `200 {"ok":true,"e2eKey":"<b64url 32 bytes>"}`.
- Apps prefer `relay` when present; direct FCM / APNs / UnifiedPush stay for hubs without Vatra Cloud.

## Demo hub (`vatra-demo`, Cloud Run)

Hub image with `VATRA_DEMO=1`: in-process simulated Home Assistant (no HA_URL), reviewer account
`review@vatra.dragoscatalin.ro` without 2FA (password in secret `vatra-demo-review-password`), fresh
seeded SQLite in `/tmp` at every cold start and at 03:00 UTC, static pairing invite
`VATRA_DEMO_INVITE` (vatra://pair link published in store notes), destructive operations (backup
restore, master key rotation, family/account changes, firmware adoption, Vatra Cloud enrolment) refused
with `403 demo_readonly`.
