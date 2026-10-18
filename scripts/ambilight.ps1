#requires -version 7
<#
.SYNOPSIS
  Screen-reactive lighting for the movie PC: HyperHDR + bridges to every
  light we own, wired into Home Assistant.

.DESCRIPTION
  Pipeline (all on this PC, one process each, started at logon):

    HyperHDR 22 (DX11 grabber, HDR tone-mapped, 60 fps)
      inst 0  "DX Light (monitor)"    udpraw :19446 -> ambilight/dxlight_bridge.py -> USB HID strip, 65 LEDs
      inst 1  "PC glow (OpenRGB)"     udpraw :19447 -> ambilight/openrgb_bridge.py -> OpenRGB SDK :6742
      inst 2  "Room lights (HA)"      home_assistant driver -> Desk Light Bar, BLE strip (+ bulbs when paired)
      MQTT client -> Mosquitto on the appliance, topic HyperHDR/JsonAPI

  Home Assistant (ambilight/ha-scenes.yaml, a HA package) owns the modes:
  movie / music / off, a notify flash, and two webhooks the phone can hit.

  Why HyperHDR and not DX Light: DX Light drives one strip from one screen
  with no API. HyperHDR does HDR correctly on Windows, has per-device LED
  geometry, and talks to everything else through standard outputs.

.EXAMPLE
  ambilight.ps1 -Status
  ambilight.ps1 -Install          # logon tasks for HyperHDR, OpenRGB, both bridges; DX Light out of autostart
  ambilight.ps1 -Configure        # (re)write HyperHDR instances from this file
  ambilight.ps1 -InstallHaScenes  # push ha-scenes.yaml to the appliance
  ambilight.ps1 -Mode movie|music|off
  ambilight.ps1 -Notify -Color 0,120,255
  ambilight.ps1 -Set wallHex=#439ebf wallStrength=0.8   # persist a setting, re-configure
  ambilight.ps1 -Uninstall

.NOTES
  Tunables live in ambilight/settings.json (gitignored-safe, no secrets):
    wallHex        colour of the wall behind the Odyssey; light bounced off it
                   is tinted, so the strip is pre-compensated (New-WallCompensation)
    wallStrength   0 = off, 1 = full inverse-reflectance correction
    gamma / saturation / luminance  HyperHDR channel adjustment for the strip
    grabberFps / hdrToneMapping     DX11 capture; lower = gentler on the GPU
    stripSmoothMs / glowSmoothMs / roomSmoothMs
                   time constant (tau) of the colour follow per output. The
                   monitor strip can be quick; the case and room are a mood
                   glow and should drift, not track. Uses HyperHDR's
                   ExponentialInterpolator, the only type where time_ms is
                   honoured -- HybridRgbInterpolator is a spring that ignores
                   time_ms entirely (stiffness/damping only), which is why the
                   PC glow used to snap on every cut.
    roomBrightness 0-255 brightness cap for the Calex bulbs in movie mode
                   (ambilight/halamps_bridge.py). Default 90 ~ 35 %.
    idleStripHex / idleGlowHex / idleAfterSec
                   colour each output shows after idleAfterSec with no frames
                   from HyperHDR (movie mode off, or nothing moving on screen
                   for that long). Applied by the BRIDGES, not by HyperHDR:
                   HyperHDR's backgroundEffect flips in after only 800 ms
                   without a new frame, and DX11 delivers no frame while the
                   screen is static, so a paused film or a still scene made
                   the case jump idle->picture->idle ("lightning"). The
                   bridges hold the last frame instead and fade to idle only
                   after a real silence. '#000000' = off. Room lights get
                   their idle look from movie_mode_off via HA.
    videoFollow    true: ambilight/video_follow.py crops the HyperHDR grabber
                   to the video window on the Odyssey (and, inside a browser,
                   to the moving picture), so a non-fullscreen YouTube tab
                   still drives the LEDs. false = whole screen.
    videoAutoMovie true: a video window present 5 s -> movie_mode_on,
                   gone 30 s -> movie_mode_off (tray/HA can still override
                   until the next edge).
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    [Parameter(Mandatory, ParameterSetName = 'Install')][switch]$Install,
    [Parameter(Mandatory, ParameterSetName = 'Uninstall')][switch]$Uninstall,
    [Parameter(Mandatory, ParameterSetName = 'Configure')][switch]$Configure,
    [Parameter(Mandatory, ParameterSetName = 'Scenes')][switch]$InstallHaScenes,
    [Parameter(Mandatory, ParameterSetName = 'Mode')][ValidateSet('movie', 'music', 'off')][string]$Mode,
    [Parameter(Mandatory, ParameterSetName = 'Notify')][switch]$Notify,
    [Parameter(ParameterSetName = 'Notify')][int[]]$Color = @(0, 120, 255),
    [Parameter(ParameterSetName = 'Notify')][int]$DurationMs = 1500,
    [Parameter(Mandatory, ParameterSetName = 'Set')][string[]]$Set
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Amb = Join-Path $Root 'ambilight'
$env:HA_URL = $null
. (Join-Path $PSScriptRoot 'lib\guest-credentials.ps1') | Out-Null
. (Join-Path $PSScriptRoot 'lib\hyperhdr.ps1')
. (Join-Path $Amb 'hyperhdr-layout.ps1')

$SettingsPath = Join-Path $Amb 'settings.json'
$Defaults = [ordered]@{ wallHex = '#ffffff'; wallStrength = 0.0; gamma = 1.5; saturation = 1.0; luminance = 1.0; grabberFps = 60; hdrToneMapping = $true; stripSmoothMs = 300; glowSmoothMs = 1500; roomSmoothMs = 2500; roomBrightness = 90; idleStripHex = '#000000'; idleGlowHex = '#000000'; idleAfterSec = 20; videoFollow = $true; videoAutoMovie = $true }
function Get-Settings {
    $s = [ordered]@{} + $Defaults
    if (Test-Path $SettingsPath) { (Get-Content $SettingsPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $s[$_.Name] = $_.Value } }
    $s
}
function Save-Settings([hashtable]$s) { ($s | ConvertTo-Json) | Set-Content $SettingsPath -Encoding utf8 }
$Settings = Get-Settings

$HyperExe = "$env:ProgramFiles\HyperHDR\bin\hyperhdr.exe"
$OpenRgbExe = "$env:ProgramFiles\OpenRGB\OpenRGB.exe"
# pythonw, not python: a Task Scheduler console delivered Ctrl+C to the
# bridges (exit 0xC000013A) and the room went static. No console, no signal.
# The bridges write their own log under .copilot-tmp/service-logs.
$Python = Join-Path (Split-Path (Get-Command python).Source) 'pythonw.exe'
$Tasks = @(
    @{ Name = 'vmui-ambilight-hyperhdr'; Exe = $HyperExe;   Args = '--service'; Delay = 5 },
    # Elevated: OpenRGB 1.0 reaches the DRAM sticks over SMBus through the
    # PawnIO driver, which refuses an unelevated caller ("Permission Denied,
    # PawnIO initialization aborted") and the RAM silently never appears.
    @{ Name = 'vmui-ambilight-openrgb';  Exe = $OpenRgbExe; Args = '--server --startminimized --profile Dragos'; Delay = 10; Elevated = $true },
    # One process hosts both udpraw bridges (19446 DX Light, 19447 OpenRGB)
    # and restarts whichever dies; replaced the separate dxlight/pcglow tasks.
    @{ Name = 'vmui-ambilight-bridges';  Exe = $Python;     Args = "`"$Amb\bridges.py`""; Delay = 20 },
    # Tauri app (apps/desktop): tray icon + native control window. Replaced
    # ambilight/tray.py (pystray), which is kept only as a fallback.
    # Watchdog: the tray exited cleanly (result 0) on 2026-10-17 and nothing restarted
    # it (RestartCount only covers failures). Re-fire every 5 min; single-instance +
    # IgnoreNew make that a no-op while it runs.
    @{ Name = 'vmui-tray';               Exe = "$Root\apps\desktop\src-tauri\target\release\vmui-desktop.exe"; Args = '--hidden'; Delay = 30; Watchdog = 5 },
    # The panel itself is driven from homepi (pi/turzx.service). This PC only
    # publishes its CPU/GPU/focus metrics to vmui there for the "pc" view.
    @{ Name = 'vmui-turzx';              Exe = $Python;     Args = "`"$Root\turzx\turzx.py`" --publish --vmui http://192.168.100.232:3737"; Delay = 35 }
)

function Write-Ok($m) { Write-Host "  $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Write-Step($m) { Write-Host "  $m" -ForegroundColor Cyan }

function New-Smoothing([int]$TimeMs, [int]$Hz, [switch]$Continuous) {
    # continuousOutput=false stops udpraw when the picture is static (measured
    # 2026-09-16: 2-3 s silences on a calm shot). Fine for the HID strip
    # (fewer writes), fatal for the lamp bridges, whose idle/release timers
    # then fire mid-film and forget what the bulbs show.
    @{ enable = $true; type = 'ExponentialInterpolator'; time_ms = [Math]::Max(25, $TimeMs); updateFrequency = $Hz; antiFlickeringFilter = $true; continuousOutput = [bool]$Continuous; damping = 26; stiffness = 150; smoothingFactor = 0; y_limit = 0.03 }
}

$OrgbEffectProfiles = "$env:APPDATA\OpenRGB\plugins\settings\effect-profiles"
function Get-OrgbAutostartEffects {
    <# Effects-plugin effects armed to start with OpenRGB. Each one is a second
       writer on the same LEDs at 60 fps: the bridge sets a colour, the effect
       overwrites it a frame later, and the case looks like lightning. #>
    if (-not (Test-Path $OrgbEffectProfiles)) { return @() }
    foreach ($f in Get-ChildItem $OrgbEffectProfiles -File | Where-Object Name -notmatch '\.bak') {
        $p = Get-Content $f.FullName -Raw | ConvertFrom-Json -AsHashtable
        foreach ($e in @($p['Effects'])) { if ($e['AutoStart']) { [pscustomobject]@{ Profile = $f.Name; Effect = ($e['EffectClassName'] ?? $e['EffectName']) } } }
    }
}
function Disable-OrgbAutostartEffects {
    $armed = @(Get-OrgbAutostartEffects)
    if (-not $armed) { return }
    foreach ($f in Get-ChildItem $OrgbEffectProfiles -File | Where-Object Name -notmatch '\.bak') {
        $p = Get-Content $f.FullName -Raw | ConvertFrom-Json -AsHashtable
        $changed = $false
        foreach ($e in @($p['Effects'])) { if ($e['AutoStart']) { $e['AutoStart'] = $false; $changed = $true } }
        if ($changed) { ($p | ConvertTo-Json -Depth 20) | Set-Content $f.FullName -Encoding utf8 }
    }
    Write-Ok "OpenRGB Effects autostart disabled: $(($armed | ForEach-Object { "$($_.Profile)/$($_.Effect)" }) -join ', ')"
    $orgb = Get-Process OpenRGB -ErrorAction SilentlyContinue
    if ($orgb) { $orgb | Stop-Process -Force; Start-Sleep 2; Start-ScheduledTask -TaskName 'vmui-ambilight-openrgb' -ErrorAction SilentlyContinue; Start-Sleep 6 }
}

function Ensure-Instance([string]$Name) {
    $ex = (Get-HyperServerInfo).instance | Where-Object friendly_name -eq $Name
    if (-not $ex) {
        Invoke-Hyper @(@{ command = 'instance'; subcommand = 'createInstance'; name = $Name }) | Out-Null
        Start-Sleep 2
        $ex = (Get-HyperServerInfo).instance | Where-Object friendly_name -eq $Name
    }
    if (-not $ex.running) {
        Invoke-Hyper @(@{ command = 'instance'; subcommand = 'startInstance'; instance = [int]$ex.instance }) | Out-Null
        Start-Sleep 3
    }
    [int]$ex.instance
}

function Enable-Grabber([int]$Instance) {
    Invoke-Hyper @(
        @{ command = 'componentstate'; componentstate = @{ component = 'SYSTEMGRABBER'; state = $true } },
        @{ command = 'componentstate'; componentstate = @{ component = 'VIDEOGRABBER'; state = $false } },
        @{ command = 'componentstate'; componentstate = @{ component = 'LEDDEVICE'; state = $true } }
    ) -Instance $Instance | Out-Null
}

function Configure-HyperHdr {
    Disable-OrgbAutostartEffects
    # crop* is inert on this machine (see hardware= below); video_follow.py
    # tracks the video window by rewriting `leds` instead, and re-learns the
    # base layouts written here within 15 s.
    $crop = @{ cropTop = 0; cropBottom = 0; cropLeft = 0; cropRight = 0 }
    $SystemGrabber = @{
        # Both DX11 paths are broken on this RTX 3060 Ti + 2x 3440x1440
        # (HyperHDR 22.0.0, measured 2026-09-15 via imagestream):
        #   hardware=true  -> the Odyssey is squeezed into the LEFT HALF of the
        #                     frame, right half always black;
        #   hardware=false -> left half = Odyssey (squeezed the same way),
        #                     RIGHT HALF = the PHILIPS. A black film frame
        #                     lit the strip's right/top with the desktop.
        # Both are the same bug: the frame is 2x too wide (2 monitors), only
        # the second half differs. crop* does NOT fix it (cropRight=3440 left
        # the frame unchanged). Fix = keep hardware=true (no foreign pixels)
        # and map every LED layout onto h 0..0.5 of the frame ($Frame below).
        device = 'auto'; hardware = $true; fps = [int]$Settings.grabberFps; videoMode = 512
        # Windows HDR capture returns scRGB floats; without tone-mapping
        # every colour is washed out. 250 nits matches the Odyssey OLED.
        hdrToneMapping = [bool]$Settings.hdrToneMapping; monitor_nits = 250
        cropTop = $crop.cropTop; cropBottom = $crop.cropBottom; cropLeft = $crop.cropLeft; cropRight = $crop.cropRight
        # `auto` grabs the Windows PRIMARY display, which is the Philips.
        # The film runs on the Odyssey (left, DISPLAY2) so shift by one.
        # Wrong value = "AcquireNextFrame didn't return the frame" forever
        # and every light stays static while a film plays next door.
        signalDetection = $false; reorder_displays = 1
        redSignalThreshold = 5; greenSignalThreshold = 5; blueSignalThreshold = 5; noSignalCounterThreshold = 200
        sDHOffsetMin = 0.25; sDHOffsetMax = 0.75; sDVOffsetMin = 0.25; sDVOffsetMax = 0.75
    }
    # Where the Odyssey lands inside the grabber frame (see hardware= above).
    $Frame = @{ HMin = 0.0; HMax = 0.5 }
    Write-Step 'instance 0: DX Light on the movie monitor (right 17, top 31, left 17)'
    $Inst0 = @{
        general       = @{ name = 'DX Light (monitor)'; disableOnLocked = $true; disableLedsStartup = $false; showOptHelp = $false; version = 6 }
        systemGrabber = $SystemGrabber
        videoGrabber  = @{ enable = $false }
        # The strip shines on a painted wall; correct for its tint here.
        color         = New-WallCompensation -WallHex $Settings.wallHex -Strength ([double]$Settings.wallStrength) -Gamma ([double]$Settings.gamma) -Saturation ([double]$Settings.saturation) -Luminance ([double]$Settings.luminance)
        device        = @{ type = 'udpraw'; host = '127.0.0.1'; port = 19446; colorOrder = 'rgb'; refreshTime = 0; hardwareLedCount = 65 }
        leds          = Set-LayoutFrame @Frame -Leds (New-BorderLayout -Order right, top, left -Counts @{ right = 17; top = 31; left = 17 } -Depth 0.08)
        # 30 Hz: the HID controller wedges (0x3E5) when fed 60 distinct frames/s; see dxlight_bridge.py MAX_FPS.
        smoothing     = New-Smoothing -TimeMs ([int]$Settings.stripSmoothMs) -Hz 30
        backgroundEffect = @{ enable = $false; type = 'color'; color = @(0, 0, 0); effect = 'Rainbow swirl fast' }
        soundEffect   = @{ device = 'Voicemeeter Out B1 (VB-Audio Vo'; enable = $true; enable_smoothing = $true }
        mqtt          = @{ enable = $true; host = ($env:HA_URL -replace '^https?://', ''); port = 1883; username = $env:MQTT_HYPERHDR_USER; password = $env:MQTT_HYPERHDR_PASS; is_ssl = $false; ignore_ssl_errors = $true; custom_topic = 'HyperHDR'; disableApiAccess = $false; maxRetry = 120 }
    }
    Set-HyperConfig -Instance 0 -Config $Inst0
    Enable-Grabber 0

    Write-Step 'instance 1: PC glow under the desk (left / whole / right regions)'
    $pc = Ensure-Instance 'PC glow (OpenRGB)'
    Set-HyperConfig -Instance $pc -Config @{
        device    = @{ type = 'udpraw'; host = '127.0.0.1'; port = 19447; colorOrder = 'rgb'; refreshTime = 0; hardwareLedCount = 3 }
        # Picture-safe thirds, not screen edges: the outer 35 % is black bars
        # or player chrome most of the time and the case only pulsed.
        leds      = Set-LayoutFrame @Frame -Leds (@() + (New-RegionLayout left3) + (New-RegionLayout mid) + (New-RegionLayout right3))
        smoothing = New-Smoothing -TimeMs ([int]$Settings.glowSmoothMs) -Hz 25 -Continuous
        backgroundEffect = @{ enable = $false; type = 'color'; color = @(0, 0, 0); effect = 'Rainbow swirl fast' }
    }
    Enable-Grabber $pc

    Write-Step 'instance 2: room lights via ambilight/halamps_bridge.py -> Home Assistant'
    $ha = Ensure-Instance 'Room lights (Home Assistant)'
    # Lamps and their order live in halamps_bridge.py LAMPS (Moodlight,
    # Ambience Light); leds below must match that order. Main Light stays out
    # on purpose: a coloured ceiling distracts; it gets the movie_mode warm-dim.
    # NOT HyperHDR's own `home_assistant` device any more: it never sends
    # turn_off (black = rgb 0 + brightness 0, which the Tuya firmware ignores,
    # so a black screen left the lamps white at 60/255), and its hard-coded
    # 500 ms REST timeout disabled the device on one slow reply.
    # NOT light.desk_light_bar: HA advertises `hs` for it but the Tuya firmware
    # work_mode enum is ['music','white'], so every hs_color POST is a 500 and
    # it has its own bridge (instance 3). NOT light.led_argb (MELK BLE): its
    # HA path takes >500 ms per call; it has its own BLE bridge (instance 4).
    Set-HyperConfig -Instance $ha -Config @{
        device    = @{ type = 'udpraw'; host = '127.0.0.1'; port = 19449; colorOrder = 'rgb'; refreshTime = 0; hardwareLedCount = 2 }
        # Lamps follow the picture quadrant nearest to where they stand:
        # Moodlight bottom-left, Ambience Light top-right.
        leds      = Set-LayoutFrame @Frame -Leds (@() + (New-RegionLayout bl) + (New-RegionLayout tr))
        # Schema minimum is 20 Hz; the bridge throttles the bulbs to 2 Hz.
        smoothing = New-Smoothing -TimeMs ([int]$Settings.roomSmoothMs) -Hz 20 -Continuous
    }
    Enable-Grabber $ha

    Write-Step 'instance 3: Desk Light Bar via Tuya Cloud (upper band of the picture)'
    # HA cannot colour this bar (its Tuya integration sends control_data ->
    # "type is incorrect"); ambilight/deskbar_bridge.py talks to Tuya Cloud
    # directly with colour_data in music mode. One LED = top3 region.
    $bar = Ensure-Instance 'Desk bar (Tuya)'
    Set-HyperConfig -Instance $bar -Config @{
        device    = @{ type = 'udpraw'; host = '127.0.0.1'; port = 19448; colorOrder = 'rgb'; refreshTime = 0; hardwareLedCount = 1 }
        leds      = Set-LayoutFrame @Frame -Leds (@() + (New-RegionLayout top3))
        # Same wall as the DX Light strip: without this the bar throws pure
        # screen colour at a blue wall while the strip throws pre-compensated
        # (red-heavy) colour, and where the two overlap the right half of the
        # wall reads red against the left. gamma 1 -- the bar has its own.
        color     = New-WallCompensation -WallHex $Settings.wallHex -Strength ([double]$Settings.wallStrength) -Gamma 1.0 -Saturation ([double]$Settings.saturation) -Luminance 1.0
        # LAN write is ~65 ms, bridge caps at 10 Hz; same feel as the case glow.
        smoothing = New-Smoothing -TimeMs ([int]$Settings.glowSmoothMs) -Hz 20 -Continuous
        backgroundEffect = @{ enable = $false; type = 'color'; color = @(0, 0, 0); effect = 'Rainbow swirl fast' }
    }
    Enable-Grabber $bar

    Write-Step 'instance 4: MELK BLE strip behind the viewer via ambilight/ble_lights.py'
    # Runs from the floor corner behind the desk up and along the ceiling
    # edge: a whole-room wash, so it echoes the picture's centre average.
    # Single-colour strip; the bridge owns the BLE link while frames stream
    # and releases it to HA (movie_mode_off warm white) RELEASE_S after.
    $melk = Ensure-Instance 'MELK strip (BLE)'
    Set-HyperConfig -Instance $melk -Config @{
        device    = @{ type = 'udpraw'; host = '127.0.0.1'; port = 19450; colorOrder = 'rgb'; refreshTime = 0; hardwareLedCount = 1 }
        leds      = Set-LayoutFrame @Frame -Leds (@() + (New-RegionLayout mid))
        smoothing = New-Smoothing -TimeMs ([int]$Settings.roomSmoothMs) -Hz 20 -Continuous
        backgroundEffect = @{ enable = $false; type = 'color'; color = @(0, 0, 0); effect = 'Rainbow swirl fast' }
    }
    Enable-Grabber $melk

    # systemGrabber is global and reverts to defaults when instances 1/2 are
    # written after instance 0 (measured: fps=20, hdr=false, reorder=0 every
    # time). A setconfig with ONLY systemGrabber resets `device` to file, so
    # re-send the whole instance-0 config last, then bounce the grabber.
    Set-HyperConfig -Instance 0 -Config $Inst0
    foreach ($i in 0, $pc, $ha, $bar, $melk) {
        Invoke-Hyper @(@{ command = 'componentstate'; componentstate = @{ component = 'SYSTEMGRABBER'; state = $false } }) -Instance $i | Out-Null
    }
    Start-Sleep 1
    foreach ($i in 0, $pc, $ha, $bar, $melk) { Enable-Grabber $i }
    $g = (Get-HyperConfig -Instance 0).systemGrabber
    if ($g.fps -ne $SystemGrabber.fps -or $g.reorder_displays -ne $SystemGrabber.reorder_displays) { throw "systemGrabber did not persist: fps=$($g.fps) reorder=$($g.reorder_displays)" }
    Write-Ok 'HyperHDR configured'
}

function Install-Tasks {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')
    foreach ($t in $Tasks) {
        if (-not (Test-Path $t.Exe)) { throw "$($t.Exe) not found" }
        if ($t.Elevated -and -not $isAdmin) {
            $cur = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
            if ($cur.Principal.RunLevel -eq 'Highest') { Write-Ok "task $($t.Name) (elevated, kept)"; continue }
            Write-Warn "task $($t.Name) needs RunLevel Highest; run once from an ADMIN shell:  pwsh -File `"$PSCommandPath`" -Install"
            continue
        }
        $action = New-ScheduledTaskAction -Execute $t.Exe -Argument $t.Args -WorkingDirectory $Amb
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $trigger.Delay = "PT$($t.Delay)S"
        $triggers = @($trigger)
        if ($t.Watchdog) {
            $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $t.Watchdog)
        }
        $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden
        # -Force overwrites in place. Unregister+Register fails on a task that
        # was registered from an elevated shell (Unregister: Access denied,
        # then Register: file already exists) and left the loop half done.
        $reg = @{ TaskName = $t.Name; Action = $action; Trigger = $triggers; Settings = $settings; Description = 'vmui ambilight stack (scripts/ambilight.ps1)'; Force = $true }
        if ($t.Elevated) { $reg.Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest }
        try {
            Register-ScheduledTask @reg -ErrorAction Stop | Out-Null
            Write-Ok "task $($t.Name)$(if ($t.Elevated) { ' (elevated)' })"
        }
        catch {
            $cur = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
            if ($cur -and ($cur.Actions[0].Arguments -eq $t.Args)) { Write-Ok "task $($t.Name) (unchanged, kept)" }
            else { Write-Warn "task $($t.Name): $($_.Exception.Message) -- re-run from an ADMIN shell" }
        }
    }
    # Tasks this script no longer defines (consolidated into bridges.py).
    foreach ($old in 'vmui-ambilight-dxlight', 'vmui-ambilight-pcglow') {
        if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue
            Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dxlight_bridge\.py|openrgb_bridge\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Write-Ok "task $old removed (replaced by vmui-ambilight-bridges)"
        }
    }
    # DX Light and HyperHDR both open the HID device; the last writer wins
    # and the strip flickers. HyperHDR replaces it.
    $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (Get-ItemProperty $run -Name 'electron.app.DX Light' -ErrorAction SilentlyContinue) {
        Remove-ItemProperty $run -Name 'electron.app.DX Light'
        Write-Ok 'DX Light removed from autostart (app stays installed)'
    }
    Get-Process 'DX Light' -ErrorAction SilentlyContinue | Stop-Process -Force
    # Start whatever is not already running.
    foreach ($t in $Tasks) {
        $proc = Split-Path $t.Exe -Leaf
        $running = Get-CimInstance Win32_Process -Filter "Name='$proc'" | Where-Object { $t.Args -notmatch 'listen' -or $_.CommandLine -match [regex]::Escape(($t.Args -split ' ')[-1]) }
        if (-not $running) { Start-ScheduledTask -TaskName $t.Name; Start-Sleep 2 }
    }
}

function Uninstall-Tasks {
    foreach ($t in $Tasks) { Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dxlight_bridge|openrgb_bridge|ambilight\\bridges\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Ok 'tasks removed; HyperHDR/OpenRGB left installed'
}

function Install-HaScenes {
    $HostSsh = "root@$($env:HA_URL -replace '^https?://','')"
    Get-Content -Raw (Join-Path $Amb 'ha-scenes.yaml') | ssh -o BatchMode=yes -p 22222 $HostSsh 'C=/mnt/data/supervisor/homeassistant; mkdir -p $C/packages && cat > $C/packages/ambilight.yaml && (grep -q "packages:" $C/configuration.yaml || printf "\nhomeassistant:\n  packages: !include_dir_named packages\n" >> $C/configuration.yaml)'
    . (Join-Path $PSScriptRoot 'lib\ha-ws.ps1')
    # reload_all covers script/automation/template/input_* -- the package also
    # defines sensors and helpers, which script.reload alone never picks up.
    Invoke-HaRest -Path '/api/services/homeassistant/reload_all' -Method POST -Body @{} | Out-Null
    Write-Ok 'ha-scenes.yaml installed as package + reload_all'
}

function Set-Mode([string]$m) {
    . (Join-Path $PSScriptRoot 'lib\ha-ws.ps1')
    $script = switch ($m) { 'movie' { 'movie_mode_on' } 'music' { 'music_mode' } default { 'movie_mode_off' } }
    Invoke-HaRest -Path "/api/services/script/$script" -Method POST -Body @{} | Out-Null
    Write-Ok "mode: $m"
}

function Send-Notify {
    . (Join-Path $PSScriptRoot 'lib\ha-ws.ps1')
    Invoke-HaRest -Path '/api/services/script/notify_flash' -Method POST -Body @{ color = $Color; duration_ms = $DurationMs } | Out-Null
    Write-Ok "flash $($Color -join ',') for ${DurationMs}ms"
}

function Show-Status {
    Write-Host ''
    foreach ($t in $Tasks) {
        $st = (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue).State
        $proc = Split-Path $t.Exe -Leaf
        # pythonw runs several of ours: match on the script name, not just the exe.
        $key = if ($t.Args -match '\\([a-z_]+\.py)') { $Matches[1] } else { $null }
        $live = Get-CimInstance Win32_Process -Filter "Name='$proc'" | Where-Object { -not $key -or $_.CommandLine -match [regex]::Escape($key) }
        Write-Host ("  {0,-28} task={1,-9} process={2}" -f $t.Name, ($st ?? 'absent'), $(if ($live) { 'running' } else { 'NOT running' })) -ForegroundColor $(if ($live) { 'Green' } else { 'Yellow' })
    }
    Write-Host ''
    try {
        $si = Get-HyperServerInfo
        foreach ($i in $si.instance) {
            $inf = (Invoke-Hyper @(@{ command = 'serverinfo' }) -Instance ([int]$i.instance)).info
            $dev = (Get-HyperConfig -Instance ([int]$i.instance)).device.type
            $led = ($inf.components | Where-Object name -eq 'LEDDEVICE').enabled
            $prio = ($inf.priorities | ForEach-Object { "$($_.componentId)@$($_.priority)" }) -join ' '
            # `file` = a partial setconfig wiped the device; LEDDEVICE=False = HA
            # driver disabled itself after an HTTP error. Both looked "fine" before.
            $bad = ($dev -eq 'file') -or (-not $led) -or ($prio -notmatch 'SYSTEMGRABBER')
            Write-Host ("  [{0}] {1,-30} {2,-22} device={3} leddevice={4}" -f $i.instance, $i.friendly_name, $prio, $dev, $led) -ForegroundColor $(if ($bad) { 'Yellow' } else { 'Gray' })
        }
        $g = (Get-HyperConfig -Instance 0).systemGrabber
        Write-Host ("  grabber: display #{0} (0 = Windows primary) fps={1} hdr={2}" -f $g.reorder_displays, $g.fps, $g.hdrToneMapping) -ForegroundColor $(if ($g.reorder_displays -eq 1 -and $g.fps -ge 30) { 'Gray' } else { 'Yellow' })
        $snd = $si.sound
        Write-Host ("  audio: {0} ({1})" -f $snd.device, $(if ($snd.active) { 'active' } else { 'inactive' }))
    }
    catch { Write-Warn "HyperHDR not reachable: $_" }
    # Frames actually reaching the strip: the bridge prints fps every 600 frames.
    $blog = Join-Path $Root '.copilot-tmp\service-logs\bridges.log'
    if (Test-Path $blog) {
        $age = [int]((Get-Date) - (Get-Item $blog).LastWriteTime).TotalSeconds
        # Both bridges share the log; the DX Light one prints the fps lines.
        $last = ((Get-Content $blog -Tail 40 | Where-Object { $_ -match 'fps' } | Select-Object -Last 1) ?? (Get-Content $blog -Tail 1)).Trim()
        Write-Host ("  frames:  {0} ({1}s ago)" -f $last, $age) -ForegroundColor $(if ($age -lt 60 -and $last -match 'fps') { 'Green' } else { 'Yellow' })
    }
    $dx = Get-Process 'DX Light' -ErrorAction SilentlyContinue
    if ($dx) { Write-Warn 'DX Light app is running and will fight HyperHDR for the strip' }
    $fx = @(Get-OrgbAutostartEffects)
    if ($fx) { Write-Warn "OpenRGB Effects autostart armed ($(($fx | ForEach-Object Effect) -join ', ')) -- case LEDs will flash; run -Configure" }
    # OpenRGB 1.0's installer registers an "OpenRGB SDK Server" Windows service
    # (LocalSystem, session 0). It grabs the same AORUS/GPU controllers as the
    # vmui-ambilight-openrgb task instance and both write the LEDs -> flicker.
    # Seen 2026-09-14 right after a winget upgrade.
    $svc = Get-Service OpenRGB -ErrorAction SilentlyContinue
    if ($svc -and ($svc.Status -eq 'Running' -or $svc.StartType -ne 'Disabled')) {
        Write-Warn "OpenRGB Windows service is $($svc.Status)/$($svc.StartType) -- a second controller instance; from an ADMIN shell: Stop-Service OpenRGB; Set-Service OpenRGB -StartupType Disabled"
    }
    # Pinned to 0.9 (b5f46e3): 1.0's rewritten Gigabyte RGB Fusion 2 USB driver
    # blanks the ARGB headers on every colour update (case + AIO strobe) --
    # verified 2026-09-14 with a direct SDK ramp and no other writer. 1.0 also
    # brought nothing we can use (DDR5 on Z790 stays unreachable, see ram-icue.ps1).
    $ver = (& $OpenRgbExe --version 2>$null | Select-Object -First 1) -replace '.*OpenRGB\s+', '' -replace ',.*', ''
    if ($ver -and $ver -notmatch '^0\.9$') { Write-Warn "OpenRGB is $ver -- ARGB headers strobe on 1.x; reinstall 0.9 (codeberg release_0.9, OpenRGB_0.9_Windows_64_b5f46e3.zip)" }
    Write-Host ''
}

switch ($PSCmdlet.ParameterSetName) {
    'Install' { Install-Tasks; Configure-HyperHdr; Show-Status }
    'Uninstall' { Uninstall-Tasks }
    'Configure' { Configure-HyperHdr }
    'Scenes' { Install-HaScenes }
    'Mode' { Set-Mode $Mode }
    'Notify' { Send-Notify }
    'Set' {
        $s = Get-Settings
        # Invoked with -File the [string[]] arrives as one literal, so split on
        # commas as well as accepting several positional values.
        foreach ($kv in ($Set -split ',')) {
            if (-not $kv.Trim()) { continue }
            $k, $v = ($kv.Trim("'", '"', ' ') -split '=', 2)
            $k = $k.Trim("'", '"', ' '); $v = $v.Trim("'", '"', ' ')
            if (-not $Defaults.Contains($k)) { throw "unknown setting '$k'; known: $($Defaults.Keys -join ', ')" }
            $s[$k] = switch ($Defaults[$k].GetType().Name) { 'Boolean' { [bool]::Parse($v) } 'Int32' { [int]$v } 'Double' { [double]$v } default { $v } }
        }
        Save-Settings $s
        Write-Ok "settings: $(($s.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')"
        $Settings = $s
        Configure-HyperHdr
        # The bridges read idle* once at start-up.
        if (($Set -join ',') -match 'idle') {
            Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bridges\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
            Start-Sleep 2
            Start-ScheduledTask -TaskName 'vmui-ambilight-bridges' -ErrorAction SilentlyContinue
            Write-Ok 'bridges restarted with the new idle colours'
        }
    }
    default { Show-Status }
}
