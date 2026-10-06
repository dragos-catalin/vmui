<#
.SYNOPSIS
  Publish Home Assistant on the Pi at https://home.dragoscatalin.ro.

  DNS A -> 192.168.100.232 (LAN; the Nest Hub must reach it for casting), cert
  via lego DNS-01 through Brivio (exec hook pi/brivio-acme-hook.sh, token
  .private/publish/brivio-acme-homepi.token = a brv_dns_ ACME token for the
  dragoscatalin.ro zone, created at brivio.ro > DNS > Token-uri API), Caddy on
  the Pi, HA external_url/internal_url set. The zone lives in Brivio since
  2026-10-05 (NS ns1/ns2.fabricai.ro); the A record is checked here, edited there.
  The Pi advertises 192.168.100.0/24 on the tailnet, so the same name works
  away from home once the route is approved in the Tailscale admin console.

.EXAMPLE
  scripts\pi-publish-ha.ps1
#>
[CmdletBinding()]
param(
    [string]$Domain = 'home.dragoscatalin.ro',
    [string]$LanIp = '192.168.100.232',
    [string]$Pi = 'homepi',
    [string]$Email = 'vladulescu.catalin@gmail.com'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'scripts\lib\guest-credentials.ps1') | Out-Null
if (-not $env:HA_TOKEN) { throw 'HA_TOKEN missing in .private/credentials.env' }
$TokenFile = Join-Path $Root '.private\publish\brivio-acme-homepi.token'
if (-not (Test-Path $TokenFile)) { throw "missing $TokenFile (Brivio > DNS > dragoscatalin.ro > Token-uri API, purpose acme)" }

Write-Host "dns: $Domain A $LanIp (Brivio zone, checked at ns1.fabricai.ro)"
$auth = (Resolve-DnsName $Domain -Type A -Server ns1.fabricai.ro -DnsOnly -ErrorAction SilentlyContinue | Where-Object Type -eq A).IPAddress
if ($auth -ne $LanIp) { throw "A $Domain at ns1.fabricai.ro is '$auth', want $LanIp - fix it in Brivio > DNS" }
Write-Host "  ok"

Write-Host "pi: tailscale + lego + caddy"
$sh = (Get-Content (Join-Path $Root 'pi\publish-ha.sh') -Raw) -replace "`r`n", "`n"
[IO.File]::WriteAllText((Join-Path $Root '.copilot-tmp\pi\publish-ha.sh'), $sh, [Text.UTF8Encoding]::new($false))
scp -q -o BatchMode=yes (Join-Path $Root '.copilot-tmp\pi\publish-ha.sh') "${Pi}:/tmp/publish-ha.sh"
foreach ($f in 'brivio-acme-hook.sh', 'caddy-wait-network.conf') {
  $c = (Get-Content (Join-Path $Root "pi\$f") -Raw) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $Root ".copilot-tmp\pi\$f"), $c, [Text.UTF8Encoding]::new($false))
  scp -q -o BatchMode=yes (Join-Path $Root ".copilot-tmp\pi\$f") "${Pi}:/tmp/$f"
}
# the token travels as a file (scp), never on a command line
scp -q -o BatchMode=yes $TokenFile "${Pi}:/tmp/brivio-acme.token"
$envLine = "LE_EMAIL='$Email' DOMAIN='$Domain' LAN_IP='$LanIp'"
$out = ssh -o BatchMode=yes $Pi "$envLine bash /tmp/publish-ha.sh; rm -f /tmp/publish-ha.sh"
if ($LASTEXITCODE -ne 0) { throw "publish-ha.sh failed ($LASTEXITCODE)" }
$out | ForEach-Object { $_ }

Write-Host "ha: external_url / internal_url"
$h = @{ Authorization = "Bearer $env:HA_TOKEN"; 'content-type' = 'application/json' }
$cfg = Invoke-RestMethod "http://$LanIp/api/config" -Headers $h
# publish-ha.sh prints this only when it appended the http: block (was: grep -c, true on every run -> HA restarted every time)
$needRestart = [bool]($out -match 'restart needed')
if ($cfg.external_url -ne "https://$Domain") {
  # core config lives in .storage/core.config; the supported write path is the
  # websocket `config/core/update` (pi/ha-set-urls.cjs, run from the vmui dir for `ws`).
  scp -q -o BatchMode=yes (Join-Path $Root 'pi\ha-set-urls.cjs') "${Pi}:/srv/homepi/vmui/.ha-set-urls.cjs"
  # token as base64 in the remote command: a piped token picks up CRLF and HA answers auth_invalid
  $b = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($env:HA_TOKEN.Trim()))
  $remote = 'cd /srv/homepi/vmui && T=$(echo ' + $b + ' | base64 -d) timeout 20 node .ha-set-urls.cjs https://' + $Domain + ' http://' + $LanIp + '; rm -f .ha-set-urls.cjs'
  ssh -o BatchMode=yes $Pi $remote 2>&1 | ForEach-Object { "  $_" }
}
  if ($needRestart) { ssh -o BatchMode=yes $Pi 'docker restart homeassistant >/dev/null'; Write-Host "  HA restarted for http: trusted_proxies"; Start-Sleep 60 }

Write-Host "verify"
$ip = (Resolve-DnsName $Domain -Type A -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
Write-Host "  dns -> $ip"
Write-Host "  https -> $((curl.exe -s -m 10 -o NUL -w '%{http_code}' "https://$Domain/"))"
$cfg = Invoke-RestMethod "https://$Domain/api/config" -Headers $h
Write-Host "  external_url=$($cfg.external_url) internal_url=$($cfg.internal_url)"
