<#
.SYNOPSIS
  Deploy the Romanian egress proxy (3proxy) to homepi: sync pi/egress-proxy,
  hash the per-app passwords from .private/egress-proxy.env on the Pi, and
  `docker compose up -d`. Does not touch vmui (that is pi-deploy.ps1).
.EXAMPLE
  pwsh -File scripts\pi-egress-proxy.ps1            # sync + up
  pwsh -File scripts\pi-egress-proxy.ps1 -NewApp foo # add EGRESS_PASS_FOO to .private, then sync + up
#>
param(
  [string] $Pi = 'homepi',
  [string] $Dest = '/srv/homepi/egress-proxy',
  [string] $NewApp
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$envFile = Join-Path $root '.private\egress-proxy.env'

if ($NewApp) {
  $key = 'EGRESS_PASS_' + $NewApp.ToUpperInvariant()
  $existing = if (Test-Path $envFile) { Get-Content $envFile } else { @() }
  if ($existing -match "^$key=") { throw "$key already exists in $envFile" }
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $pw = -join (1..32 | ForEach-Object { $chars[[Security.Cryptography.RandomNumberGenerator]::GetInt32($chars.Length)] })
  New-Item -ItemType Directory -Force (Split-Path $envFile) | Out-Null
  [IO.File]::AppendAllText($envFile, "$key=$pw`n", [Text.UTF8Encoding]::new($false))
  Write-Host "added $key (length $($pw.Length)) to .private\egress-proxy.env"
  Remove-Variable pw
}
if (-not (Test-Path $envFile)) { throw "$envFile missing — run with -NewApp <name>" }
git check-ignore -q -- '.private/egress-proxy.env'
if ($LASTEXITCODE -ne 0) { throw '.private/egress-proxy.env is NOT gitignored — refusing' }

ssh -o BatchMode=yes $Pi "sudo mkdir -p $Dest && sudo chown `$(id -u):`$(id -g) $Dest"
# after a reboot docker can start before tailscaled owns 100.82.141.110; let 3proxy bind it anyway
ssh -o BatchMode=yes $Pi "echo net.ipv4.ip_nonlocal_bind=1 | sudo tee /etc/sysctl.d/90-egress-proxy.conf >/dev/null; echo 1 | sudo tee /proc/sys/net/ipv4/ip_nonlocal_bind >/dev/null"
foreach ($f in 'compose.yaml', '3proxy.cfg', 'gen-passwd.sh') {
  # scp, not a pipe: PowerShell appends CRLF to piped native stdin
  $tmp = Join-Path $root ".copilot-tmp\pi\$f"
  New-Item -ItemType Directory -Force (Split-Path $tmp) | Out-Null
  [IO.File]::WriteAllText($tmp, ((Get-Content -Raw "pi\egress-proxy\$f") -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
  scp -q -o BatchMode=yes $tmp "${Pi}:$Dest/$f"
}
# passwords go over stdin and are hashed on the Pi; cleartext is never written there
((Get-Content -Raw $envFile) -replace "`r`n", "`n") | ssh -o BatchMode=yes $Pi "sh $Dest/gen-passwd.sh $Dest/passwd"
if ($LASTEXITCODE -ne 0) { throw "gen-passwd failed ($LASTEXITCODE)" }

$remote = @"
set -e; cd $Dest
docker compose up -d --remove-orphans 2>&1 | tail -3
sleep 2
docker compose ps --format '{{.Name}} {{.State}} {{.Status}}'
ss -ltn | awk '`$4 ~ /:3128$/ {print "listen", `$4}'
"@ -replace "`r`n", "`n"
ssh -o BatchMode=yes $Pi $remote
