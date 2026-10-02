# Dev fleet — every machine, how to reach it, what it is for

All machines are on the Tailscale tailnet `tail666d40.ts.net`. Credentials live in
`.private/credentials.env` (gitignored); only key NAMES appear here.

| Machine | Kind | Reach from dragos-pc | User | Used for |
|---|---|---|---|---|
| `dragos-pc` | physical host (Hyper-V, WSL) | — | `vladu` | everything; hosts the VMs below |
| `dragos-vivobook` | **physical laptop**, ASUS Vivobook 16 X1605ZA, i5-1235U, 16 GB, Win 11 Pro 26200, battery | `ssh dragos-vivobook` (key `~/.ssh/id_ed25519`, admin key in `C:\ProgramData\ssh\administrators_authorized_keys`) | `vladu` (same Windows account as dragos-pc) | **real-OS test machine for codai desktop**: installs, SmartScreen, sleep/wake (Modern Standby S0 + Hibernate), toasts, jump list, WebView2 |
| `dragos-dev` | Hyper-V VM, Win 11 Pro | PS Direct (`DRAGOS_DEV_USER`/`DRAGOS_DEV_PASS`), RDP/SSH over Tailscale only | `dragos` | personal workstation VM (`devfleet.ps1`) |
| `mihai-dev` | Hyper-V VM | Tailscale | `mihai` | workstation for mihai (`FLEET_GUEST_*`) |
| `brivio-dev` | Hyper-V VM | Tailscale | — | brivio project server |
| `homeassistant` | Hyper-V appliance | LAN/Tailscale | — | Home Assistant (`docs/home-assistant.md`) |

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
