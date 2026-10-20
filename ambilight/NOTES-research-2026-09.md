# Ambilight / multi-target RGB research (2026-09-12, verified via web)

- DX Light wedge `hid_write ... (0x3E5) Overlapped I/O operation is in
  progress` (only replug fixes): every death sat on a frame BURST (idle->
  film, movie mode ON) at 60 distinct frames/s x 6 reports = 360 HID
  reports/s -> firmware buffer overflow, endpoint stops ACKing. Fix
  (2026-09-16, 55a75e5): dedupe identical frames, cap 30 fps, 1.5 ms gap
  between reports, log slow writes; HyperHDR instance 0 smoothing at 30 Hz.
- HyperHDR JSON `setconfig` with a PARTIAL config on a long-running
  instance hung the whole web/WS server (HTTP + WS timeouts, LED output
  still running) AND wiped instance 0 to the default (leds=1, device=file).
  Recovery: restart task vmui-ambilight-hyperhdr, then
  `scripts\ambilight.ps1 -Configure` (full rewrite). Don't do partial
  setconfig; after any HyperHDR restart re-check SYSTEMGRABBER per instance.

## Idle flash + white case (2026-09-14, vmui ambilight/)
- Short flash on every idle transition = HyperHDR sends ONE all-black frame
  when it switches the LED device off, then goes silent. Bridges applied it
  (lit→black→20 s→fade red). Fix: `IdleGate` in dxlight_bridge.py drops a
  black frame that follows real content; fades in/out of idle.
- Case LEDs "mostly white" during dark scenes = region average of a dark
  picture is desaturated grey. `ambient()` in openrgb_bridge.py: saturation
  boost + luma gate (off <0.12, full 0.35) + grey attenuation.
- Latency: stripSmoothMs 300→150, glowSmoothMs 1500→700 (settings.json).
- OpenRGB 1.0 breaks D_LED strips on Z790 AORUS ELITE (zones 0 LEDs, strobe);
  stay on 0.9 (`.copilot-tmp/orgb-downgrade.ps1`).
- Copilot signals: `~/.copilot/hooks/copilot-signal.ps1` → vmui
  `/api/copilot/event` (needs `/api/copilot` in proxy.ts PUBLIC_PREFIXES) →
  HA `script.copilot_{ask,clear,done,blocked,failed}` via `script.turn_on`
  (direct service call blocks until the looping script ends → timeout).
- "Lights flash fast on a Copilot notification, others animate smoothly"
  (2026-10-20). NOT the OpenRGB case path: HA notify_flash on the case
  measured a clean 0.6 s ramp (HyperHDR smoothing 700 ms), and Copilot
  events never reach OpenRGB. Copilot -> `notify_fx.py` on the DX strip:
  blocked/failed were hard 0->255 blinks and `ask` a runner with a hard
  edge, max step 254/255 in one 30 fps frame; the strip cut in/out of the
  picture with no blend. Fix: raised-cosine envelopes, softer runner, fade
  in 0.5 s / out 0.8 s against the live frame (`Animator.base`), `clear`
  fades instead of cutting. Gate: `ambilight/test_notify_fx.py` (max 40 per
  frame; old code 254-255 -> red).

## "Something duplicates the case LEDs" — two DIFFERENT causes (2026-09-14)
1. OpenRGB **Effects Plugin** profile with `AutoStart=true` (found by the
   ambilight agent; `ambilight.ps1 -Configure` disarms it).
2. OpenRGB **1.0 installer registers a Windows service** "OpenRGB SDK Server"
   (`sc query OpenRGB`, LocalSystem, session 0, port 6742) — appeared at the
   winget upgrade 13:56. It opened the same AORUS D_LED/GPU controllers as the
   `vmui-ambilight-openrgb` task instance → two writers. Discriminator:
   `Get-Process OpenRGB` shows TWO pids, one with SessionId 0 and parent
   services.exe. Fix (admin): `Stop-Service OpenRGB; Set-Service OpenRGB
   -StartupType Disabled`. `ambilight.ps1 -Status` now warns.

- DX Light / QuikLight USB strip = ROBOBLOQ HID VID 1A86 PID FE07. Per-LED
  protocol reverse-engineered in shim80/hypr-quicklight (+ fork
  Hedriel/rgb-controller, C++/hidapi): 64-byte HID reports (report id 0),
  init = 'RB' cmds (147 openUrl, 135 brightness, 134 sectionLED
  {1,85,85,85,65,66,0,0,0,254}), frame = 'SC' + len16 + msgid + 128 +
  per-LED {n, r, g, b, n} + checksum8 (sum&0xFF), chunked in 64B writes.
  eth4n-dev/OpenLights = single-color 'RB 10' variant only.
- Versions seen: HyperHDR 22.0.0 (Aug 2026, Qt6.8, C++20, signed Win
  installer), Hyperion.ng 2.2.1 (Apr 2026, DXGI DDA grabber), WLED 16.0.1
  (Jul 2026), OpenRGB 1.0rc3.1 (Aug 2026, Plugin API 4/5), Prismatik psieg
  fork 5.11.2.31 (Jan 2022, dead).
- HyperHDR has NO OpenRGB output; bridge = HyperHDR e131 (port 5568,
  universe, disableSplitting) -> OpenRGB E1.31 Receiver plugin. HyperHDR
  udpraw default port 5568 in schema (WLED expects 19446/DRGB).
- HA core "hyperion" integration works against HyperHDR only partially
  (multi-instance issues, HyperHDR#32/#118); use tenda96/
  hyperhdr_integration_homeassistant (light + number priority) or JSON API.
- HyperHDR smoothing (verified in source 2026-09-14): HybridRgbInterpolator
  is a spring driven ONLY by stiffness/damping -- `time_ms` is stored but never
  used in the step, so raising it does nothing and the PC glow snapped on every
  cut. ExponentialInterpolator uses time_ms as tau (1-exp(-dt/tau)) -> the only
  type where "slower" is a config knob. updateFrequency schema min is 20 Hz.
- Case LEDs "flash like lightning" on every colour change (2026-09-14):
  first believed HyperHDR smoothing / per-zone commits (fixed both, no change).
  Discriminating test: synthetic 5 Hz ramp straight into OpenRGB still
  flashed -> second writer. Root cause: OpenRGB Effects Plugin profile
  `%APPDATA%\OpenRGB\plugins\settings\effect-profiles\my-profile` had
  Ambient + MovingPanes AutoStart=true at 60 fps on the AORUS board.
  Fix: AutoStart=false (ambilight.ps1 -Configure does it; -Status warns).
  GCC (Gigabyte Control Center) was NOT the culprit — killing it changed nothing.
- Tuya "Smart Monitor Light Bar" (cat dd, Desk Light Bar bf965a68…): HA
  light.turn_on hs_color -> 500, because HA sends `control_data` and the
  firmware answers "type is incorrect". Works: `colour_data` {h 0-360,
  s/v 0-1000} while work_mode=music (cloud enum says only music|white).
  Over LAN the firmware ALSO accepts work_mode="color" (undocumented) —
  use it: "music" keeps the mic live and the bar pulses to room sound. Cloud via
  tinytuya.Cloud(apiRegion='eu'), project vmui-home on platform.tuya.com,
  creds in vmui .private/credentials.env TUYA_ACCESS_ID/SECRET. Free IoT
  Core trial = 1 data centre; link Smart Life account via QR
  (Devices -> Link App Account). Bridge: ambilight/deskbar_bridge.py.
  LAN: local key from Cloud.getdevices()['key'], IP via tinytuya.deviceScan,
  protocol 3.3, DP24 = hex hhhhssssvvvv, ~65 ms/write. TRAP: firmware holds
  ONE TCP session — any parallel status() (even my own verification) evicts
  the bridge's socket, and set_value(nowait=True) then fails silently. Wait
  for the ack and reopen on error; never poll the device while the bridge runs.
  "Lightning"/random green-blue on a single-colour lamp = HUE NOISE on dark
  frames: rgb_to_hsv of near-grey (11,10,3)->(11,19,17) swings 120 deg at
  v~3 %. Fix = freeze hue below chroma (max-min)/255 < 0.10, fade sat. Not a
  smoothing problem; trace the h/s/v actually written before touching tau.
- Daylight gate lesson (2026-09-15): A51 lux sensor lies flat under the
  monitor -> 10 lx at 09:00 on a sunny day, AND it sleeps with the screen
  off so a stale value gets republished looking fresh. Fix: room_is_bright
  = sun>3deg OR fresh lux (lux adds "lamp on at night", never vetoes sun);
  publish sample age (age_min) not post time; stay_on_while_plugged_in=7.
  Also: HyperHDR leaves HA lamps at last frame colour when grabber stops —
  movie_mode_off must turn_off explicitly.
- DX Light "HID write failed" in a loop (1864x) with device Present/OK and a
  single bridge process: the strip's USB controller was hung. pnputil
  /restart-device made it VANISH; only a physical replug fixed it. Do not
  chase software (handles, duplicates) past one bridge restart.
- "Movie mode does nothing / LEDs grey": grabber sees the WHOLE Odyssey;
  a maximized YouTube tab pillarboxes 16:9 into x 440..3000 of 3440.
  Fix = ambilight/video_follow.py (window rect + motion box -> systemGrabber
  crop). HyperHDR `config/setconfig` REPLACES the instance config, it does
  not merge: only-systemGrabber -> device=file, leds=1; systemGrabber+
  device+leds -> smoothing/backgroundEffect/soundEffect/mqtt silently GONE
  (strip "flashes on pause" = unsmoothed cuts). ALWAYS round-trip the full
  getconfig with the changed fields. Check `getconfig` key count (19).
- "HA lamp ignores HyperHDR colour" = LEDDEVICE component disabled on
  inst 2. HyperHDR ProviderRestApi has a HARD-CODED 500 ms timeout
  (TIMEOUT const); one slow HA entity read (BLE light.led_argb, 583 ms) ->
  "408 Timeout" -> device disabled and every retry re-runs the same GET.
  Check `serverinfo.components LEDDEVICE` first; read the reason via
  `logging/start` (no log file on disk). Keep only fast (Tuya/WiFi)
  entities in the HyperHDR lamp list.
- HyperHDR DX11 grabber on 2x 3440x1440 (RTX 3060 Ti, 22.0.0) hands over a
  frame TWO MONITORS WIDE. hardware=true: Odyssey in left half, right half
  black ("right segment dead"). hardware=false: right half = the OTHER
  monitor ("strip white on a black film"). I wrongly "fixed" the first with
  hardware=false and created the second. systemGrabber.crop* is INERT in
  both modes (test pattern, cropRight 100..3440 -> no change). Real fix:
  hardware=true + every `leds` layout squeezed into h 0..0.5
  (Set-LayoutFrame); video_follow rewrites `leds` per instance (group 7).
  Verify with an on-screen R|G|B pattern (.copilot-tmp/pattern.py) and
  `imagestream` column profile (.copilot-tmp/imgpeek.py), never with the
  film -- a paused/black film hides both bugs.
- PowerShell: `return @($oneHashtable)` unrolls to the hashtable; HyperHDR
  then silently keeps the old leds. Use `return , $arr`.
- HyperHDR `home_assistant` LED device never sends turn_off (black = rgb 0
  + brightness 0; Tuya/Calex ignores brightness 0) -> lamps stay WHITE on a
  black screen. Replaced by ambilight/halamps_bridge.py (udpraw 19449).
- Calex Moodlight (Tuya dd, pid wrxde31hg9wel0c5) has FROZEN status
  reporting: colour_data reported h=12/v=157 forever (HA + cloud) while the
  bulb visibly follows every command. Never decide from its reported state.
  Ambience Light reports fine. Bulb accepts rgb+brightness in ONE turn_on
  from off (verified on Ambience).
- DX Light WEDGE (2026-09-15): hid_write blocks ~36 s then fails
  `0x3E5 Overlapped I/O operation is in progress`; Windows still says OK.
  What I believed: a PnP cycle would replug it. What proved it wrong: BOTH
  `pnputil /restart-device` AND Disable/Enable-PnpDevice on the composite
  parent made the device VANISH (Present=False) until a hand replug;
  `/scan-devices` does not bring it back. HID-child disable/enable is
  harmless but does not unwedge. Only VBUS drop works -> the ladder stops
  at "notify + replug" (`scripts/dxlight-recover.ps1`). Idle power-down
  was ON for the interface; now off (MSPower_DeviceEnable=False).
- HyperHDR `leds[].group` is LED AVERAGING (all LEDs with the same non-zero
  group get one colour). I used it as a "this layout is mine" tag -> whole
  strip flat grey, R|G|B pattern read 15/15/15. Symptom: every segment
  identical in ledstream while the imagestream is fine. Keep group 0.
- HyperHDR restart via task: first Start-ScheduledTask after Stop-Process
  can return 0xFFFFFFFF; run it again. After restart grabbers are OFF and
  stale systemGrabber.crop persists -> `ambilight.ps1 -Configure` then
  `-Mode movie`.
- `light.hyperhdr` (hyperhdr_integration) is the integration's OWN light:
  'on' only while HA holds prio 50. In movie mode the grabber (prio 245)
  owns output -> light reads 'off' for the whole film. Derive status from
  attributes connection_status + active_component (SYSTEMGRABBER=movie);
  helper `src/lib/home/ambilight-status.ts`, HA `binary_sensor.ambilight_movie`.
- Calex Tuya bulbs: LAN works (tinytuya 3.3, local keys via Cloud.getdevices
  -> `.private/tuya-local-keys.json`); Moodlight ~200 ms/write, Ambience
  ~110 ms. HA->Tuya-cloud path added ~1-3 s. One writer thread per lamp,
  latest-wins; a serial loop let one slow bulb delay the other.
- DX Light notifications: `ambilight/notify_fx.py` in the bridge process,
  udp/19460 JSON {event,color,duration}; only one HID handle allowed, so
  never open the strip from a second process while bridges.py runs.
- Gates that use Rec.709 luma kill blue (0.07) and dark red (0.21) while
  passing grey of the same level -> "blue never shows, red looks white".
  Gate on max(r,g,b) instead (2026-09-16, dxlight_bridge.black_gate).
- "White on the wall while screen is red" was NOT the strip: light.led_argb
  (MELK) left at 3000 K/60 % by movie_mode_off; and the ESPHome BLE proxy at
  .120 pings but resets the API ("0 scanner(s) registered"), so HA could not
  turn it off. PC's Intel BT + bleak works: write fff3 7e0004000000ff00ef.
- Calex Tuya bulbs (Moodlight/Ambience) are INVISIBLE below ~25 % in a dark
  room (blue at 6/12/25 % read as off, 60 % visible). "Lamp never turns on
  in movie mode" while the log says `on ... bri 16` = linear luma map landed
  under the threshold. Fix f8a693e: bri = BRI_MIN(64) + luma*(cap-64),
  roomBrightness cap 140. Log values 14-21 are the tell.
- Room lamps "laggy / off / wrong colour" after video_follow landed
  (68500dd). Three stacked causes; first belief "fit thrash" was only 1/3:
  (a) HyperHDR smoothing `continuousOutput=false` -> udpraw SILENT 2-3 s on
  a static shot (tap the port with the bridge stopped to see it) -> halamps
  5 s release + state forget. Lamp instances must be continuous; HID strip
  may stay false. (b) video_follow full-setconfig per fit restarts smoothing
  from black; 318 fits/evening from 1-4 % bar drift -> now debounced.
  (c) luma gate flips several times / 15 s on a quadrant average -> relay
  needs TIME hysteresis (off after 4 s dark), not only a level one.
  Also: repeated partial/full `setconfig` on a long-running HyperHDR hangs
  its web/WS server (HTTP timeout, LEDs still run) -> restart task first.
- MELK strip is HyperHDR instance 4 (udp 19450, region mid) -> ambilight/
  melk_bridge.py, bleak from the PC's Intel BT (280121b). It runs floor
  corner -> ceiling edge behind the viewer. Bridge holds the BLE link while
  streaming, releases 5 s after last frame so HA elkbledom can take over;
  movie_mode_on must NOT call HA on light.led_argb (steals the link).
- ELK-BLEDOM/MELK: single write char fff3, 9-byte 7e 00 05 03 rr gg bb 00 ef;
  MELK init 7e0783 + 7e0404 (elkbledom README). One color for whole strip,
  no per-LED -> not a real ambilight target.
