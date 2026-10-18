# Replacing the MELK-OA10 controller with WLED

The MELK/ELK-BLEDOM box accepts **one colour for the whole strip** — the
protocol has no per-LED command — so it can never be a real ambilight
target. The LED strip itself is fine; only the controller box changes.

## Buy

| board                                  | ~price  | why                                                              |
| -------------------------------------- | ------- | ---------------------------------------------------------------- |
| **QuinLED Dig-Uno v3** (pre-assembled) | 30 $    | fuse, level shifter, screw terminals, USB-C; the reference board |
| Gledopto GL-C-016WL-D                  | 25–35 € | ships with WLED, Ethernet option                                 |
| avoid: Athom C3 variants               |         | HA polling lock-ups on ESP32-C3                                  |

Plus a 5 V PSU sized for the strip (60 mA/LED worst case → 75 LEDs ≈ 4 A →
a 5 V / 5 A supply). Inject power at the strip, not through the board.

## Flash + first boot

1. Plug the board into USB → <https://install.wled.me> → _Install_ (WLED
   16.x, Chrome/Edge only) → enter the 2.4 GHz WiFi from
   `.private/credentials.env` (`HOME_WIFI_SSID`).
2. It appears on the LAN as `wled-xxxxxx.local`. Reserve its DHCP lease in
   the router.
3. _Config → LED Preferences_: type WS281x, GRB, count = LEDs on the strip,
   max current per the PSU. _Config → Sync Interfaces → Realtime_: Receive
   UDP realtime **on**, _Use main segment only_ on, timeout **2500 ms**,
   _Disable realtime gamma correction_ on (HyperHDR already does it).
4. Home Assistant discovers it automatically (core `wled` integration);
   confirm in _Settings → Devices → Discovered_. The `select.wled_live_override`
   entity decides whether HA state or the realtime stream wins.

## HyperHDR

Add a fourth instance with the **ddp** driver (UDP 4048, no config on the
WLED side) and a border layout matching where the strip physically runs:

```powershell
. .\scripts\lib\hyperhdr.ps1; . .\ambilight\hyperhdr-layout.ps1
$id = <new instance id>
Set-HyperConfig -Instance $id -Config @{
  device = @{ type = 'ddp'; host = 'wled-xxxxxx.local'; port = 4048; rgbw = $false; hardwareLedCount = 75; colorOrder = 'rgb'; refreshTime = 0 }
  leds   = New-BorderLayout -Order left,top,right -Counts @{ left = 20; top = 35; right = 20 } -Depth 0.08
  smoothing = @{ enable = $true; type = 'HybridRgbInterpolator'; time_ms = 60; updateFrequency = 60; antiFlickeringFilter = $true; continuousOutput = $false; damping = 26; stiffness = 150; smoothingFactor = 0; y_limit = 0.03 }
}
```

Then move `light.led_argb` out of instance 2's `lamps` (it will be
`light.wled_*` now and driven per-LED by DDP), and add the new instance to
the `[0, 1, 2]` list in `ha-scenes.yaml` → `ambilight_all`. Run
`scripts\ambilight.ps1 -Configure -InstallHaScenes` after editing.

Expect ~40–60 fps over WiFi; disable WiFi sleep in WLED if you see stutter.

## MELK-OC21 (strip under the monitors) — same swap, 2 segments

The OC21 (`BE:16:2F:00:05:29`, `melk_oc21` in the device registry) has the
same one-colour BLE protocol. Registry segments already match the physical
cuts: **Dreapta 14 LEDs (0–13)** + **Stânga 15 LEDs (14–28)**, 29 total.

1. Same board as above (one ESP32 + level shifter); WLED LED count **29**,
   two WLED segments 0–13 and 14–28 so the strip still reads as two in WLED.
2. HyperHDR: a further **ddp** instance, `hardwareLedCount = 29`, layout =
   a bottom edge running right→left (the strip sits under the screens):
   `New-BorderLayout -Order bottom -Counts @{ bottom = 29 } -Depth 0.08`
   then reverse if the first LED is on the left. Brightness stays on
   `scaleOutput` like every other instance.
3. vmui: in **Dispozitive**, delete the BLE `melk_oc21` entry and add the
   WLED one (transport WLED/HA), re-create the same two segments; the BLE
   hub stops trying to reach the old MAC once it is out of the registry.
