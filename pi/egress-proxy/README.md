# homepi egress proxy (Romanian residential IP)

A shared HTTP/HTTPS forward proxy on `homepi` for apps whose crawlers need a
Romanian source IP (first client: MarcAI ingest, PLAN.md D29 in `E:\gh\marcai`).

- **Software**: 3proxy (official image `3proxy/3proxy`, pinned by multi-arch
  index digest in `compose.yaml`; the Pi pulls the arm64 variant).
- **Listens**: `127.0.0.1:3128` and the Tailscale address `100.82.141.110:3128`
  only. Never `0.0.0.0`, never the LAN `192.168.100.232`. Host networking so
  3proxy binds the Tailscale address itself; `net.ipv4.ip_nonlocal_bind=1`
  (`/etc/sysctl.d/90-egress-proxy.conf`) lets it bind before `tailscaled` is up.
- **Auth**: Basic auth per app (`auth strong`). Unknown/missing credentials →
  `407`. Allowed user, host not in its allowlist (or port ≠ 443) → `403`.
  Only `CONNECT` (HTTPS tunnel) is allowed; plain-HTTP proxying is refused.
- **Limits**: `connlim 32 0 <user>` = 32 parallel connections per app;
  `maxconn 256` per listener; connect timeout 15 s, idle tunnel 10 min.
- **Logs**: one line per connection on stdout →
  `docker logs egress-proxy` (json-file, 10 MB × 3):
  `user=marcai client=100.x dst=api.efortuna.ro:443 err=00000 out=721 in=71154 ms=212`.
  No request bodies or URLs (inside the TLS tunnel the proxy sees host:port only).
- **Secrets**: `E:\gh\vmui\.private\egress-proxy.env` (gitignored), one line per
  app: `EGRESS_PASS_<APP>=<32 chars>`. The deploy script pipes it to
  `gen-passwd.sh` on the Pi, which writes MD5-crypt hashes to
  `/srv/homepi/egress-proxy/passwd` (root:nogroup 640). Cleartext never lands
  on the Pi's disk.

## Deploy

```powershell
pwsh -File scripts\pi-egress-proxy.ps1          # sync cfg + passwd, docker compose up -d
```

3proxy `monitor`s `3proxy.cfg` and `passwd`, but a NEW user in `passwd` was
still refused with 407 a minute after the deploy (2026-10-02, adding `brivio`);
`docker compose restart egress-proxy` fixed it at once. After `-NewApp`,
restart. Does not touch vmui (that is `pi-deploy.ps1`).

## Add an app

1. `pwsh -File scripts\pi-egress-proxy.ps1 -NewApp <app>` — generates a random
   32-char password into `.private\egress-proxy.env` (prints only its length)
   and deploys. User name = `<app>` lowercase.
2. Add one block to `3proxy.cfg` **above** `deny *`, then rerun the script:

   ```
   # ---- app: <app> ----
   connlim 32 0 <app>
   allow <app> * host1.ro,*.host2.ro 443 HTTP_CONNECT
   # ---- end app: <app> ----
   ```

3. The client uses `HTTPS_PROXY=http://<app>:<password>@100.82.141.110:3128`
   (or `homepi.taild1532d.ts.net:3128`) and must be on the tailnet.

## Current allowlist

| user     | hosts (443, CONNECT only)                                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marcai` | `api.efortuna.ro` (S08), `api.casapariurilor.ro` (S09), `superbet.ro` + `*.superbet.ro`, `production-superbet-offer-ro.freetls.fastly.net` (S07), `eu-offering-api.kambicdn.com` (S10 Unibet/Kambi), `sportsbook-sm-distribution-api.nsoft.com` (S12 Stanleybet) |
| `brivio` | `gov.ro`, `www.gov.ro` (news ingest RSS; gov.ro times out from GCP default egress, Cloud NAT and Cloudflare Workers — measured 2026-10-02). Client: Brivio worker on Cloud Run, tailnet tag `tag:brivio-egress`, `connlim 4`.                                    |

## Tailscale ACL (owner action)

Today homepi is an untagged node owned by the tailnet owner, and
`infra/tailscale-home-acl.hujson` grants `autogroup:member → autogroup:self`
on all ports — so every one of the owner's devices can reach `:3128`, and
nothing else can. When a non-owner node (e.g. a MarcAI ingest runner joined
with an auth key) needs the proxy, add to `infra/tailscale-home-acl.hujson`
and apply with `scripts\tailscale-home.ps1 -ApplyAcl` (the file is the source
of truth; console-only edits get reverted):

```hujson
"tagOwners": { "tag:marcai-ingest": ["autogroup:admin"] },
"hosts":     { "homepi": "100.82.141.110" },
"grants": [
  // ingest runners reach the egress proxy and nothing else
  {"src": ["tag:marcai-ingest"], "dst": ["homepi"], "ip": ["tcp:3128"]},
],
"tests": [
  {"src": "tag:marcai-ingest", "accept": ["homepi:3128"], "deny": ["homepi:22", "homepi:3737"]},
],
```

## Footprint

`3proxy` RSS ≈ 5 MB, 3 threads, CPU ≈ 0 % idle (2026-10-02). `mem_limit: 64m`
is declared but **not enforced**: the Raspberry Pi OS kernel boots with
`cgroup_disable=memory` (Docker warns `No memory limit support`, `docker stats`
shows `0B / 0B`). Enabling it needs `cgroup_enable=memory` in
`/boot/firmware/cmdline.txt` + a reboot of the whole house stack.
