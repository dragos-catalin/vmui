#requires -version 7
<#
.SYNOPSIS
  Build, flash and serve the ideaspark ESP32 OLED "home display" (which is
  also Home Assistant's Bluetooth proxy).

.DESCRIPTION
  Firmware = ESPHome, compiled inside the ESPHome add-on on the appliance
  from esp32/home-display.yaml.tmpl. The ESP renders nothing: vmui composes
  each view as a 1-bit 128x64 BMP at /api/esp/display/<node> and the board
  polls it. Because vmui binds 127.0.0.1 only, this script also publishes a
  plain-HTTP LAN listener (Caddy, :8737, /api/esp/* only) that the ESP can
  reach; the token in ESP_DISPLAY_TOKEN gates it.

  Views rotate every 8 s: clock, weather, activity (what HA did), home
  status, ambilight, shopping list, last vmui actions, system.
  BOOT button: short = next view, double = pause, long = movie mode on/off.
  GPIO2 LED: dark when healthy, blinks on WiFi/API trouble (ESPHome status_led).

.EXAMPLE
  esp32-display.ps1 -Status
  esp32-display.ps1 -Publish            # Caddy LAN route :8737 -> vmui /api/esp
  esp32-display.ps1 -Flash              # compile on appliance, flash over COM
  esp32-display.ps1 -Flash -Ota         # after the first flash: over WiFi
  esp32-display.ps1 -Logs               # live log stream over WiFi (Ctrl+C to stop)
  esp32-display.ps1 -Logs -Seconds 30   # capture 30 s and exit
  esp32-display.ps1 -Preview clock      # ASCII render of a view (no hardware)
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    [Parameter(Mandatory, ParameterSetName = 'Publish')][switch]$Publish,
    [Parameter(Mandatory, ParameterSetName = 'Flash')][switch]$Flash,
    [Parameter(ParameterSetName = 'Flash')][Parameter(ParameterSetName = 'Logs')][switch]$Ota,
    [Parameter(ParameterSetName = 'Flash')][string]$ComPort,
    [Parameter(Mandatory, ParameterSetName = 'Preview')][string]$Preview,
    [Parameter(Mandatory, ParameterSetName = 'Logs')][switch]$Logs,
    [Parameter(ParameterSetName = 'Logs')][int]$Seconds = 0,
    [string]$NodeName = 'bluetooth-proxy-1',
    [string]$CredPrefix = 'ESPHOME_BTPROXY1',
    [string]$HostSsh = 'dragos@192.168.100.232',
    [int]$HostSshPort = 22,
    [string]$EsphomeDir = '/srv/homepi/esphome',
    [string]$EsphomeContainer = 'esphome',
    # Where the board finds vmui. Default = homepi (vmui listens on :3737 on the
    # LAN there). Pass -VmuiHost <pc-lan-ip> -LanPort 8737 to point it back at
    # the Windows host behind Caddy.
    [string]$VmuiHost = '192.168.100.232',
    [int]$LanPort = 3737,
    [string]$Refresh = '4s',
    # ideaspark ships two layouts: SDA/SCL on 5/4 or on 21/22. -Status shows
    # which one the running board reports.
    # OKOK/Chipsea bathroom scale, decoded from its BLE adverts (see the yaml)
    [string]$ScaleMac = '6C:02:4C:E9:DD:BB',
    [string]$Sda = 'GPIO21',
    [string]$Scl = 'GPIO22'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$env:HA_URL = $null
. (Join-Path $PSScriptRoot 'lib\guest-credentials.ps1') | Out-Null

function Write-Ok($m) { Write-Host "  $m" -ForegroundColor Green }
function Write-Step($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Write-Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }

function Get-LanIp {
    (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.100.*' } | Select-Object -First 1).IPAddress
}

function Get-Token {
    # The board's own appliance token (scripts/appliance-tokens.mjs -> VATRA_TOKEN_ESP32, registered on
    # the hub by pi-deploy). Revocable per board; the shared ESP_DISPLAY_TOKEN is the legacy fallback.
    if ($env:VATRA_TOKEN_ESP32 -like 'vmd_*') { return $env:VATRA_TOKEN_ESP32 }
    $t = $env:ESP_DISPLAY_TOKEN
    if (-not $t) {
        $t = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
        Add-Content (Join-Path $Root '.private\credentials.env') "`n# ESP32 home display (scripts/esp32-display.ps1)`nESP_DISPLAY_TOKEN=$t"
        $env:ESP_DISPLAY_TOKEN = $t
        Write-Ok 'generated ESP_DISPLAY_TOKEN -> .private'
    }
    $t
}

# The board sends its token as a header on every request (ESPHome request_headers); the URL carries none.
function Get-AuthHeader {
    $t = Get-Token
    if ($t -notlike 'vmd_*') { throw 'VATRA_TOKEN_ESP32 missing: run node scripts/appliance-tokens.mjs generate, then pi-deploy (it registers the token)' }
    "Bearer $t"
}

function Render-Yaml {
    $ip = $VmuiHost
    if (-not $ip) { $ip = Get-LanIp }
    if (-not $ip) { throw 'no vmui host: pass -VmuiHost' }
    $keyVar = "${CredPrefix}_API_KEY"
    $otaVar = "${CredPrefix}_OTA_PASS"
    foreach ($v in 'HOME_WIFI_SSID', 'HOME_WIFI_PASS', $keyVar, $otaVar) {
        if (-not (Get-Item "env:$v" -ErrorAction SilentlyContinue).Value) { throw "$v missing from .private\credentials.env" }
    }
    $auth = Get-AuthHeader
    $vars = @{
        node       = $NodeName
        friendly   = (($NodeName -replace '-', ' ') -replace '\b(\w)', { $_.Value.ToUpper() })
        api_key    = (Get-Item "env:$keyVar").Value
        ota_pass   = (Get-Item "env:$otaVar").Value
        wifi_ssid  = $env:HOME_WIFI_SSID
        wifi_pass  = $env:HOME_WIFI_PASS
        refresh    = $Refresh
        sda        = $Sda
        scl        = $Scl
        scale_mac  = $ScaleMac
        auth_header = $auth
        frame_url  = "http://${ip}:$LanPort/api/esp/display/${NodeName}"
        button_url = "http://${ip}:$LanPort/api/esp/button?src=esp"
        watchdog_url = "http://${ip}:$LanPort/api/esp/watchdog/${NodeName}"
        water_url  = "http://${ip}:$LanPort/api/nutrition/water"
        intercom_url = "http://${ip}:$LanPort/api/esp/intercom?node=${NodeName}"
    }
    $y = Get-Content (Join-Path $Root 'esp32\home-display.yaml.tmpl') -Raw
    foreach ($k in $vars.Keys) { $y = $y.Replace('${' + $k + '}', [string]$vars[$k]) }
    if ($y -match '\$\{[a-z_]+\}') { throw "unfilled template variable: $($Matches[0])" }
    $y -replace "`r`n", "`n"
}

function Publish-Lan {
    # Reuse whichever Caddy owns :443 (see publish-vmui.ps1); add a plain-HTTP
    # server on the LAN IP for the ESP. Only /api/esp/* and /api/mcp are
    # proxied; /api/mcp is the LAN fallback for the codai phone when its
    # Tailscale VPN is off (bearer vmui_* key checked by vmui itself).
    $ip = Get-LanIp
    $admin = $null
    foreach ($port in 22019, 2019) {
        try { $cfg = Invoke-RestMethod "http://127.0.0.1:$port/config/" -TimeoutSec 3; if ($cfg.apps.http.servers) { $admin = @{ port = $port; cfg = $cfg }; break } } catch {}
    }
    if (-not $admin) { throw 'no Caddy admin API on 22019/2019; run publish-vmui.ps1 first' }
    $base = "http://127.0.0.1:$($admin.port)"
    $srv = @{
        listen = @("${ip}:$LanPort")
        routes = @(
                @{ '@id' = 'vmui-esp'; match = @(@{ path = @('/api/esp/*', '/api/mcp') }); terminal = $true
               handle = @(@{ handler = 'reverse_proxy'; upstreams = @(@{ dial = '127.0.0.1:3737' }) }) },
                @{ handle = @(@{ handler = 'static_response'; status_code = 404; body = 'esp/mcp only' }) }
        )
        automatic_https = @{ disable = $true }
    }
    $json = $srv | ConvertTo-Json -Depth 12 -Compress
    # Caddy answers 200 `null` for an absent key, so test the value, not the status.
    $exists = $false
    try { $exists = $null -ne (Invoke-RestMethod "$base/config/apps/http/servers/vmui_esp" -TimeoutSec 3) } catch {}
    $m = if ($exists) { 'PATCH' } else { 'PUT' }
    Invoke-RestMethod -Method $m "$base/config/apps/http/servers/vmui_esp" -ContentType 'application/json' -Body $json | Out-Null
    Write-Ok "caddy: http://${ip}:$LanPort/api/esp/* -> vmui"
    # Windows Firewall: the vEthernet switch is a private network; Caddy is
    # already allowed for :443 (brivio). Check, don't assume.
    $t = Test-NetConnection -ComputerName $ip -Port $LanPort -WarningAction SilentlyContinue
    if ($t.TcpTestSucceeded) { Write-Ok "port $LanPort reachable on $ip" } else { Write-Warn "port $LanPort NOT reachable on $ip — firewall rule for caddy.exe needed (elevated)" }
}

function Flash-Board {
    $yaml = Render-Yaml
    Write-Step 'writing config into the ESPHome add-on and compiling (2-6 min)...'
    $yaml | ssh -o BatchMode=yes -p $HostSshPort $HostSsh "mkdir -p $EsphomeDir && cat > $EsphomeDir/$NodeName.yaml"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = ssh -o BatchMode=yes -p $HostSshPort $HostSsh "docker exec -w /config $EsphomeContainer esphome compile $NodeName.yaml 2>&1 | tail -5"
    $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if (-not (($out -join "`n") -match 'Successfully compiled')) { throw 'compile did not report success; see ESPHome add-on logs' }
    Write-Ok ("compiled in {0:N0} s (this, not the upload, is the slow part)" -f $sw.Elapsed.TotalSeconds)
    # USB when the board is on this PC (CH340/CP210x present and not held by
    # another process), otherwise OTA from the appliance. -Ota forces OTA.
    if (-not $Ota -and -not $ComPort) {
        $c = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM\d+\)' -and $_.HardwareID -match 'VID_1A86&PID_7523|VID_10C4' } | Select-Object -First 1
        if ($c) {
            $ComPort = [regex]::Match($c.Name, 'COM\d+').Value
            try { $p = [IO.Ports.SerialPort]::new($ComPort); $p.Open(); $p.Close() } catch { Write-Warn "$ComPort busy ($($_.Exception.Message.Split([char]10)[0])); falling back to OTA"; $ComPort = $null; $Ota = $true }
        } else { Write-Warn 'no CH340/CP210x on this PC; falling back to OTA'; $Ota = $true }
    }
    if ($Ota) {
        Write-Step 'OTA upload from the appliance...'
        $sw.Restart()
        ssh -o BatchMode=yes -p $HostSshPort $HostSsh "docker exec -w /config $EsphomeContainer esphome upload --device $NodeName.local $NodeName.yaml 2>&1 | tail -3" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Write-Ok ("OTA done in {0:N0} s; the board reboots" -f $sw.Elapsed.TotalSeconds)
        return
    }
    Write-Step 'pulling firmware.factory.bin...'
    $tmp = Join-Path $Root ".copilot-tmp\$NodeName.factory.bin"
    New-Item -ItemType Directory -Force (Split-Path $tmp) | Out-Null
    $b64 = ssh -o BatchMode=yes -p $HostSshPort $HostSsh "base64 -w0 $EsphomeDir/.esphome/build/$NodeName/build/firmware.factory.bin"
    [IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String($b64))
    Write-Ok "$((Get-Item $tmp).Length) bytes"
    Write-Step "flashing $ComPort over USB..."
    $sw.Restart()
    $flash = python -m esptool --port $ComPort --baud 460800 --chip esp32 write_flash 0x0 $tmp 2>&1
    $flash | Select-String -Pattern 'Wrote|verified|rror' | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    if (($flash -join "`n") -notmatch 'Hash of data verified') {
        Write-Warn "esptool did not verify the write on $ComPort; falling back to OTA"
        ssh -o BatchMode=yes -p $HostSshPort $HostSsh "docker exec -w /config $EsphomeContainer esphome upload --device $NodeName.local $NodeName.yaml 2>&1 | tail -3" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Write-Ok 'OTA done; the board reboots'
        return
    }
    Write-Ok ("flashed over USB in {0:N0} s; the display shows the offline clock until it fetches the first frame (~20 s)" -f $sw.Elapsed.TotalSeconds)
}

function Show-Status {
    $ip = Get-LanIp
    $url = "http://${ip}:$LanPort/api/esp/display/${NodeName}"
    $hdr = Join-Path $Root '.copilot-tmp\esp-auth.hdr'
    New-Item -ItemType Directory -Force (Split-Path $hdr) | Out-Null
    # header via a file so the token never appears on a command line or in the output
    [IO.File]::WriteAllText($hdr, "Authorization: $(Get-AuthHeader)`n")
    $r = curl.exe -s -o NUL -w '%{http_code} %{size_download}B %{content_type}' -H "@$hdr" $url --max-time 6
    Remove-Item $hdr -ErrorAction SilentlyContinue
    Write-Host "  frame url  $url"
    Write-Host "  frame      $r $(if ($r -match '^200 1086B') { '(OK: 128x64 1-bit BMP)' } else { '<- expected 200 1086B image/bmp' })"
    $p = Test-Connection "$NodeName.local" -Count 1 -Quiet -ErrorAction SilentlyContinue
    Write-Host "  board      $NodeName.local $(if ($p) { 'answers ping' } else { 'no ping (mDNS?)' })"
    try {
        $h = @{ Authorization = "Bearer $env:HA_TOKEN" }
        # HA prefixes entity ids with the device's area ("office_…"), so match by suffix.
        $slug = $NodeName -replace '-', '_'
        $all = Invoke-RestMethod "$($env:HA_URL.TrimEnd('/'))/api/states" -Headers $h
        foreach ($suffix in 'wifi_signal', 'heap_free', 'loop_time', 'uptime', 'ip') {
            $s = $all | Where-Object { $_.entity_id -match "^sensor\..*${slug}_${suffix}$" } | Select-Object -First 1
            if ($s) { Write-Host ("  {0,-10} {1} {2}" -f $suffix, $s.state, $s.attributes.unit_of_measurement) }
        }
    } catch { Write-Host '  ha         unreachable' }
}

function Show-Preview([string]$view) {
    $script = @"
import { renderView } from './src/lib/esp/views';
import { ha } from './src/lib/home/ha-client';
const all = await ha.states().catch(() => []);
const fb = await renderView('$view' as any, { states: new Map(all.map((s: any) => [s.entity_id, s])), now: new Date(), node: '$NodeName', paused: false, ambilightMode: 'movie' });
console.log(fb.toAscii());
"@
    $tmp = Join-Path $Root '.copilot-tmp\esp-preview.mts'
    Set-Content $tmp $script -Encoding utf8
    Push-Location $Root
    try { pnpm exec tsx --tsconfig tsconfig.json $tmp } finally { Pop-Location }
}

function Show-Logs {
    # ESPHome's native API streams the logger over WiFi — no USB needed. Runs
    # inside the add-on on the appliance because that is where the compiled
    # config (and its API key) lives.
    $cmd = "docker exec -w /config $EsphomeContainer esphome logs --device $NodeName.local $NodeName.yaml 2>&1"
    # Every `esphome logs` holds ONE API slot on the board for as long as the
    # python process lives. Killing the ssh client from Windows does NOT kill
    # the remote process, so four orphans from 2026-09-16 pinned all 3 slots
    # for hours: serial showed "Max connections (3), rejecting <HA>", HA
    # logged "connection dropped immediately after encrypted hello", cold
    # power-cycles did not help because the orphans reconnected first.
    # Reap them before opening a new stream, and prefer USB when local.
    Reap-LogStreams
    $c = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM\d+\)' -and $_.HardwareID -match 'VID_1A86&PID_7523|VID_10C4' } | Select-Object -First 1
    if ($c -and -not $Ota) {
        $port = [regex]::Match($c.Name, 'COM\d+').Value
        Write-Step "log stream from $NodeName over USB $port (no API slot used; Ctrl+C to stop)"
        python -c "import serial,sys,re;a=re.compile(r'\x1b\[[0-9;]*m');s=serial.Serial();s.port='$port';s.baudrate=115200;s.timeout=1;s.dtr=False;s.rts=False;s.open()
while True:
    l=s.readline().decode('utf-8','replace').strip()
    if l: print(a.sub('',l),flush=True)"
        return
    }
    if ($Seconds -le 0) { $Seconds = 600 }   # never leave an unbounded stream holding a slot
    $cmd = "timeout $Seconds $cmd"
    Write-Step "log stream from $NodeName over WiFi ($Seconds s max; holds one of the board's 3 API slots)"
    ssh -t -o BatchMode=yes -p $HostSshPort $HostSsh $cmd
}

function Reap-LogStreams {
    $sh = 'docker exec $EsphomeContainer sh -c ''for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in *esphome*logs*) echo ${p#/proc/}; kill ${p#/proc/};; esac; done'''
    $killed = @(ssh -o BatchMode=yes -p $HostSshPort $HostSsh $sh 2>$null)
    if ($killed.Count) { Write-Warn "reaped $($killed.Count) orphaned 'esphome logs' stream(s) in the add-on (pids $($killed -join ', ')) — each held an API slot" }
}

switch ($PSCmdlet.ParameterSetName) {
    'Publish' { Publish-Lan; Show-Status }
    'Flash' { Flash-Board }
    'Preview' { Show-Preview $Preview }
    'Logs' { Show-Logs }
    default { Reap-LogStreams; Show-Status }
}
