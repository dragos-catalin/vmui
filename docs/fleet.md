# Dev fleet — every machine, how to reach it, what it is for

All machines are on the Tailscale tailnet `tail666d40.ts.net`. Credentials live in
`.private/credentials.env` (gitignored); only key NAMES appear here.

| Machine           | Kind                                                                                      | Reach from dragos-pc                                                                                              | User                                        | Used for                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `dragos-pc`       | physical host (Hyper-V, WSL)                                                              | —                                                                                                                 | `vladu`                                     | everything; hosts the VMs below                                                                                                            |
| `dragos-vivobook` | **physical laptop**, ASUS Vivobook 16 X1605ZA, i5-1235U, 16 GB, Win 11 Pro 26200, battery | `ssh dragos-vivobook` (key `~/.ssh/id_ed25519`, admin key in `C:\ProgramData\ssh\administrators_authorized_keys`) | `vladu` (same Windows account as dragos-pc) | **real-OS test machine for codai desktop**: installs, SmartScreen, sleep/wake (Modern Standby S0 + Hibernate), toasts, jump list, WebView2 |
| `dragos-dev`      | Hyper-V VM, Win 11 Pro                                                                    | PS Direct (`DRAGOS_DEV_USER`/`DRAGOS_DEV_PASS`), RDP/SSH over Tailscale only                                      | `dragos`                                    | personal workstation VM (`devfleet.ps1`)                                                                                                   |
| `mihai-dev`       | Hyper-V VM                                                                                | Tailscale                                                                                                         | `mihai`                                     | workstation for mihai (`FLEET_GUEST_*`)                                                                                                    |
| `brivio-dev`      | Hyper-V VM                                                                                | Tailscale                                                                                                         | —                                           | brivio project server                                                                                                                      |
| `homeassistant`   | Hyper-V appliance                                                                         | LAN/Tailscale                                                                                                     | —                                           | Home Assistant (`docs/home-assistant.md`)                                                                                                  |

## dragos-vivobook (added 2026-10-02)

- Prefer it over a VM whenever the test needs real hardware: Hyper-V guests expose no sleep
  states (`powercfg /a` in dragos-dev: none available), so sleep/wake can only be tested here.
- SSH: OpenSSH Server, port 22 allowed **only from 100.64.0.0/10** (rule `SSH-Tailscale-Only`).
  Default shell is `cmd.exe`; run PowerShell explicitly:
  `ssh dragos-vivobook "powershell -NoProfile -EncodedCommand <base64 UTF-16LE>"` (no PowerShell 7 installed).
- GUI work runs in the console session of `vladu` (session 1). SSH sessions are non-interactive:
  start GUI apps through a scheduled task with `-LogonType Interactive` for user `vladu`.
- AC standby timeout is 0 (set 2026-10-02) so it stays reachable on the charger; a sleep test
  is triggered explicitly and the laptop wakes on its own timer or by hand.
- Also reachable: RDP 3389, WinRM 5985 (WinRM needs TrustedHosts on the client; SSH is preferred).

## homepi Funnel — `/hooks/contact` only (added 2026-10-05)

`homepi` is on the **personal** tailnet `taild1532d.ts.net` (not the fleet one above). It is the
only node allowed to Funnel, and it publishes exactly one path:

```
https://homepi.taild1532d.ts.net/hooks/contact  ->  http://127.0.0.1:3737/api/hooks/contact  (vmui)
```

Everything else on that hostname answers 404 from tailscaled; HA, vmui `/`, ssh and 3128 are not
reachable from the internet. Caller: the dragoscatalin.ro contact server action (Vercel), see
`docs/home-assistant.md` → "Contact form → phone" for the signature scheme.

Policy (`infra/tailscale-home-acl.hujson`, apply with `scripts\tailscale-home.ps1 -ApplyAcl`):
`tagOwners."tag:funnel-hooks"`, `nodeAttrs: [{target: [tag:funnel-hooks], attr: [funnel]}]`, plus
member ↔ `tag:funnel-hooks` grants (a tagged node is no longer covered by `autogroup:self`).

Tag the node (API, no re-auth; OAuth client `TS_HOME_OAUTH_*`, tag owned by `tag:appliance`):

```powershell
# device id: (Invoke-Ts '/tailnet/-/devices').devices | ? name -like 'homepi.*' | % id
Invoke-Ts "/device/<id>/tags" -Method POST -Body @{ tags = @('tag:funnel-hooks') }
```

On the Pi (port 443; `--set-path` strips the mount and appends the rest to the target path):

```bash
sudo tailscale funnel --bg --set-path /hooks/contact http://127.0.0.1:3737/api/hooks/contact
sudo tailscale funnel status          # must list ONE mount: /hooks/contact (Funnel on)
# undo: sudo tailscale funnel --https=443 --set-path /hooks/contact off   (or: tailscale funnel reset)
```

Verify from OUTSIDE the tailnet (a tailnet client resolves the name to 100.x even with
`Resolve-DnsName -Server 1.1.1.1` — tailscaled intercepts DNS — so fetch the public Funnel
ingress IPs over DoH and pin one):

```powershell
$ip = (Invoke-RestMethod 'https://dns.google/resolve?name=homepi.taild1532d.ts.net&type=A').Answer[0].data   # 185.40.234.x
curl.exe -s -o NUL -w '%{http_code}' --resolve "homepi.taild1532d.ts.net:443:$ip" -X POST https://homepi.taild1532d.ts.net/hooks/contact   # 401
curl.exe -s -o NUL -w '%{http_code}' --resolve "homepi.taild1532d.ts.net:443:$ip" https://homepi.taild1532d.ts.net/                       # 404
curl.exe -s -o NUL -w '%{http_code}' --resolve "homepi.taild1532d.ts.net:443:$ip" https://homepi.taild1532d.ts.net/api/notify             # 404
```

Secret: `CONTACT_HOOK_SECRET` in `E:\gh\vmui\.private\credentials.env` (PC, source of truth) →
shipped to `/srv/homepi/vmui/.private/credentials.env` by `pi-deploy.ps1`. Unset = the route answers 503. Put the same value in the caller's env (Vercel `dragoscatalin`, production) — never in git.
