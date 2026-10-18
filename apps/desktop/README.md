# Vatra desktop (vmui) — tray + control window

Tauri 2 (Rust) + React 19 + Tailwind v4. One tray icon (the Vatra mark) whose
state is the health of the home stack, and a native window to configure
everything that used to need the browser. Product name / window title is
**Vatra**; the binary stays `vmui-desktop.exe` (`mainBinaryName`) because the
`vmui-tray` task and its watchdog launch it by that name.

Brand: `src/app.css` imports the generated tokens and logo motion from
`brand/dist/css/vatra-{theme,motion}.css` (repo root, allowed in
`vite.config.ts` `server.fs.allow`) and maps the desktop's older names onto
them. Dark by default; Settings → Theme = System / Dark / Light (localStorage
`vatra:theme`). Tray icons: `src-tauri/icons/tray/tray-{ok,warn,down,active}-{dark,light}-32.png`
(picked from `HKCU\…\Themes\Personalize\SystemUsesLightTheme`; `active` =
health ok and any registry light on).

Cold start: the window is created hidden; `index.html` paints an inline splash
(brand background + mark intro), `main.tsx` fetches `lang_get` and `app_info`
in parallel, renders, then calls `app_ready` after two frames. Rust shows the
window (never on a `--hidden` start; a 4 s safety timer shows it if the call
never comes) and appends `cold_start_ms=<n> render_ms=<n> process_ms=<n> hidden=<bool>`
to `.copilot-tmp/service-logs/desktop.log`. The splash mark then morphs into
the title-bar mark. Replaced `ambilight/tray.py` (pystray) on
2026-09-19; the Task Scheduler entry `vmui-tray` now runs
`src-tauri/target/release/vmui-desktop.exe --hidden` at logon.

The same crate is the **Android app** (`ro.dragoscatalin.vmui`, 2026-09-19):
`#[cfg(desktop)]` = tray + local stack, `#[cfg(mobile)]` = window only,
everything proxied to the Pi's vmui with a per-device token. Same React UI,
bottom tabs under 768 px.

## Android

```powershell
pwsh -File scripts\android-release.ps1 -Install     # build signed APK, publish on the Pi, adb install
pwsh -File scripts\android-release.ps1 -SkipBuild   # re-publish the last build
pwsh -File scripts\android-release.ps1 -NoPublish   # build + verify, nothing uploaded
cd apps\desktop; pnpm exec tauri android dev        # live reload on the connected phone
```

- **JDK 21.** AGP 8.11 / Kotlin 1.9 cannot build with the Android Studio JBR (JDK 25). The release script picks JDK 21 by itself (`VMUI_JAVA_HOME`, `JAVA_HOME`, then a Microsoft / Temurin JDK 21 install); for `tauri android dev`, first run
  `$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot'`.
- Signing: `.private/android-release.jks` + `android-keystore.properties`
  (gitignored; `gen/android/app/build.gradle.kts` reads it). Lose the keystore
  and the phone will refuse the next update — back it up.
- **Pairing** (no address, no token typed): the app browses mDNS
  `_vmui._tcp` (avahi advert on the Pi, `pi/avahi-vmui.service`) and probes
  `homepi` / `homepi.local` / the LAN IP, then `POST /api/devices/pair` →
  `{id, token, code}`. The 4-digit code shows on the phone; approve it from
  **vmui web → Home → Notifications**, the **desktop tray/window** (Windows toast +
  "Dispozitive noi" submenu + banner) or **another paired phone** (banner). Or
  sign in with the vmui account on the phone → approved at once. Tokens are
  `vmd_…`, stored hashed in `paired_devices`, revocable from any of those
  places; `espAuthorized()` accepts them as `Authorization: Bearer` / `?d=`.
  Approving from the web binds the device to a family member
  (`paired_devices.user_id`, the approver by default); approving through the
  shared token (tray, another phone) leaves it **unbound** — it then acts as
  the owner until it is rebound from Home → Settings → Family.
- From outside the house it is the same URL over Tailscale (the Pi is a subnet
  router for 192.168.100.0/24).
- **PC from the phone**: `POST /api/desktop/pc` on the Pi publishes to MQTT
  `vmui/pc/cmd`; the desktop tray (`src-tauri/src/agent.rs`) executes the
  fixed verbs and publishes `vmui/pc/state` retained → `sensor.vmui_pc_agent`
  in HA (`pi/ha-packages/vmui_pc.yaml`). Commands older than 60 s are dropped.
- **Pi page** (mobile "Pi" tab): `GET/POST /api/desktop/pi` — systemd units,
  containers, temp/throttle, logs; restarts need `/etc/sudoers.d/vmui`
  (`pi/sudoers-vmui`, installed by pi-deploy).
- **Self-update**: `android-release.ps1` puts the APK at
  `/srv/homepi/vmui/public-apk/`; the app compares `versionCode` with
  `GET /api/desktop/apk?meta=1` and offers the download (browser → package
  installer verifies the signature). Version lives in `tauri.conf.json`,
  `package.json`, `Cargo.toml` — bump all three.
- **Shortcuts** (long-press icon): Film / Stins / Apă +250 / PC — `ActionActivity`
  - `res/xml/shortcuts.xml`. **Widget**: temperature · lights · water with a
    +250 ml button (`VmuiWidget`, classic RemoteViews). Both read the pairing
    from `<dataDir>/conn.json` (Tauri's `app_data_dir()` = `Context.getDataDir()`).
- **Notifications**: FCM data-only messages from the Pi (`lib/notify/fcm.ts`,
  Firebase project `vmui-home`; `gen/android/app/google-services.json` is
  gitignored — `firebase apps:sdkconfig android` regenerates it). `PushService`
  renders the card natively (`Notifier`: colour disc per kind, big picture,
  progress, up to 3 buttons, full-screen intent for `urgent`) and acks it so
  the HA fallback stays quiet; `NotifyActionReceiver` runs buttons via
  `POST /api/notify/act`, opens `url` buttons (e.g. `codai://session/<id>`)
  or falls back to our own `vmui://notifications/<id>`. The token is
  re-registered with `PUT /api/notify/token` on every resume while paired.
  Nothing here needs the webview alive.
- Test on the **A51** (`adb -s R58N94BMLJY`), not the S25 (daily phone).
  WebView nodes are invisible to `uiautomator dump`; drive it with
  `adb shell input tap x y` + `screencap`.
- No TLS in the Rust HTTP client on purpose (`ureq` without `rustls`) — the
  Pi is plain http; it also keeps `ring` out of the NDK build, which failed
  with `'assert.h' file not found`.

## Pages

| page       | talks to                                                                                     | does                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Ambilight  | HyperHDR JSON-API (ws :8090), `ambilight/settings.json`, `scripts/ambilight.ps1 -Configure`  | modes (HA scripts), capture toggle, per-instance effect/colour, idle colours, wall compensation, smoothing, HDR  |
| Casă       | vmui `/api/display/state` + `/api/display/control` (Pi)                                      | rooms → device tiles (tap = toggle, ⋯ = sheet), scenes, water                                                    |
| Ecrane     | vmui `/api/desktop/settings` (Pi)                                                            | Nest Hub + Turzx settings, same schemas as the `/home` cards                                                     |
| Sistem     | the tray's `health` event (task states), `.copilot-tmp/service-logs/*.log`                   | start/stop/restart every `vmui-*` task, tail logs                                                                |
| PC         | `scripts/pc-action.ps1` (fixed verbs), autostart plugin                                      | lock / display off / sleep / volume / maintenance verbs, autostart toggle                                        |
| Notificări | vmui `/api/notify*` (Pi); desktop via `notify_*` commands over the SSE stream in `notify.rs` | active / history / settings (quiet hours, per-kind on/off + break-quiet, FCM, HA fallback, water nudge, battery) |

The bell in the title bar (desktop) / header (mobile) carries the unread
count. On Windows every new card is also a native toast with buttons
(`tauri-winrt-notification`); tapping the body opens the card's `url` or
the Notificări page.

Credentials come from `.private/credentials.env` (HA_URL, HA_TOKEN,
HYPERHDR_ADMIN_PASS, ESP_DISPLAY_TOKEN). The repo root is found by walking up
from the exe until `ambilight/tray.py` exists; override with `VMUI_ROOT`.

## Build

```powershell
pnpm install                         # workspace root
cd apps\desktop
pnpm exec tauri build                # ~2–4 min; exe + NSIS under src-tauri/target/release
```

The running instance locks the exe: `Stop-Process -Name vmui-desktop` first,
then `schtasks /run /tn vmui-tray` to start the new build hidden.
The `vmui-tray` task also fires every 5 min as a watchdog and will relaunch the
old exe mid-build (`Access is denied (os error 5)`): rename
`target\release\vmui-desktop.exe` to `.old` before `tauri build` (a running exe
can be renamed, not overwritten).

## Test without taking the screen

`pnpm dev` then open `http://localhost:1430/?mock=1&k=<ESP_DISPLAY_TOKEN>` in a
browser: `src/mock.ts` answers `invoke()` for the Rust commands and proxies
vmui calls to the Pi through vite (`/vmui`). Anything that goes to
`/api/display/control` hits REAL devices — route it to a stub in Playwright
(`page.route('**/vmui/api/display/control*', …)`) before clicking tiles.

## Polling budget

- Tray health loop: ONE `schtasks /query /fo csv /nh` for all tasks + 3 HTTP
  checks, every 15 s while the window is visible, 60 s while it is in the tray.
  The result is cached (`health` command returns it; `health(fresh=true)`
  re-checks) and pushed as the `health` event; the Sistem page reads it.
- Rust emits `visibility` when the window shows/hides; `usePoll` /
  `useInterval` (src/lib.ts) only tick while the page is shown AND the window
  is visible, and show a stale badge when a refresh failed over old data.
- Visited pages stay mounted (hidden); Casa and PC share one
  `/api/display/state` poll (`pages/display-state.ts`).
- Notifications SSE (`notify.rs`): reconnects after 60 s without a byte (the
  Pi pings every 25 s).

## Gotchas

- `tauri-plugin-window-state` restores visibility and defeats `--hidden`;
  the plugin is built without `StateFlags::VISIBLE` and `setup()` hides
  explicitly when the flag is present. A normal start is shown by `app_ready`
  (or the 4 s fallback), never by `setup()`.
- Closing the window hides it (`CloseRequested` → `prevent_close`). Quit only
  from the tray.
- Casa tiles are real `<button>`s; the ⋯ settings button is a sibling
  positioned over the tile (no nested buttons).
- Use `confirmDialog()` (src/ui.tsx, `<ConfirmHost/>` is mounted in the
  shell), not `window.confirm()`.
- Windows drops toasts from an exe with no AppUserModelID. `notify::run`
  registers `HKCU\Software\Classes\AppUserModelId\ro.dragoscatalin.vmui`
  (name + icon) and calls `SetCurrentProcessExplicitAppUserModelID` before
  the first toast. With Focus Assist on they land in Win+N only.
- `opener:default` only allows http/https/mailto/tel; `codai://` and
  `vmui://` are in `capabilities/default.json` explicitly.
