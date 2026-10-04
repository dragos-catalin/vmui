# Home Assistant — operations & setup

> **2026-09-17 — moved to the Raspberry Pi (`homepi`).** Home Assistant,
> ESPHome, Mosquitto, vmui, the Turzx renderer and the desk button now run on
> a Pi 4B (4 GB) at `192.168.100.232`, 24/7, independent of this PC. The
> Hyper-V HAOS VM below is **stopped and kept as a rollback**
> (`AutomaticStartAction = Nothing`). Sections after "homepi" describe that
> older setup; the traps in them still apply to HA itself.

## homepi — the house server (2026-09-17)

| what        | where                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| board       | Raspberry Pi 4B 4 GB, Pi OS Lite 64-bit (Trixie), boot from the Samsung FIT 64 GB USB stick (`pi/cloud-init/*`, written by `scripts/pi-image.ps1 -DiskNumber N`)                                                                                                                                                                                                                                                                                                                   |
| network     | eth0 `192.168.100.232` (router reservation on `d8:3a:dd:9d:e3:b5`), wlan0 `.63` as fallback (`scripts/pi-wifi.ps1`), `ssh homepi` alias, user `dragos`, key-only                                                                                                                                                                                                                                                                                                                   |
| stack       | `/srv/homepi/compose.yaml` (from `pi/compose.yaml`): `homeassistant` (host net, :80), `esphome` (:6052), `mosquitto` (:1883, user `homepi`, password in `.private/credentials.env` as `MQTT_PASS`)                                                                                                                                                                                                                                                                                 |
| egress proxy | `/srv/homepi/egress-proxy` (from `pi/egress-proxy/`, `scripts/pi-egress-proxy.ps1`): 3proxy on `127.0.0.1:3128` + Tailscale `100.82.141.110:3128` only, per-app basic auth + host allowlist, RO residential egress for app crawlers (MarcAI D29). Read [pi/egress-proxy/README.md](../pi/egress-proxy/README.md) |
| HA data     | `/srv/homepi/ha` — restored from a full HAOS backup via `/config/.HA_RESTORE` (`scripts/ha-backup-pull.ps1` makes and downloads one). Same instance ID, same long-lived tokens, 283 entities came across. `hassio:` fails to set up in container mode — expected, harmless                                                                                                                                                                                                         |
| vmui        | `/srv/homepi/vmui`, Node 22 + pnpm, `systemd` unit `vmui` binding `0.0.0.0:3737`. **Build on the PC, ship with `scripts/pi-deploy.ps1`** (55 s here vs 4+ min on the Pi). The script tars source + `.next` (minus `.next/node_modules`, which are Windows junctions) and recreates the `serverExternalPackages` links on the Pi from `next-links.txt`; `pnpm install` runs only when the lockfile hash changed                                                                     |
| Turzx       | `systemd` unit `turzx`, panel on `/dev/turzx` (udev rule by VID/PID). Fonts come from `turzx/fonts/` (Microsoft fonts copied from this PC, **gitignored**, shipped privately by pi-deploy). The "pc" view gets this PC's metrics from the `vmui-turzx` task, now `turzx.py --publish --vmui http://192.168.100.232:3737` → `POST /api/turzx/pc`, 15 s TTL                                                                                                                          |
| desk button | `systemd` unit `desk-button` (`pi/desk-button.py`): GPIO17 → GND, optional LED GPIO27. 1–5 clicks (400 ms window) or ≥1 s hold → `POST /api/esp/button?btn=desk&click=N                                                                                                                                                                                                                                                                                                            | long`. What each gesture does is the table on `/home?tab=settings&section=deskButton`("Butonul de birou", row id 3 of`turzx_settings`); default 1 = +250 ml, 2 = +100 ml, 3 = Turzx next, 4 = Ambilight movie, 5 = intercom auto-open 45 min, long = undo water. lgpio needs a writable cwd (`WorkingDirectory=/srv/homepi/logs`) or it dies with `FileNotFoundError: .lgd-nfy-3` |
| logs        | `/srv/homepi/logs/vmui.log`; turzx writes its own `/srv/homepi/vmui/.copilot-tmp/service-logs/turzx.log` (the systemd one stays empty); `journalctl -u desk-button`. **Power**: `vcgencmd get_throttled` must be `0x0` — `0x50005` (seen 2026-09-18) means under-voltage NOW; symptoms were the Turzx screen not enumerating (`1a86:5722 not found`), `write failed: Input/output error`, eth0 `Link is Down` and a spontaneous reboot. Needs a real 5.1 V/3 A supply, short cable |
| ESP32       | `scripts/esp32-display.ps1` now compiles in the Pi's `esphome` container (`-HostSsh dragos@192.168.100.232`, `-EsphomeDir /srv/homepi/esphome`) and bakes `http://192.168.100.232:3737` into the firmware (`-VmuiHost`/`-LanPort` to point elsewhere). First compile on the Pi is 10–20 min (toolchain download), later ones ~3 min                                                                                                                                                |

Two traps after restoring a HAOS backup into the container, both hit here:
`esphome` refused to set up ("Setup failed for dependencies: ['bluetooth']")
because the Pi's own `hci0` was RF-killed — `rfkill unblock bluetooth;
systemctl enable --now bluetooth`; and `.storage/esphome.dashboard` still
pointed at the add-on's port 64203 — set `host 127.0.0.1`, `port 6052`,
`addon_slug esphome`, then restart HA. `hassio` failing to load is expected
in container mode. A third one, found 2026-09-17 23:00: the HyperHDR custom
component logged `Unexpected HyperHDR error: ` (empty message) every 30 s
and `light.hyperhdr` stayed unavailable although the Pi reached
`192.168.100.61:8090/json-rpc` fine. Cause: `with async_timeout.timeout()`
(sync form) raises a bare `TimeoutError` on the newer `async_timeout` in this
HA image — it used to only warn on HAOS. Fix: `async with` in
`coordinator.py` and `config_flow.py`; the patched copies live in
`pi/ha-patches/` and pi-deploy re-applies them. Verified after restart:
`binary_sensor.hyperhdr_reachable on`, `number.hyperhdr_priority 50`.
Tuya (Smart Life) needs a re-login after every restore: the flow's QR code is
scanned **in the Smart Life app** (Me → scan icon), not Tuya Smart.

Still on the PC, on purpose: Ambilight (screen capture, HID, OpenRGB), the
tray, and the metrics publisher. The `local-kvm` provider (Hyper-V + QEMU in
WSL) is driven **from the Pi over SSH**: `src/lib/providers/host-exec.ts`
turns every `powershell.exe` / `wsl.exe` / `schtasks.exe` call into an ssh
hop when `VMUI_HOST_SSH` is set (unit sets `vladu@192.168.100.61`,
`VMUI_HOST_REPO=E:\gh\vmui` for the watchdog scripts). PowerShell travels as
`-EncodedCommand`; bash for WSL travels as a base64 argument decoded with
`echo $1 ^| base64 -d` (the `^` is for cmd.exe, which otherwise eats the
pipe — `<<<` here-strings fail the same way). The Pi's key
(`~/.ssh/id_ed25519`, comment `homepi-vmui`) is in
`C:\ProgramData\ssh\administrators_authorized_keys`. Measured: a Hyper-V sync
is ~2 s, a WSL sync ~1 s. Trap: `/dev/tcp` to a CLOSED port inside WSL2
blocks ~143 s (no RST through the NAT) — `qmpRemote` checks `ss -tln` first.
MCP gained `vm_sync` so agents (and this doc's verification) can trigger it.

The 128 GB microSD (manfid 0x1111, 2024) stays in the Pi but is **not used**:
it writes at 1.9 MB/s (mkfs.ext4 wedged in D state for 17 min and had to be
killed). USB boot is now first in the EEPROM (`BOOT_ORDER=0xf41`, applied at
next reboot together with the 2026-05-17 bootloader), so the card can be
pulled; `pi/sd-as-data.sh` is what to run if a faster card ever replaces it.
Rebooted 2026-09-17 22:30 with the card out: root on `/dev/sda2`, bootloader
2026-05-17, `BOOT_ORDER=0xf41` — VERIFIED.

**Wake-on-LAN for the PC** (`src/lib/home/wol.ts`): `POST /api/pc/wake?k=…`
(shared token; allowed through `proxy.ts`), MCP `pc_wake`, desk-button action
`pc_wake`, and in HA `script.pc_wake` + `binary_sensor.pc_dragos` from
`pi/ha-packages/vmui_pc.yaml` (installed by pi-deploy, which also writes
`vmui_pc_wake_url` into HA `secrets.yaml`). PC side: Realtek "Shutdown
Wake-On-Lan" on, **Fast Startup + hibernate off** (`HiberbootEnabled=0`) —
with Fast Startup on, a "shut down" PC is hibernating and ignores magic
packets. The wake short-circuits when port 22 already answers. Magic packet
verified leaving eth0 with tcpdump (`UDP 192.168.100.255.9, length 102`).

**Stream lighting** (`pi/ha-packages/vmui_stream.yaml`, installed by
pi-deploy; then `homeassistant.reload_all`): `script.stream_scene_<id>` for
every `STREAM_SCENES` entry (mode: restart, `duration_sec` variable),
`script.stream_scene_default` (stop + restore) and `script.stream_flash`
(`color`, `count` 1-5, `duration_ms`; repeats `notify_flash`). The first
effect snapshots `light.moodlight` + `light.ambience_light` into
`scene.stream_before` while `input_boolean.stream_effect_active` is off;
later effects keep that snapshot, and `stream_end` restores it. Strips get the
look via HyperHDR priority 30 with a `duration`, so they recover even if the
restore never runs. vmui calls them with `script.turn_on` (non-blocking) from
the MCP tools `scene_set` / `flash_color`.

**Turzx on the Pi**: new `pi` view (CPU / temp / RAM arcs, MHz, load,
throttle flags from `vcgencmd get_throttled`, containers, disk, net rate),
sampled by `_pi_worker` in `turzx.py` on Linux only. Activity view was blank
because the first-seen stamp loop sat after a `return` in `dwell_scale`, so
every row kept alpha 0 (text drawn in the background colour) — fixed by
stamping in `update()`. `--audit` now also flags text within 6 px of the
bezel and same-row labels closer than 3 px; the sweep fixed climate's hi/lo
labels (right-anchored at x=34, into the bezel) and every footer at y≥302
(now anchored `ld`/`rd` at `H-8`). 25 views × 6 skins = 0 problems.

Rollback: `Start-VM homeassistant`, put the router reservation back on
`00:15:5d:64:3d:25`, `esp32-display.ps1 -Flash -VmuiHost <pc-ip> -LanPort 8737`.

Storage note: the USB stick is fine to start; HA's recorder writes constantly
and will wear it out in months — clone to a SATA SSD in a USB3 enclosure when
it arrives (`dd` of `/dev/sda` → new disk, then change the boot order or just
move the disk).

Home Assistant OS used to run as a Hyper-V appliance on this host, reachable on the
LAN, over Tailscale, and at `https://home.dragoscatalin.ro` with a real
certificate. Everything here is reproducible from `scripts/`.

## Why an appliance VM and not a container

Only **Home Assistant OS** ships the Supervisor, and the Supervisor is what
provides add-ons (Tailscale, Mosquitto, Zigbee2MQTT, ESPHome, Let's Encrypt)
and the automatic pre-update backups. The `homeassistant/home-assistant`
Docker image is "Container mode": no Supervisor, no add-ons, no updates from
the UI. Each of those add-ons would become a hand-maintained compose file.

Cost of the choice: ~6 GB RAM and 64 GB of disk reserved permanently, and the
VM stops when the host reboots — mitigated with `AutomaticStartAction = Start`
and a 30 s delay.

## Layout

| what          | where                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| VM            | `homeassistant`, Gen2, 6 GB / 4 vCPU / 64 GB, `E:\Hyper-V\homeassistant` |
| switch        | **External** (`Windows 11 Enterprise`) — see below                       |
| LAN           | `192.168.100.232` (reserve the MAC in the router)                        |
| tailnet       | `100.80.94.97`, `homeassistant.taild1532d.ts.net`, `tag:appliance`       |
| web UI        | `http://192.168.100.232` — **port 80, not 8123**                         |
| custom domain | `https://home.dragoscatalin.ro` (tailnet only)                           |
| host OS shell | `ssh -p 22222 root@192.168.100.232`                                      |
| add-on shell  | `ssh root@192.168.100.232`                                               |

### Three listeners, deliberately non-overlapping

```
core             :80    plain HTTP        LAN + localhost
Tailscale Serve  :8443  TLS, ts.net cert  homeassistant.taild1532d.ts.net
NGINX proxy      :443   TLS, LE cert      home.dragoscatalin.ro
```

Tailscale Serve only accepts 443, 8443 or 10000 — hence 8443. **Do not put
Home Assistant itself on 443**; see the trap list below.

## Build from scratch

```powershell
# 1. Create the VM (elevated). Downloads HAOS, verifies its SHA-256.
scripts\homeassistant.ps1 -Build          # add -Latest to resolve a newer HAOS

# 2. Onboard in the browser at http://<ip> (create the admin user).

# 3. Enable host-OS SSH on 22222 (needed by steps 4-6).
scripts\homeassistant.ps1 -EnableHostSsh
ssh root@<ip> 'ha os import'

# 4. Add-ons: Tailscale, Mosquitto, File editor, Samba, Terminal & SSH.
scripts\ha-configure.ps1 -InstallAddons

# 5. Trust the reverse proxy, then log the Tailscale add-on in
#    (Settings -> Add-ons -> Tailscale -> Open Web UI -> Log In), then:
scripts\ha-configure.ps1 -TrustProxy
scripts\ha-configure.ps1 -ConnectTailscale
scripts\ha-configure.ps1 -EnableServe

# 6. Custom domain: LE certificate via Vercel DNS + NGINX on 443.
scripts\ha-configure.ps1 -PublishDomain

scripts\ha-configure.ps1                  # status
```

Tailnet policy lives in `infra/tailscale-home-acl.hujson`; apply it with
`scripts\tailscale-home.ps1 -ApplyAcl`. It is the source of truth — editing
only the Tailscale console means the next apply silently reverts it.

## Traps, all of them measured on this host

**The web UI is on port 80, not 8123.** HAOS 18's `core/info` reports
`port: 80`. Probing 8123 fails while the UI works, which reads exactly like a
crashed instance.

**`http:` in `configuration.yaml` is ignored.** On HA 2026.9 the integration
moved to UI-managed settings in `.storage/http` (`yaml_migration_done: true`).
Reverse-proxy trust must be set there (`ha-configure.ps1 -TrustProxy` does it
with `jq`). Symptom otherwise: `A request from a reverse proxy was received
from 127.0.0.1, but your HTTP integration is not set-up for reverse proxies`,
and a 400 from every proxied request. Trusted proxies must include
`172.30.32.0/23` — the Supervisor add-on network the NGINX proxy comes from.

**Never set `server_port` to 443.** Tailscale Serve already binds it. Core
fails with `[Errno 98] ... bind on address ('::', 443)`, `http` fails to set
up, every dependent integration fails with it, and HA boots into **recovery
mode with no frontend**. Recovery: set it back to 80 in `.storage/http` and
`ha core restart`.

**Enable Serve only after the node is logged in.** Otherwise the add-on's
`share-homeassistant` service exits 1 with no message, s6 tears the container
down, and its UI returns 502. `-EnableServe` refuses until it can prove both
preconditions.

**Secure Boot must be OFF and there is no vTPM.** HAOS is signed by neither
Microsoft template; with Secure Boot on it halts at the firmware screen.

**The switch must be External.** mDNS/Bonjour, SSDP and the UDP broadcasts
Tuya/Shelly/Sonoff/Hue/Chromecast rely on do not survive NAT. On the Default
Switch the integrations find nothing and report no error while doing it.

**Supervisor REST is not usable from outside.** `/api/hassio/...` returns 401
for a long-lived token; only the WebSocket command `supervisor/api` accepts
one. Also, `POST /addons/<slug>/options` _replaces_ the whole options object
and complains about one missing key per attempt — read, merge, write back.

## Remote access

**On homepi (2026-09-18)**: `scripts/pi-publish-ha.ps1` → `pi/publish-ha.sh`.
`https://home.dragoscatalin.ro` resolves to the **LAN IP** `192.168.100.232`
(Vercel DNS; zone is NOT on Cloudflare), Caddy on the Pi terminates TLS with a
Let's Encrypt cert from lego DNS-01 (`/srv/homepi/publish/.lego`, daily
`/etc/cron.d/ha-cert-renew`) and proxies to HA :80; HA got
`http: trusted_proxies` and `external_url`/`internal_url` via the websocket
`config/core/update` (`pi/ha-set-urls.cjs`). The Pi advertises
`192.168.100.0/24` on the tailnet (approved), so the same name works away from
home. Why LAN IP and not the tailnet IP: the Nest Hub is not on the tailnet
and casting needs an HTTPS `external_url` it can reach — verified:
`nest_hub_show` → `media_player.bedroom_smart_display playing / Home
Assistant Lovelace`. Traps: Caddy runs as `caddy` and cannot write
`/srv/homepi/logs` (log to `/var/log/caddy`); piping the HA token into
`ssh … read` adds CRLF → `auth_invalid`, pass it base64 in the command.

- **Tailscale** — every device on the tailnet reaches the instance directly.
  The Companion app should use `https://home.dragoscatalin.ro` as its external
  URL and `http://192.168.100.232` as the internal one, so it switches
  automatically at home.
- **Nabu Casa** — optional, adds Alexa/Google without manual OAuth work, and
  funds the project. Turn it on in Settings → Home Assistant Cloud; it
  coexists with Tailscale.
- **Funnel is deliberately NOT enabled.** It would publish the instance on the
  open internet, which is the thing the tailnet exists to avoid.

### Certificate renewal

The Let's Encrypt add-on is not a daemon: it renews only when started.
`-PublishDomain` creates an HA automation (`letsencrypt_renew`) that starts it
at 04:30 daily; certbot exits immediately unless the cert is within 30 days of
expiry.

## Radios: Zigbee, Thread, Bluetooth

**Hyper-V has no USB passthrough on Gen2 guests, and cannot pass a Bluetooth
radio at all.** A Zigbee stick in the host is invisible to the appliance.

- **Bluetooth is solved**: `bluetooth-proxy-1` (ESP32, `192.168.100.120`) is
  an ESPHome Bluetooth Proxy in _active_ mode, so HA can connect to BLE
  devices, not just hear them. Built and flashed by
  `scripts\ha-devices.ps1 -FlashProxy -ComPort COMx` — the firmware is
  compiled inside the ESPHome add-on and flashed from the host, the only
  machine that can see the USB port. Add more proxies for range; HA merges
  them.
- **BLE LED strips** (MELK / ELK-BLEDOM / LEDBLE — the "Lotus Lantern",
  "duoCo Strip", "Happy Lighting" apps): HACS `elkbledom`, added with
  `-AddBleLed -Mac .. -Name .. -Model MELK-OA10`. Only one client may be
  connected at a time — force-close the phone app or HA cannot connect.
  Live state is not read back from the strip; control it from HA only.

- **Best long-term: an Ethernet coordinator** — SMLIGHT SLZB-06 / SLZB-06M
  (~30 EUR, PoE). It sits on the LAN, advertises over mDNS, and Zigbee2MQTT
  finds it with `port: mdns://slzb-06`. No host process, no bridge, survives
  host reboots, and can be moved to a better RF location than a PC case.
- **Interim, if a USB stick already exists**: `scripts\zigbee-bridge.ps1`
  serves the COM port over TCP, and Zigbee2MQTT connects with
  `port: tcp://192.168.100.61:6638`. Runs as a SYSTEM scheduled task with a
  firewall rule scoped to the appliance.
  ```powershell
  scripts\zigbee-bridge.ps1 -List
  scripts\zigbee-bridge.ps1 -Install -ComPort COM6
  ```

## Devices and how each was added (2026-09-12)

```powershell
scripts\ha-devices.ps1 -Inventory                # LAN + BLE + pending flows
scripts\ha-devices.ps1 -InstallCustomIntegrations   # HACS, elkbledom, connectlife
scripts\ha-devices.ps1 -ConfirmDiscovered        # DLNA, Samsung, MQTT, ESPHome
scripts\ha-devices.ps1 -AddTuya                  # QR -> scan -> re-run
scripts\ha-devices.ps1 -AddConnectLife           # Hisense AC
scripts\ha-devices.ps1 -AddBleLed -Mac BE:69:83:00:C4:0B -Name 'LED ARGB'
scripts\ha-devices.ps1 -PairAndroidTv -TvName 'Kitchen TV' -Pin 123456
```

| device                                                                                                   | integration                                      | how                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Nest Hub, Chromecast HD ×2                                                                               | Google Cast                                      | auto                                                                                             |
| Chromecast HD ×2 (remote control)                                                                        | Android TV Remote                                | discovered; **PIN on the TV**, still pending                                                     |
| Samsung Odyssey OLED G8                                                                                  | Samsung TV + DLNA                                | discovered, confirm                                                                              |
| Desk Light Bar (Ustellar), Star Projector, door + window contact sensors, presence sensor, temp/humidity | **Tuya**                                         | Smart Life `User Code` → QR scanned in the app                                                   |
| Hisense AC ×2 (Bedroom, Living room)                                                                     | **ConnectLife** (HACS `oyvindwe/connectlife-ha`) | email + password                                                                                 |
| LED ARGB strip (MELK-OA10)                                                                               | **elkbledom** (HACS) via Bluetooth proxy         | mac + model, flicker test                                                                        |
| Mosquitto                                                                                                | MQTT                                             | discovered from the add-on                                                                       |
| AlecoAir purifier                                                                                        | Tuya                                             | **pending**: it lives in the AlecoAir app; re-pair it in Smart Life and it appears automatically |

Tuya quirks: the temperature sensor reports °F by default — switched to °C in
the entity registry (`options_domain: sensor`). The integration is cloud;
devices still work locally from their own app if the cloud is down, HA does not.

Discovery duplicates: after a BLE device is configured manually, HA may still
raise a Bluetooth discovery for the same MAC. Dismiss it (`DELETE
/api/config/config_entries/flow/<id>`); `-Inventory` shows it.

**Supervisor WebSocket gotchas met here**: `config_entries/flow` is
POST/GET-only over REST — listing pending flows is WS `config_entries/flow/progress`;
entity option updates need `options_domain` + `options`, not a nested map;
`$Input` is a PowerShell automatic variable and silently breaks a parameter.

## Ambilight: screen → every light (2026-09-12)

`scripts/ambilight.ps1` owns this. DX Light (the vendor app for the 65-LED
monitor strip) is replaced by **HyperHDR 22** because DX Light drives one strip
from one screen with no API; HyperHDR captures the same DX11 frames, does HDR
tone-mapping properly, and fans out to everything through standard outputs.

```
HyperHDR (this PC, DX11 grabber 60 fps, HDR→SDR, monitor_nits 250)
  inst 0  DX Light (monitor)     udpraw :19446 → ambilight/dxlight_bridge.py → USB HID, 65 LEDs, ~59 fps
  inst 1  PC glow (OpenRGB)      udpraw :19447 → ambilight/openrgb_bridge.py → OpenRGB SDK :6742
                                 (3 regions: left / whole / right → case strips, GPU, board)
  inst 2  Room lights (HA)       home_assistant driver → BLE strip (whole); bar is white-only, set by the scenes
  MQTT client ──────────────────► Mosquitto add-on, topic HyperHDR/JsonAPI
Home Assistant ◄─ ha-scenes.yaml package: movie / music / off, notify flash, webhooks,
                  phone-notification colours (Companion "Last notification" sensor)
```

Four logon tasks (`vmui-ambilight-*`) start HyperHDR `--service`, OpenRGB
`--server`, and the two Python bridges; each restarts on failure. `-Status`
shows task/process state and what each instance is currently showing.

Traps:

- **HyperHDR's HA driver assumes `:8123`.** This appliance serves on `:80`, so
  `homeAssistantHost` must be `ip:80` or every request is a `408 Timeout`.
- **`/json-rpc` over HTTP only ever addresses instance 0** and rejects an
  `instance` field. MQTT is the multi-instance path: one message carries an
  array, and `instance/switchTo` inside the array retargets the commands that
  follow. `script.ambilight_all` builds that array for `[0,1,2]`.
- **`R` and `S` are PowerShell aliases** (`Invoke-History`, `Set-Variable`).
  A helper named `R` re-ran the terminal history. Use longer names.
- **The DX Light strip is a raw HID device** that DX Light and HyperHDR both
  open; whichever writes last wins and it flickers. `-Install` removes DX
  Light from `HKCU\...\Run` and kills it.
- **OpenRGB closes when its window closes** even with `minimize_on_close`;
  the bridge reconnects with backoff instead of dying.
- **Companion "Last notification" never fires for HA's own notifications**,
  so `notify.mobile_app_*` cannot be used to test it. Entity appears in HA
  only after the first notification from an allow-listed app.
- Mosquitto add-on options via Supervisor WS need `data.options = {...}`;
  posting the options object flat returns "extra keys not allowed".

The MELK BLE controller is one colour for the whole strip and can never be a
real ambilight target — `ambilight/wled-strip.md` is the WLED replacement.

## The `/home` page and https://mui.dragoscatalin.ro (2026-09-12)

vmui has a phone-first smart-home surface at `/home`: a floor plan of the
four rooms with each device as a dot that glows in its live colour, a Devices
list, and an Ambilight tab (movie/music/warm modes, screen capture on/off,
HyperHDR effects, notification flash test, per-instance status). State is
pushed over SSE from HA's WebSocket (`/api/home/events`); mutations are Server
Actions in `src/server/actions/home.ts`, whitelisted against the catalog in
`src/lib/home/catalog.ts` and audit-logged under account `home`. Dot
positions are saved per device in `home_layout` (Arrange mode).

Reaching it from the phone:

- `scripts/vmui-service.ps1 -Install` — production `next start` on
  `127.0.0.1:3737` as a logon task. The launcher (`vmui-service-run.mjs`)
  spawns next **detached** and exits, because a Task Scheduler console
  delivered Ctrl+C to the server ~75 s after start
  (exit `0xC000013A`). The task re-fires every 5 min; the launcher is a no-op
  while the port answers. `-Status` shows pid and uptime.
- `scripts/publish-vmui.ps1` — Vercel DNS `mui` A → PC tailnet IP, Let's
  Encrypt via lego DNS-01 (Vercel), and a Caddy route to :3737. Because
  brivio's elevated Caddy already owns :443, the route and certificate are
  **attached to it through its admin API** (:22019, `@id vmui-mui`). A
  5-minute task `vmui-publish-ensure` re-attaches after that Caddy restarts,
  or starts our own Caddy if :443 becomes free. `-Status`, `-Renew`,
  `-Remove`. Only tailnet devices can reach the IP; the name is public.

Traps:

- The Tuya Desk Light Bar reports `hs` colour support but its firmware
  `work_mode` enum is `['music','white']`, so any colour call is an HA 500
  ("Server got itself in trouble"). Catalog `whiteOnly: true` hides the
  colour picker; the action refuses rgb for it. Warmth/brightness work.
  It must also stay OUT of HyperHDR's `lamps`: one 500 disables the whole
  `home_assistant` device, strip included, and the room goes static
  (symptom seen 2026-09-14).
- **Capture follows the Windows PRIMARY display** (`device: auto`). The
  film monitor (Odyssey) is the secondary, so `reorder_displays = 1`. Wrong
  value shows as an endless `AcquireNextFrame didn't return the frame` and
  every light static. `systemGrabber` is global: write it as part of the
  full instance-0 config, LAST — a setconfig containing only
  `systemGrabber` resets every instance's `device` to `file`.
- `ambilight.ps1 -Status` now shows device type, LEDDEVICE state, grabber
  display/fps and the bridge's last fps line. "task=Running" alone proved
  nothing: all four tasks were running while no frame moved.
- Task Scheduler consoles deliver Ctrl+C to console apps started as tasks
  (`0xC000013A`). The Python bridges run under `pythonw.exe` and log to
  `.copilot-tmp/service-logs/*-bridge.log`; HyperHDR/OpenRGB are GUI apps
  and were never affected.
- Caddy admin: `PUT` creates (fails if the key exists), `PATCH` replaces,
  `POST` appends. A `POST` to `load_files` nests an array and the whole
  config load is rejected.
- No `/api/error_log` on this HA build; read tracebacks with
  `ssh -p 22222 root@… 'ha core logs'`.

## ESP32 desk display (2026-09-14)

The ideaspark ESP32 that is Home Assistant's Bluetooth radio also has a
0.96" two-colour SSD1306 (rows 0-15 yellow, 16-63 blue), a BOOT button and
a blue LED on GPIO2. Firmware = ESPHome from `esp32/home-display.yaml.tmpl`,
rendered and compiled by `scripts/esp32-display.ps1` inside the ESPHome
add-on and flashed over OTA or `COM10`.

**Architecture.** The board has ~300 KB heap and no PSRAM, so it renders
nothing. vmui composes every view as a 1-bit 128x64 BMP (1 086 bytes) at
`/api/esp/display/<node>?k=ESP_DISPLAY_TOKEN` (`src/lib/esp/`) and the
board pulls it every 3 s with `online_image`. Caddy exposes only
`/api/esp/*` on `192.168.100.61:8737` (plain HTTP, LAN) — `-Publish` adds
that server to the :443 Caddy and `publish-vmui.ps1 -Ensure` re-adds it
when brivio's Caddy restarts. Offline (PC down) the board shows its own
clock + wifi/ha status.

**Views** (`src/lib/esp/views.ts`), rotating every 8 s: clock, weather,
activity (HA state changes + Assist requests, `src/lib/esp/activity.ts`),
home status, ambilight, shopping list, last vmui actions, system.
**BOOT**: short = next view, double = pause, long = movie mode on/off
(`/api/esp/button`). **Blue LED** blinks 40 ms per new frame, steadily while
WiFi is down. The red LED next to USB is hardwired to 5V.

Traps: OLED is on **GPIO21/22** on this unit (5/4 → `Communication
failed`); BLE proxy + image download exhausted heap → passive scan,
`max_connections: 1`, `sram1_as_iram`, log level WARN (INFO log lines go
through the API overflow buffer, which is where `bad_alloc` hit);
`online_image` needs `Content-Length` or it reports `Size: 0` and draws
nothing; opening the COM port resets the board unless DTR/RTS are cleared
before open; a reboot loop with `rst:0x3 (SW_RESET)` and no backtrace was
`E BOD: Brownout detector was triggered` (WiFi burst + BLE on the weak 3V3)
→ `wifi.output_power: 8.5dB`. HA prefixes the entities with the area:
`sensor.office_bluetooth_proxy_1_*`. vmui's own port needs a persistent
WinNAT exclusion (`netsh int ipv4 add excludedportrange … 3737/8737`) or a
reboot can hand it to Hyper-V.

**API "dropped immediately after encrypted hello" for hours (2026-09-15/16,
5.5 h + a repeat)**: not the key, not the board. Every `esphome logs`
started inside the ESPHome add-on holds one of the board's API slots, and
killing the ssh client on Windows does **not** kill that python process —
four orphans pinned all slots; serial (COM10) showed
`[W][api:249]: Max connections (3), rejecting 192.168.100.232` once a
second while HA retried. Cold power-cycles did not help because the orphans
reconnected before HA. Count them with
`docker exec app_5c53de3b_esphome sh -c 'cat /proc/net/tcp' | grep -ic ':17A5'`.
`esp32-display.ps1` now reaps them on every run (`Reap-LogStreams`), streams
logs over **USB** when the CH340 is on this PC, and caps WiFi log streams at
600 s. Belt and braces: the firmware asks `/api/esp/watchdog/<node>` once a
minute and reboots when vmui sees HA's status sensor off for 3 min.

**Flashing**: `-Flash` compiles in the add-on (~35 s warm; the first
compile after an ESPHome update is ~20 min — that was the "1181 s upload")
then writes over USB with esptool on the CH340 (28 s); it falls back to OTA
only when no serial port is present or busy. `-Flash -Ota` forces OTA.

**OKOK / Chipsea bathroom scale** (`6C:02:4C:E9:DD:BB`) is decoded on the
board from its BLE adverts — the OKOK app has no Health Connect export.
Frame = last 13 bytes of manufacturer data `00C0`: weight u16 BE ×0.01 kg,
two 16-bit "resistance" words (constant 5000/4992 → decorative pads),
props (bit 0 locked, bits 3-5 unit, 4 = kg), own MAC. The passive 160/320 ms
scan sees only a few of the ~15 frames per weigh-in and often misses the
locked one, so the last frame of a burst is published 6 s after it goes
quiet → `sensor.office_bluetooth_proxy_1_scale_weight` (verified 65.40 kg)
and `_scale_impedance`. The Turzx `health` view uses it when Health Connect
has no weight.

### Water button (2026-09-17)

A PC-case power switch with its LED, wired straight to the ideaspark header
(no resistor — case LEDs carry one on the lead; tested at 3.3 V):

| Lead         | Pin        | Row / position                    |
| ------------ | ---------- | --------------------------------- |
| POWER SW (a) | **GND**    | bottom row, 2nd from left         |
| POWER SW (b) | **GPIO13** | bottom row, 3rd from left (`D13`) |
| POWER LED −  | **GND**    | top row, 2nd from left            |
| POWER LED +  | **GPIO4**  | top row, 5th from left (`D4`)     |

Avoided on purpose: `D15` (strapping, blocks boot logging when pulled low),
`D2` (on-board LED), `D21/D22` (OLED), `RX0/TX0` (serial log).

Short press → `POST /api/esp/button?btn=water&click=single` → +250 ml; hold
≥ 1 s → `click=long` → undo the last glass. vmui replies with `led` 1/2/3
(added / undone / nothing to undo) and the firmware blinks the switch LED
that many times; 5 blinks = HTTP error. Every minute the board reads
`GET /api/nutrition/water` and, while `underPace` is true (no glass for 2 h
between 08–22 and the target unmet), pulses the LED 1 s on / 3 s off.
Target = 35 ml/kg from the scale weight, +500 ml when Health Connect active
kcal > 500 (2250 ml at 64.6 kg). Storage: `hydration` table; mirror
`sensor.vmui_nutrition_water_today` in HA; `water` row on the Turzx
`nutrition` view and the `/home?tab=nutrition` card (add/undo there too).
Phone: `POST /api/nutrition/water {ml,source}` / `DELETE` to undo.
Verified 2026-09-17: 4 presses → 1000 ml, 2 holds → 500 ml, all within 1 s.

## Interfon Electra IA02 → telefon (2026-09-17, etapa 1)

Same ESP32 (`bluetooth-proxy-1`), powered from a USB charger — no PC needed.
Ring at the street door → HA companion notification on the S25 Ultra with
two actions (_Răspunde și deschide_ / _Ignoră_), the Turzx shows an orange
"Suna la interfon" card while the line is live, and the **home** tab of
`/home` has the Interfon card (owner + adult only — `requireDoorAccess`) with
an "Aștept curier" auto-open arm (30/60 min, expires by itself). Every open
lands in `audit_log` and `sensor.vmui_intercom_last_open`.

Electra IA02 facts (Electra manual + arduino.cc thread; **measure before you
trust them**): terminals top-down `+D1 · AVP · COMP · P · MP`. `MP` is
ground. `P` carries +12 V **only while a call is in progress** (it is what
powers the handset), and it collapses to ~4.8 V under load — never power the
ESP from it. `AVP` is the command line: _talk_ = pull AVP to +12 V through
4.7 kΩ + diode for ~1.2 s, then _open_ = AVP straight to ≥ 11.7 V for ~1.2 s.
Order is strict (talk first, then open) and only works during a ring.

Wiring (all mains-free, 12 V side galvanically isolated from the ESP):

| Purpose     | Parts                                                                 | Connection                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ring detect | PC817 optocoupler, 2.2 kΩ, 10 kΩ                                      | `P` → 2.2 kΩ → PC817 pin 1 (anode); pin 2 (cathode) → `MP`. Pin 4 (collector) → GPIO34 **and** 10 kΩ → 3V3; pin 3 (emitter) → ESP GND. GPIO34 has no internal pull-up, hence the external one. |
| Talk pulse  | relay 1 of a 5 V 2-channel opto-isolated module, 4.7 kΩ, 1N4148/BA159 | module VCC ← ESP 5V, GND ← ESP GND, IN1 ← GPIO16. Relay 1: COM ← `P`, NO → 4.7 kΩ → diode (anode toward relay) → `AVP`.                                                                        |
| Open pulse  | relay 2, second diode                                                 | IN2 ← GPIO17. Relay 2: COM ← `P`, NO → diode → `AVP` (no resistor).                                                                                                                            |

Shopping list: 2-relay 5 V module with optocouplers (low-level or high-level
trigger — check the module, the firmware drives GPIO16/17 HIGH to close),
1× PC817, 2× 1N4148 (or BA159), resistors 4.7 kΩ / 2.2 kΩ / 10 kΩ, a strip of
Dupont wires. The INMP441 / MAX98357A on hand are for stage 2/3 (audio).

Measure first (multimeter, DC): `P`–`MP` idle and while someone rings from
downstairs (expect 0 V → ~12 V), `AVP`–`MP` during a ring, and confirm `MP`
is the common by checking continuity to the handset shield. If `P` is not
~12 V during a ring the resistor in the ring-detect leg must be recomputed
(target ≈ 4–5 mA through the PC817 LED).

Firmware (`esp32/home-display.yaml.tmpl`): `binary_sensor intercom_ring`
(GPIO34, inverted, 150 ms debounce, 4 s release delay) → `POST
/api/esp/intercom?event=ring`; if vmui answers `"open":true` (auto-open armed)
the board runs `script intercom_open_seq` itself. The same script is exposed
as `esphome.bluetooth_proxy_1_intercom_open` and
`button.office_bluetooth_proxy_1_intercom_open`; it refuses to fire when the
line is not ringing (relay closing onto a dead `P` does nothing useful).
Phone action → HA event `mobile_app_notification_action` → vmui
`openDoor("telefon")` → that service. Verified 2026-09-17 with GPIO34
floating (reads _ring_ until the opto is wired): notification + actions,
arm → ring → `{"open":true}`, both HA entities and the service present.

Stages 2/3 (not built): listen to the visitor with the INMP441 held against
the handset earpiece (I²S → ESPHome `microphone` → HA Assist/stream), talk
back through the MAX98357A + a small speaker taped to the handset mic
(acoustic coupling; no galvanic tap of the audio pair, which the manual says
is polarity-sensitive and carries the 12 V).

## Tray icon and console-free tasks (2026-09-14)

**2026-09-19: the tray is now `apps/desktop` (Tauri 2).** Task `vmui-tray`
runs `apps\desktop\src-tauri\target\release\vmui-desktop.exe --hidden`. Icon
colour = health (green / amber / red, polled every 15 s). Menu: Deschide vmui,
Mod film / muzică / stins (bifat), Captură ecran, Șterge efectele, Scene ▸,
PC ▸ (blochează / stinge monitoarele / sleep), Repornește stack-ul, Ieșire.
Left-click or _Deschide vmui_ opens the native window (Ambilight · Casă ·
Ecrane · Servicii · PC) — no browser. Details, build and the browser test
harness in [apps/desktop/README.md](../apps/desktop/README.md).
`ambilight/tray.py` is kept only as a fallback.

Why the old menu's modes "did nothing" (fixed the same day, three stacked
causes): Mosquitto on the Pi had died at start (log dir owned by `dragos`,
broker runs as uid 1883), HA's MQTT entry still pointed at the HAOS add-on
(`core-mosquitto` / `homeassistant`), and HyperHDR's `hyperhdr` MQTT user
did not exist in the broker's passwd. Set broker passwords with
`.copilot-tmp/mqtt-user.ps1` (base64) — piping them over ssh from PowerShell
appends `\r` and the broker refuses the client forever.

Historical: `ambilight/tray.py` (pythonw) showed one icon: green =
HyperHDR + vmui + bridges up, amber = something stopped, red = HyperHDR
unreachable. Console apps started by tasks (`node`, `pwsh`, `caddy`) go
through `scripts/hidden-run.vbs` — Task Scheduler's _Hidden_ only hides the
task, the console still flashes. Tasks run with the **Interactive** token:
S4U processes cannot be stopped from the desktop (took an admin `taskkill`
twice) and cannot reach the user's Caddy admin port.

**Wall compensation** (Ambilight tab → _Wall compensation_): the monitor
strip lights a blue wall, so pick the wall colour and pull the slider until
white on screen reads white on the wall. The UI calls `ambilight.ps1 -Set
wallHex=… wallStrength=…` (`src/lib/home/ambilight-settings.ts`), so
`ambilight/settings.json` stays the single source and the formula lives once,
in `New-WallCompensation`.

## Turzx 3.5" desk screen (2026-09-14)

The USB LCD next to the ESP32 is a **Turzx 3.5"** 320×480, VID `1a86` PID
`5722`, serial `USB35INCHIPSV2`, COM11. Despite the rev-B-looking IDs it
answers **only the 6-byte "rev A" command word** (the one in selfie-screen's
`TuringLcd.kt`): bytes 0–4 pack `x y ex ey` at 10 bits each, byte 5 is the
command — `102` clear, `108/109` off/on, `110` brightness (0 = brightest),
`121` orientation (16-byte form), `197` bitmap followed by RGB565
**little-endian** pixels. The rev B 10-byte protocol (`CA/CB/CC/CE`) is
accepted silently and draws nothing — an afternoon lost. Driver:
`turzx/lcd.py`; landscape is done by rotating each rect onto the native
portrait framebuffer. Link rate measured at **~365 KB/s** and linear (300 KB
full frame in 0.82 s, 3 KB in 8.5 ms), so `anim.dirty_rects` sends exact
row runs narrowed to changed columns and `Renderer.push` caps bytes per frame
at link-rate/fps, streaming the remainder on later frames. Continuous
effects are quantised (`Pulse(steps=)`, `qsin`) so a breathing underline does
not repaint every frame; view transitions are strip wipes, never blends.

`turzx/turzx.py` (task `vmui-turzx`, pythonw, restarts on failure and
reconnects when the screen is unplugged) polls
`GET /api/turzx/state?k=ESP_DISPLAY_TOKEN` every 3 s and rotates the views in
`turzx/views.py`: morphing clock, animated weather, home, live ambilight
colour, PC gauges (psutil + NVML), HA activity, now playing with album art,
shopping/actions lists. Metric everywhere. `python turzx\turzx.py --once`
writes one PNG per view to `.copilot-tmp/turzx/` for layout checks without
the hardware; the log is `.copilot-tmp/service-logs/turzx.log` (fps and KB/s
once a minute).

Settings (`turzx_settings` row 1, schema v2 in `src/lib/turzx/settings.ts`,
catalog of views/skins/sources in `src/lib/turzx/catalog.ts`) are edited from
`/home?tab=settings&section=turzx` — the **view manager**: per view enable/order, its own
dwell (min 5 s), skin, optional own background and view-specific options
(currencies, coins, calendars, countdown dates, ping host, pomodoro
lengths…); global fps, transition, day/night brightness and window, accent,
180° flip, global background and how often photos rotate. The header
underline is the **dwell progress bar** — full on entry, shrinking to the
left until the view changes. Pomodoro is started/stopped from the same tab
(row 2 of the table, `pomodoroAction`); the view only appears while running.

**Views (19)**: clock, weather, home, ambilight, pc, activity, media, lists,
fx (BNR via `curs.bnr.ro` — `www.bnr.ro` returns HTML), crypto (CoinGecko),
photo (full-screen picture + caption), fleet (vmui instances), climate (24 h
HA history), calendar (HA `calendar.*`), pomodoro, network (ping, psutil
throughput, Tailscale peers), countdown, quote, ambient (night-only clock).

**Skins (6)** in `turzx/skins.py`: minimal, glass (translucent panels over a
photo, 1 px text shadow), neon (accent outlines + glow), editorial (one
dominant figure, uppercase labels), terminal (amber monospace, scanlines,
ignores photos), paper (light, Georgia). A view never hard-codes colour or
font; `--once --all-skins` renders all 114 combinations to
`.copilot-tmp/turzx/` and `.copilot-tmp/uicheck/sheet.py` tiles them.

**Backgrounds** (`turzx/backgrounds.py`): local folder (recursive, ≤ 2000
files) and the online pool the API pre-fetches from dashy's licence-vetted
free sources (NASA APOD, Met CC0, Art Institute, Commons POTD;
`src/lib/turzx/feeds.ts`). Downloads land pre-cropped to 480×320 in
`.copilot-tmp/turzx/bg/`. A photo is swapped **only at view entry** (that
300 KB repaint coincides with the transition) and at most every
`bgRotateMin`; `dim`/`blur` keep text legible. Long strings render through
`anim.Marquee` — clipped to their slot and scrolled when they do not fit.

**Phone notifications** (`turzx/overlay.py`, settings → _Notificări de pe
telefon_): while `binary_sensor.human_presence_sensor_occupancy` is on, a
new entry on `sensor.dragos_s_s25_ultra_last_notification` (Companion app
"Last notification", allow list = messaging apps) pops a card over the
current view: sender avatar with the app badge, sender, up to 7 wrapped
lines then a slow vertical scroll, faded backdrop, slide in/out from the
nearest edge; position top/centre/bottom, duration, "show text" and the
package list are configurable. Rotation pauses while a card is up.
`python turzx\turzx.py --demo-notify` pops a fake WhatsApp card after 5 s.
The Companion app was installed and granted notification access over adb
(`cmd notification allow_listener …NotificationSensorManager`, then
disallow/allow once to force the bind); the sensor entity only appears in
HA after the first notification from an allowed app.

**Trap — "frozen screen".** Under sustained load the panel occasionally

**Seeing what the panel shows.** The renderer writes its last pushed frame
to `.copilot-tmp/turzx/mirror.png` once a second; `/api/turzx/mirror`
serves it (session or `?k=` token) and `/home?tab=settings&section=turzx` shows it live
("Oglindă live", 1:1 or 2×). **Layout audit**: `python turzx\turzx.py
--once --all-skins --audit` renders every view × skin, records every text
box drawn (`Skin.text`, `Marquee.draw` → `turzx/audit.py`), and flags
off-screen or overlapping text with `*-audit.png` overlays; exit 1 if any.
Run it after touching any view. `.copilot-tmp/uicheck/sheet.py v1,v2` tiles
the PNGs for a quick eyeball.
stops drawing (and eventually stops ACKing → `SerialTimeoutException`).
Only the full init sequence (hello + CLEAR + orientation + on) wakes it;
lighter resyncs and plain rewrites do nothing. `Renderer.push` runs
`lcd.resync()` + an immediate full repaint on a write timeout and every
60 s as a watchdog. **Do not** concatenate the 6-byte bitmap header with the
pixel payload into one `write()` — the panel then ignores the command
entirely (black screen, every byte ACKed); the header must be its own
transfer. When the screen goes black after a driver change, replay the
original minimal test script before theorising.

**Trap — which port is the Turzx.** COM6 (`1a86:ca21`, "CT21INCH") and COM7
(`1d6b:0121`, sn `20080411`) are a _different_ Turing-family screen (rev C,
"chs_5inch"). Sending rev-B-sized frames to it wedged its CDC endpoint (CTS
low, write timeouts) until an elevated PnP disable/enable. Identify a screen
by unplug/replug (`.copilot-tmp/uicheck/usb-watch.py`) before writing to it.
COM10 is the ESP32's CH340.

### Views, batch 3 (2026-09-15)

23 views now (`src/lib/turzx/catalog.ts` ↔ `turzx/views*.py`); the four new
ones ship **disabled** — turn them on in `/home?tab=settings&section=turzx`:

| view            | source                                                                                                               | notes                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `copilot`       | every VS Code profile's `github.copilot-chat/session-store.db` (read-only copy + WAL, `feeds.agentSessions`)         | repo, turns today, last prompt per active session. Store is ~110 MB → copied **async**, 30 s TTL, stale-while-revalidate. |
| `focus`         | `user32` foreground window + `GetLastInputInfo`, sampled on the host thread (`turzx.py::_Focus`)                     | active window + time in it; day split cod/terminal/browser/chat/media; idle after N min.                                  |
| `anniversaries` | `options.people` lines `YYYY-MM-DD Name`                                                                             | next one big with age + days; 29 Feb → 1 Mar.                                                                             |
| `energy`        | HA sensors with `device_class` power/energy/current (`feeds.energyReadings`); batteries from `device_class: battery` | `mA` → W at 230 V (Tuya AC plugs only expose current). Cost = kWh × `pricePerKwh` (default 1.3 lei).                      |

Content added to existing views: weather → next 6 hours strip, UV / dew
point, moon on clear nights (`feeds.moonPhase`, local synodic maths);
clock → sunrise/sunset ticks on the day bar, moon glyph 21:00–05:00; home →
low-battery badge in the header, red edge pulse when the door has been open

> 2 min; media → **synced lyrics** from LRCLIB (`feeds.syncedLyrics`, keyless,
> 24 h cache) replace the equaliser while playing; pc → disk fill row
> (`options.disks`); crypto → `holdings` portfolio line; fx → `watchAmount`
> ("1000 EUR = … lei") and XAU (BNR lists gold per gram); photo → quantised
> Ken Burns drift (one crop every ~2 s, so ~0.5 full frames/s on the link).

Rotation is now content-aware: `View.dwell_scale(state)` shortens a view's
dwell when it has little to show (empty shopping list, no activity, no VM
running). The poller adapts too: 2 s while something plays, 3 s by day,
10 s in the night window.

### Moving the smart plug, the AlecoAir purifier and the ACs into HA

The `energy` view is empty until a power sensor exists in HA. The plug and
the purifier are Tuya-cloud devices living in their vendor apps; HA's Tuya
integration only sees what is in **Smart Life** under the account whose QR
we scanned (`ha-devices.ps1 -AddTuya`). Phone steps, ~5 min:

1. **Priza**: in the vendor app, remove it (or hold its button 5 s until it
   blinks fast). Smart Life → `+` → it appears under "Discovering devices"
   (same 2.4 GHz WiFi as the phone) → add. Within a minute HA shows
   `sensor.<name>_power` (W) and `sensor.<name>_today_energy` (kWh) — the
   view picks them up with no config.
2. **AlecoAir**: same — AlecoAir's app is a Tuya OEM skin, the device pairs
   into Smart Life directly (hold the WiFi button until it blinks). You get
   `fan.*`, `sensor.*_pm25`, `switch.*` in HA; the `home` view will show the
   PM2.5 once the entity exists (`sensor.*pm25*`).
3. **Hisense AC ×2** already report `_electricity` (mA) and `_daily_energy`
   via ConnectLife; nothing to do. They read 0 W when off — expected.

Do **not** re-run `-AddTuya`; the existing config entry polls the account
and new devices show up on their own. If one does not, Settings → Devices →
Tuya → ⋮ → Reload.

### Health view (Samsung Health → Health Connect → HA companion) — 2026-09-16

`health` reads `sensor.dragos_s_s25_ultra_<metric>` — the Health Connect
sensors of the HA companion app (2026.6.5), all enabled in Companion app →
Manage sensors → search "health". This HA server is on **US units**, so the
companion publishes ft / g / inHg / fl oz; `healthReadings()` in
`src/lib/turzx/feeds.ts` converts to metric — never convert in the renderer.
Options: `stepsGoal`, `sleepGoalH`, `device` (entity slug).

What was actually found on the phone (adb serial **RZCYA0LJ0NZ**; the other
serial is an old A51):

- Samsung Health has read **and write** grants for every Health Connect
  category, yet Health Connect held only the phone pedometer's steps. Samsung
  Health showed 0 steps and "not synced in 3 days" (that banner is Samsung
  _Cloud_, WiFi-only). Galaxy Watch3 (B827) is connected, 100 % battery,
  plugin `com.samsung.android.gearnplugin` present — so the gap is between
  the watch and Samsung Health, not between Samsung Health and HC. Wearing
  the watch for a day and opening Samsung Health once fills HC; until then
  `heart_rate`, `sleep_duration`, `oxygen_saturation` stay `unknown` and the
  view shows dashes.
- OKOK scale app (`com.chipsea.btcontrol.en`) has **no** Health Connect
  permissions; its weight never reaches HA. Samsung Health → Settings →
  Accessories lists only Samsung/Xiaomi scales, so the BT-direct route is
  closed for this scale. Options: type weight in Samsung Health, or a BLE
  bridge (openScale / ESPHome `xiaomi_miscale`-style sniffer on the office
  Bluetooth proxy) — the scale broadcasts weight as BLE adverts while you
  stand on it.
- A `HealthConnectPermissionActivity` exists but is not exported; the sensors
  can only be toggled in-app. Everything else (HC home, app access) opens
  with `am start -a android.health.connect.action.HEALTH_HOME_SETTINGS`.

### Copilot signals on the phone

`/api/copilot/event` posts into the **notification centre** (`lib/notify`,
see the 2026-09-19 section) — the HA Companion is only the 20 s fallback now:

- one card per **session** (`kind: copilot`, `tag: copilot-<session>`): title
  per event, subtitle `project · chat title`, indigo, `ask` is high
  priority and `sticky` until the next tool call clears it by tag. The card's
  URL and its single button open `codai://session/<vscode session id>` — the
  same session mirrored into the codai gateway by the hook (below).
- one silent summary card (`kind: agents`, `tag: copilot-agents`): active
  sessions from the local VS Code session stores — repo, profile, turns
  today, last request — refreshed on every event, cleared when idle.
- both respect quiet hours (23:30–07:30 by default) unless the kind has
  „Trece peste ore liniște” on.

The companion-notification lesson still stands for the fallback path:
`persistent: true` is deliberately not used — the companion refuses
`clear_notification` on persistent cards (verified with
`adb shell cmd notification list`, which shows the _live_ set; `dumpsys
notification` includes history and lies).

**codai mirror.** `~/.copilot/hooks/lib/copilot-signal-send.ps1` also does,
per `ask`/`done`: `POST https://ai.codai.ro/v1/sessions {session_key:<vscode
session id>, title:"project · chat"}` → claim lease (`force`) → `POST
…/events` (`ask` with the question headers, or `turn_end`) → release. Key =
DPAPI file `~\.codai\copilot.key` (from `scripts/ops/copilot-codai.ps1`);
device id persisted in `~\.codai\hook-device.txt` (platform `agent`). No
key = no mirror, vmui delivery unaffected. The phone (`ro.codai.phone`
≥ build 2026-09-19) replays the events when it opens a session it has no
local rows for, so the link lands on the question; answering still happens in
VS Code (there is no reverse channel into the Copilot chat).

The desk card and the phone card carry the project (cwd leaf, exactly the
VS Code taskbar title) and the chat tab title, read by
`~/.copilot/hooks/copilot-signal.ps1` from the first 64 KB of
`workspaceStorage/*/chatSessions/<session_id>.jsonl` (`customTitle`).

## Nest Hub kiosk (2026-09-18)

The bedroom Nest Hub (`media_player.bedroom_smart_display`, 192.168.100.45,
1024×600, Fuchsia Chrome 150, Mali-G31) shows a vmui web page instead of the
Google photo frame. The page is `/display?k=<ESP_DISPLAY_TOKEN>`, served by the
Pi and cast with DashCast via `catt` (pipx on homepi, `~/.local/bin/catt`).

- **Two modes.** _Idle_ rotates the panels enabled in
  `/home?tab=settings&section=nestHub` (clock, casă, muzică, fotografie, nutriție, PC, Pi, calendar, BNR,
  crypto, vreme) over a Ken Burns slideshow (Met / Art Institute / APOD, the
  Turzx fetchers). A touch opens _home_: rooms as tabs, device tiles with inline
  control (lights, AC, TV, Hub, apă, ambilight, scene), back to idle after
  `idleAfterSec` without a touch. Music takes the whole screen while playing.
- **Touch detection.** DashCast gives the page real pointer events, so the
  page itself flips mode. It also mirrors the state into
  `input_boolean.nest_hub_idle` (package `pi/ha-packages/vmui_nest_hub.yaml`;
  after deploying a new package call `homeassistant.reload_all` — pi-deploy
  only copies the file). `/api/display/state` exposes it as `hubIdle` so a
  wake from elsewhere (automation, physical button) also lands on home.
- **Keep-alive.** The Hub drops a cast site after ~10 min without a media
  session and after every reboot. `pi/hub-cast.py` (unit `hub-cast`, log
  `/srv/homepi/logs/hub-cast.log`) polls HA every 20 s and recasts only when the
  Hub shows nothing of ours and nothing the user started (YouTube, Spotify,
  Lovelace). Toggle with `cast.keepAlive` / `cast.respectPlayback` in the card.
  **Stop it (`sudo systemctl stop hub-cast`) before casting a debug URL by
  hand** — otherwise it races you and recasts the plain page.
- **Root layout.** `proxy.ts` sets `x-vmui-kiosk: 1` for `/display`; the root
  layout then renders a bare `<html>` — no sidebar (which prefetched ~30 routes
  on the Hub), palette, SW, realtime. `next.config.ts` widens `img-src` to
  `https:` on `/display` only, for the museum CDNs.
- **Perf, measured on the Hub** (`?perf=1` posts a 60 s rAF sample to
  `audit_log` as `display.probe`; read it with a `better-sqlite3` one-liner
  from `/srv/homepi/vmui`, `sqlite3` is not installed there):
  - baseline, empty page: 60 fps; 4 long tasks at load (hydration, 270 ms max)
  - photo layer as it was — `background-image` div at `inset:-4%`,
    `will-change: transform, opacity`, scale+translate keyframes: **44 fps flat**
    with or without the animation, with or without the panel on top
  - same photo as a 100 % `<img>` with `object-fit: cover`, scale-only Ken Burns
    from a corner `transform-origin`, no `will-change`: **59–60 fps**, idle and
    home mode alike. The oversized layer was the whole cost; `filter:
brightness()` on the root and `backdrop-filter` on the plate were suspects
    that changed nothing (removed anyway — a black overlay dims night for free).
  - heap ≈10 MB; polls: 3 s idle, 2 s while music plays, 10 s at night.
    Debug flags on the URL: `bare` (photo only), `nokb`, `nophoto`, `noveil`,
    `notext`, `static`, `home` (hold the home screen).

  ## Family access (2026-09-20)

  Everything under `/home` is gated by `src/lib/home/access.ts`, not by
  `users.role` (that one only governs the VM control plane). `home_members`
  rows carry a family role — `owner | adult | child | guest` — and per-room
  grants `{ [roomId]: "view" | "control" }`; an infra `admin` with no row is
  treated as owner. Server actions use `requireEntityControl(entity)` for
  device actions, `requireOwner()` for settings, layout and family management,
  `requireDoorAccess()` for the intercom (owner + adult), `requireHomeActor()`
  otherwise; queries and the SSE stream filter through `visibleEntities(actor)`.
  Identity-less shared-token callers (ESP32, Nest Hub, HA) resolve to the owner;
  a paired phone acts as the member in `paired_devices.user_id`. Nutrition
  (meals, hydration, `nutrition_profiles`) is per `user_id`. Members join via
  `/invite/<token>` (`src/lib/home/family.ts`) or an account the owner creates;
  the UI is `/home?tab=settings&section=family`.

## Phone app + device pairing (2026-09-19)

`apps/desktop` also builds the Android app; details in
[apps/desktop/README.md](../apps/desktop/README.md#android). What lives on
the Pi for it:

- `/etc/avahi/services/vmui.service` — mDNS `_vmui._tcp` on :3737 so the app
  finds the Pi without an address (`pi/avahi-vmui.service`, via pi-deploy).
- `GET /api/discover` (open) → `{app:"vmui", host}`; `POST /api/devices/pair`
  (open, 10/min/IP) → pending row + 4-digit code; `/api/devices` (session,
  approved device, or shared token) lists / approves / rejects / revokes.
  Table `paired_devices`; audit actions `device.pair.*`, `device.revoke`.
- Approvals show up in **/home → Notifications → Dispozitive împerecheate**
  (`/home?tab=notifications`; long-poll, sonner toast), in the desktop tray
  (toast + submenu) and on paired phones. The approver binds the device to a
  family member (`paired_devices.user_id`, themselves by default); an
  approval through the shared token leaves it unbound — rebind it from
  the Family section (`/home?tab=settings&section=family`).
- `sensor.vmui_pc_agent` (MQTT, `vmui_pc.yaml`) mirrors the PC tray agent;
  `/api/desktop/pc` publishes `vmui/pc/cmd` through `mqtt.publish`.
  Trap hit while wiring it: the broker's `homepi` password and HA's mqtt
  entry had drifted from `MQTT_PASS` in credentials.env (29 vs 28 bytes —
  a trailing CR from an earlier ssh pipe). Fixed with
  `mosquitto_passwd -b` + patching `.storage/core.config_entries`
  (`.bak-mqtt2`), password moved as base64. `MQTT_HOST` in credentials.env
  is the OLD .230 address; the agent uses the Pi's IP directly.
- `/etc/sudoers.d/vmui` lets vmui (`dragos`) restart the home-stack units for
  the phone's Pi page; nothing else.
- `/srv/homepi/vmui/public-apk/vmui.apk{,.json}` — latest signed APK for
  in-app updates (`scripts/android-release.ps1`).

## Notification centre (2026-09-19)

Everything that used to be an HA Companion push (SmartLife-era) now goes
through one place: `src/lib/notify` on the Pi, table `home_notifications`,
settings row 6 of `turzx_settings` (`lib/notify/settings.ts`).

**Sources** (`kind`): `copilot`/`agents` (`/api/copilot/event`), `intercom`
(`lib/home/intercom.ts` — Răspunde și deschide / Ignoră), `pairing`
(`lib/devices/pairing.ts` — Aprobă / Respinge, code in the button body),
`water` / `pc` / `pi` / `door` / `window` / `presence` / `battery`
(`lib/notify/watchers.ts`, started from `/api/turzx/state` next to the
activity feed), `system` (anything else, e.g. tests). Buttons are dispatched
by `lib/notify/actions.ts` — the only place that knows what `add250` or
`restart-turzx` mean.

**Delivery**, in this order:

1. `upsert` on the in-process bus → SSE `GET /api/notify/stream` → the web
   /home Notifications tab (`components/home/notify-card.tsx`), the desktop tray
   (`apps/desktop/src-tauri/src/notify.rs` → Windows toast with up to 3
   buttons via `tauri-winrt-notification`, AUMID registered under
   `HKCU\Software\Classes\AppUserModelId\ro.dragoscatalin.vmui` at start —
   unpackaged exes get no toasts without it) and any open app.
2. FCM **data-only** message to every approved device with a `push_token`
   (`lib/notify/fcm.ts`, HTTP v1, service account
   `.private/fcm-service-account.json`, Firebase project `vmui-home`). The
   Android app renders it natively (`PushService` → `Notifier`), with the
   webview dead; buttons are `NotifyActionReceiver` → `POST /api/notify/act`.
3. Whoever shows the card acks it (`POST /api/notify {op:"ack"}` →
   `deliveredTo`). If nobody acks a `high`/`urgent` card within 20 s and
   `haFallback` is on, the old HA Companion path fires (`fallbackAt`), with
   `NOTIFY_<id>_<action>` buttons handled in `lib/esp/activity.ts`.

**API** (device bearer, session cookie or `?k=` shared token):
`GET /api/notify[?all=1]`, `POST /api/notify {op: read|dismiss|dismissAll|ack|
create}`, `POST /api/notify/act {id, action}`, `PUT /api/notify/token`,
`GET|PUT /api/notify/settings`, `GET /api/notify/stream` (SSE). Quick test:

```powershell
$tok = ((Get-Content .private\credentials.env | ? { $_ -match '^ESP_DISPLAY_TOKEN=' }) -replace '^ESP_DISPLAY_TOKEN=', '').Trim('"')
curl.exe -s -X POST "http://192.168.100.232:3737/api/notify?k=$tok" -H 'content-type: application/json' -d '{"op":"create","card":{"kind":"system","title":"Test","priority":"high","actions":[{"id":"ok","label":"OK"}]}}'
```

**Traps measured on 2026-09-19**

- Settings rows in `turzx_settings` collided (nutrition and display both 4,
  copilot and buttons both 3) — saving one silently overwrote the other. Now:
  1 turzx, 3 copilot, 4 display, 5 nutrition, 6 notify, 7 buttons. Moving a
  row id resets that feature to defaults on the Pi.
- `tauri-plugin-notification` has no buttons; `tauri-winrt-notification` 0.8
  has `add_button`/`on_activated`/hero/progress but no remove-by-tag.
- With Windows Focus Assist / DND on, toasts go straight to the notification
  centre (Win+N) — `LastNotificationAddedTime` under
  `HKCU\…\Notifications\Settings\ro.dragoscatalin.vmui` proves delivery.
- `adb shell am broadcast` cannot reach `NotifyActionReceiver`
  (`exported=false`); test buttons by expanding the shade and tapping.
- Firebase: enabling `firebasecloudmessaging.googleapis.com` fails (not a
  service); `fcm.googleapis.com` + role `roles/firebasecloudmessaging.admin`
  on the sender SA is all that is needed.

## Backups

`ha backups new` inside the appliance, or Settings → System → Backups. The
Samba add-on exposes `\\192.168.100.232\backup` so snapshots can be copied to
the host. Credentials are in `.private/credentials.env` (`HA_SAMBA_PASS`).

## Files

- `scripts/homeassistant.ps1` — build/start/stop/status, host-SSH enablement
- `scripts/ha-configure.ps1` — add-ons, proxy trust, Tailscale, custom domain
- `scripts/tailscale-home.ps1` — personal-tailnet ACL, auth keys, device list
- `scripts/scan-smart-devices.ps1` — ARP + mDNS + SSDP + Bluetooth inventory
- `scripts/zigbee-bridge.ps1` — USB coordinator over TCP
- `scripts/ambilight.ps1` — HyperHDR instances, logon tasks, HA scenes, modes
- `ambilight/` — bridges (`bridges.py` hosts `dxlight_bridge.py` + `openrgb_bridge.py` in one process), layout
  helper, `ha-scenes.yaml` package, WLED upgrade notes
- `scripts/vmui-service.ps1` + `vmui-service-run.mjs` — production vmui task
- `scripts/publish-vmui.ps1` — DNS + certificate + Caddy for mui.dragoscatalin.ro
- `scripts/esp32-display.ps1` + `esp32/home-display.yaml.tmpl` — ESP32 OLED firmware
- `src/lib/esp/` — framebuffer, 5x7 font, views, gallery, activity feed
- `src/app/display/` — Nest Hub kiosk (page, client, CSS); `src/lib/display/` — settings;
  `src/components/home/display-card.tsx` — the `/home` card; `pi/hub-cast.py` + `.service` — cast keep-alive
- `ambilight/tray.py` — tray icon; `scripts/hidden-run.vbs` — window-less task launcher
- `infra/tailscale-home-acl.hujson` — tailnet policy (source of truth)
