# Vatra firmware

ESPHome firmware for Vatra displays and buttons. ESPHome is pinned to `2026.10.2`. Every unit of a board runs the same build: no WiFi credentials, API key or hub address are compiled in. Licence: MIT ([LICENSE](LICENSE)).

## Images

The image id is the contract: the hub serves firmware by id.

| id | board | chipFamily | what it does |
| --- | --- | --- | --- |
| `vatra-display-oled` | ideaspark ESP32 + SSD1306 128x64 (I2C 0x3C, SDA 21, SCL 22, BOOT GPIO0) | ESP32 | Shows the hub-rendered 1-bit BMP `GET <hub>/api/esp/display/<node>` every 5 s. BOOT click sends single/double/long. |
| `vatra-display-s3` | Guition ESP32-S3-4848S040 (480x480 ST7701S, GT911, 16 MB, octal PSRAM) | ESP32-S3 | LVGL screen: clock, lights on, water ml / target with a +250 ml button, ambilight mode and a status line, from `GET <hub>/api/esp/display/<node>/summary` every 10 s. |
| `vatra-button-atom` | M5Stack Atom Lite (button GPIO39, SK6812 GPIO27) | ESP32 | Desk button (`btn=desk`) and Bluetooth proxy. LED: blue pulse = not adopted, green = hub took the click, red = it did not. |
| `vatra-button-c3` | ESP32-C3 SuperMini (BOOT GPIO9, LED GPIO8, both active low) | ESP32-C3 | Same as the Atom. LED: slow blink = not adopted, long flash = ok, fast blinks = error. |

`<node>` is the device name: `vatra-display-xxxxxx` or `vatra-button-xxxxxx` (the last 3 bytes of the MAC). Files: [common/vatra-base.yaml](common/vatra-base.yaml) is shared by every image in [images/](images/).

## Flashing a new unit

In the Vatra hub, go to **Devices > Add**. It flashes with ESP Web Tools from each image's `manifest.json`. Web Serial needs Chrome or Edge, and the page must be served over https or from localhost. After flashing, Improv over serial sets WiFi in the same dialog. Two other ways to set WiFi:

- **Fallback hotspot**: with no known network the unit opens a hotspot named after the device, with a captive portal.
- **BLE Improv** (buttons only): press the button to authorise.

The OLED board has no BLE Improv: the BLE stack costs ~50 KB of heap on a board with no PSRAM.

Not adopted yet, the screens show "Vatra", "Devices > Add" and their IP address.

## Adoption contract (local web_server, port 80)

Adoption runs through internal entities. Home Assistant never sees them; the web server exposes them because it is set to `include_internal: true`.

| call | effect |
| --- | --- |
| `POST http://<ip>/text/Vatra%20hub/set?value=http%3A%2F%2F<hub>` | Stores the hub base URL (no trailing slash). Accepted only while the unit is not adopted, and only for `http://` or `https://` URLs. |
| `POST http://<ip>/text/Vatra%20token/set?value=vmd_...` | Stores the token, saves both values to flash and applies them. Accepted only while not adopted, after the hub is set, and when the value starts with `vmd_`. Reading this entity always returns an empty string. |
| `GET http://<ip>/text_sensor/Vatra%20firmware` | `{"state":"<image id>@<version>"}`, e.g. `vatra-display-oled@0.0.0-dev` |
| `GET http://<ip>/text_sensor/Vatra%20adopted` | `{"state":"yes"}` or `{"state":"no"}` |
| `POST http://<ip>/button/Vatra%20update/press` | Runs the update check now. |
| `GET http://<ip>/text/Vatra%20hub` | The current hub URL. |

Order: set the hub, then the token, then poll `Vatra adopted` until it reads `yes`. A wrong value is refused silently, so check the state afterwards. Once adopted, the hub and token cannot be changed over the network.

**Forgetting adoption is physical only.** Hold the board's button for 10 s: the unit clears the hub and token, saves to flash and reboots. On the S3 display, which has no button, hold a finger on the screen for 10 s. Nothing over the network can do this.

Every request to the hub carries `Authorization: Bearer <token>`:

- `POST <hub>/api/esp/button?node=<node>&click=single|double|long[&btn=desk|water]`. A 2xx answer counts as success.
- `GET <hub>/api/esp/display/<node>` returns a 128x64 1-bit BMP (OLED).
- `GET <hub>/api/esp/display/<node>/summary` returns `{"time":"21:07","lightsOn":3,"water":{"ml":750,"target":2000},"ambilight":"movie|music|off|--","status":"text"}`. Answers up to 2 KB.

## OTA contract

When adopted, a unit checks for updates 2 min after boot, every 6 h, and whenever `Vatra update` is pressed:

1. `GET <hub>/api/firmware/<image id>/version` returns plain text, e.g. `1.2.0`. Whitespace is trimmed; longer than 48 chars is ignored.
2. If that differs from the running version, the unit runs `ota.http_request.flash` with `url <hub>/api/firmware/<image id>/ota.bin` and `md5_url <hub>/api/firmware/<image id>/ota.md5` (32 lowercase hex characters). On an md5 mismatch the unit keeps its old firmware.

The hub serves the files from `firmware-dist/<id>/`: `<id>-<v>.ota.bin` and `<id>-<v>.ota.md5`. The md5 is also in `manifest.json` → `builds[0].ota.md5`. ESPHome's own OTA (`platform: esphome`, no password) stays available for Home Assistant. API encryption is `encryption: {}`: Home Assistant provisions the key at runtime.

## Building

```bash
bash firmware/build.sh                       # every image
bash firmware/build.sh vatra-button-c3       # one image
VERSION=1.2.0 bash firmware/build.sh         # default: 0.0.0-dev+<git sha>
```

The script creates `firmware/.venv` with `esphome==2026.10.2` and compiles each image, attempting every one before exiting non-zero on any failure. It writes:

```
firmware-dist/
  index.json            [{"id","version","chipFamily","project"}]
  SHA256SUMS
  <id>/manifest.json    ESP Web Tools manifest, paths relative to it
  <id>/<id>-<v>.factory.bin   offset 0, for a new unit
  <id>/<id>-<v>.ota.bin
  <id>/<id>-<v>.ota.md5
```

`manifest.py --index firmware-dist` rebuilds `index.json` and `SHA256SUMS` and checks every md5.

On the workstation, do not compile locally. Build in the cloud:

```powershell
node scripts/e2e-cloud/run.mjs --plain --machine n2-standard-16 --max-run 2h --cmd 'bash -n firmware/build.sh && bash firmware/build.sh' --fetch firmware-dist
```

The results land in `.copilot-tmp/e2e-cloud/<runId>/firmware-dist`. CI ([.github/workflows/firmware.yml](../.github/workflows/firmware.yml)) builds on every push to `main` that touches `firmware/`, and on `v*.*.*` tags, where it attaches `vatra-firmware-<version>.tar.gz` to the release.
