#requires -version 7
<#
.SYNOPSIS
  Serve vmui at https://mui.dragoscatalin.ro — tailnet-only, real certificate.

.DESCRIPTION
  Same shape as home.dragoscatalin.ro on the appliance, but on this PC:

    phone/laptop (tailnet) ──443──► Caddy (this PC) ──► http://127.0.0.1:3737 (next start / dev)
                                      │ cert: Let's Encrypt via lego, DNS-01 on Vercel
    DNS: A mui.dragoscatalin.ro → 100.95.246.105 (tailnet IP; unreachable off-tailnet)

  Why not Tailscale Serve alone: Serve gives a *.ts.net cert for the ts.net
  name only; a custom hostname needs our own certificate. Why Caddy and not
  Serve as the TLS terminator: Serve cannot load an external cert.

  Everything is idempotent. Run again after a reboot or a cert renewal.

.EXAMPLE
  publish-vmui.ps1                 # dns + cert + caddy task + verify
  publish-vmui.ps1 -Status
  publish-vmui.ps1 -Renew          # force lego renew, reload caddy
  publish-vmui.ps1 -Ensure         # every 5 min: re-attach route if the host Caddy restarted
  publish-vmui.ps1 -Remove
#>
[CmdletBinding(DefaultParameterSetName = 'Publish')]
param(
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    [Parameter(ParameterSetName = 'Renew')][switch]$Renew,
    [Parameter(ParameterSetName = 'Ensure')][switch]$Ensure,
    [Parameter(ParameterSetName = 'Remove')][switch]$Remove,
    # With -Renew: renew even when >30 days remain (manual only; LE allows 5 duplicates/week).
    [Parameter(ParameterSetName = 'Renew')][switch]$Force,
    [string]$Domain = 'mui.dragoscatalin.ro',
    [int]$Upstream = 3737
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\guest-credentials.ps1') | Out-Null

$Root = Split-Path $PSScriptRoot -Parent
$StateDir = Join-Path $Root '.private\publish'
$LegoDir = Join-Path $StateDir 'lego'
$Caddyfile = Join-Path $StateDir 'Caddyfile'
$TaskName = 'vmui-publish-caddy'
$RenewTask = 'vmui-publish-renew'
$EnsureTask = 'vmui-publish-ensure'
$TailnetIp = (tailscale ip -4 2>$null | Select-Object -First 1)
if (-not $TailnetIp) { throw 'tailscale is not running on this PC' }
$Zone = ($Domain -split '\.', 2)[1]
$Sub = ($Domain -split '\.', 2)[0]
$Caddy = (Get-Command caddy).Source
$Lego = (Get-Command lego).Source
$Email = 'vladulescu.catalin@gmail.com'

function Write-Ok($m) { Write-Host "  $m" -ForegroundColor Green }
function Write-Step($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Write-Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Get-LanIp {
    # Hyper-V external switch address the ESP32 reaches; same helper as esp32-display.ps1.
    (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.100.*' } | Select-Object -First 1).IPAddress
}

# ---------- DNS (Brivio zone since 2026-10-05, NS ns1/ns2.fabricai.ro) ----------
# The A record is edited in Brivio > DNS; here we only check the authoritative answer.
function Get-AuthA([string]$Name) {
    (Resolve-DnsName $Name -Type A -Server ns1.fabricai.ro -DnsOnly -ErrorAction SilentlyContinue | Where-Object Type -eq A).IPAddress
}
function Ensure-Dns {
    Write-Step "DNS: $Domain A $TailnetIp"
    $a = Get-AuthA $Domain
    if ($a -eq $TailnetIp) { Write-Ok 'already correct'; return }
    throw "A $Domain at ns1.fabricai.ro is '$a', want $TailnetIp - set it in Brivio > DNS > $Zone"
}

# ---------- certificate ----------
function Cert-Paths {
    @{ crt = Join-Path $LegoDir ".lego\certificates\$Domain.crt"; key = Join-Path $LegoDir ".lego\certificates\$Domain.key" }
}

function Ensure-Cert([switch]$Force) {
    New-Item -ItemType Directory -Force $LegoDir | Out-Null
    $p = Cert-Paths
    # lego 5: one `run` both obtains and renews; state lives in ./.lego of
    # the working directory (there is no --path any more).
    # DNS-01 through Brivio: scripts/brivio-acme-hook.cmd -> POST brivio.ro/api/dns/acme with a
    # brv_dns_ token (.private/publish/brivio-acme-pc.token) that may only write _acme-challenge* TXT.
    $env:EXEC_PATH = Join-Path $PSScriptRoot 'brivio-acme-hook.cmd'
    $env:EXEC_PROPAGATION_TIMEOUT = '300'; $env:EXEC_POLLING_INTERVAL = '5'
    $args = @('run', '--accept-tos', '--email', $Email, '--dns', 'exec', '--dns.resolvers', '80.97.27.170:53,80.97.27.78:53', '-d', $Domain, '--renew-days', '30', '--no-random-sleep')
    if ($Force) { $args += '--renew-force' }
    if (Test-Path $p.crt) {
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($p.crt)
        Write-Step ("cert: {0:N0} days left" -f ($cert.NotAfter - (Get-Date)).TotalDays)
    }
    else { Write-Step 'cert: requesting via DNS-01 on Brivio' }
    Push-Location $LegoDir
    try { & $Lego @args 2>&1 | Select-Object -Last 3 } finally { Pop-Location }
    if (-not (Test-Path $p.crt)) { throw 'lego did not produce a certificate' }
    Write-Ok 'certificate ready'
}

# ---------- caddy ----------
function Write-Caddyfile {
    $p = Cert-Paths
    $crt = $p.crt -replace '\\', '/'
    $key = $p.key -replace '\\', '/'
    @"
{
	admin localhost:2019
	auto_https off
}

https://$Domain {
	# Only tailnet addresses ever reach this socket; the A record points at a
	# 100.64/10 address. Binding to the tailnet IP makes that a hard rule.
	bind $TailnetIp
	tls $crt $key
	encode zstd gzip
	reverse_proxy 127.0.0.1:$Upstream {
		header_up X-Forwarded-Proto https
		header_up X-Real-IP {remote_host}
		# SSE (live states) must not be buffered.
		flush_interval -1
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
	log {
		output file $(($StateDir -replace '\\','/'))/caddy-access.log {
			roll_size 10mb
			roll_keep 3
		}
	}
}

# ESP32 desk display: plain HTTP on the LAN switch address, /api/esp/* only
# (token-gated upstream). Mirrors esp32-display.ps1 -Publish for the case
# where our own Caddy owns :443. /api/mcp is the LAN fallback for the codai
# phone when its Tailscale VPN is off (bearer vmui_* checked upstream).
http://$(Get-LanIp):8737 {
	bind $(Get-LanIp)
    handle /api/esp/* {
        reverse_proxy 127.0.0.1:$Upstream
    }
    handle /api/mcp {
        reverse_proxy 127.0.0.1:$Upstream
    }
    handle {
        respond 404
    }
}
"@ | Set-Content -Path $Caddyfile -Encoding utf8 -NoNewline
    & $Caddy fmt --overwrite $Caddyfile | Out-Null
    & $Caddy validate --config $Caddyfile 2>&1 | Select-Object -Last 1
}

function Ensure-CaddyTask {
    $vbs = Join-Path $PSScriptRoot 'hidden-run.vbs'
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" `"$Caddy`" run --config `"$Caddyfile`"" -WorkingDirectory $StateDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $trigger.Delay = 'PT15S'
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'vmui: Caddy TLS front for mui.dragoscatalin.ro (scripts/publish-vmui.ps1)' | Out-Null

    # Daily renew check; lego exits immediately when >30 days remain.
    $ra = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" pwsh -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Renew" -WorkingDirectory $Root
    $rt = New-ScheduledTaskTrigger -Daily -At '04:40'
    Unregister-ScheduledTask -TaskName $RenewTask -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $RenewTask -Action $ra -Trigger $rt -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden) -Description 'vmui: renew mui.dragoscatalin.ro certificate' | Out-Null

    # The route lives inside whichever Caddy owns :443. When that one (brivio's
    # dev proxy) restarts, our route is gone until someone re-attaches it.
    # Interactive logon (not S4U): S4U processes are unkillable from the
    # desktop and cannot see the user's Caddy admin port; hidden-run.vbs is what
    # keeps the pwsh window from flashing every 5 min.
    $ea = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" pwsh -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Ensure" -WorkingDirectory $Root
    $et = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)
    $ep = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    Unregister-ScheduledTask -TaskName $EnsureTask -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $EnsureTask -Action $ea -Trigger $et -Principal $ep -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)) -Description 'vmui: keep mui.dragoscatalin.ro route attached to the :443 Caddy' | Out-Null
    Write-Ok "tasks $TaskName, $RenewTask, $EnsureTask"
}

function Ensure-Attached {
    $foreign = Get-ForeignCaddyAdmin
    if ($foreign) {
        # Caddy answers 200 `null` for an unknown @id, so test the value.
        $have = $null
        try { $have = Invoke-RestMethod "http://127.0.0.1:$($foreign.port)/id/vmui-mui" -TimeoutSec 3 } catch {}
        if (-not $have) { Write-Step 'route missing from host caddy; re-attaching'; Attach-ToForeignCaddy $foreign }
        # The ESP32 display's plain-HTTP LAN server lives in the same Caddy.
        $esp = $null
        try { $esp = Invoke-RestMethod "http://127.0.0.1:$($foreign.port)/config/apps/http/servers/vmui_esp" -TimeoutSec 3 } catch {}
        if (-not $esp) {
            Write-Step 'esp server missing; re-publishing'
            & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'esp32-display.ps1') -Publish 2>&1 | Where-Object { $_ -notmatch '^VERBOSE' } | ForEach-Object { Write-Host "    $_" }
        }
        return
    }
    # :443 is free or ours: run our own front (Caddyfile carries mui + the ESP :8737 server).
    if (-not (Get-Process caddy -ErrorAction SilentlyContinue)) {
        Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Write-Step 'no caddy on :443; started own'
        return
    }
    $espUp = (Test-NetConnection -ComputerName (Get-LanIp) -Port 8737 -WarningAction SilentlyContinue -InformationLevel Quiet)
    if (-not $espUp) {
        Write-Step 'own caddy up but :8737 (ESP) missing; reloading Caddyfile'
        Write-Caddyfile | Out-Null
        try { Invoke-RestMethod -Method POST -Uri 'http://localhost:2019/load' -ContentType 'text/caddyfile' -Body (Get-Content $Caddyfile -Raw) | Out-Null; Write-Ok 'caddy reloaded' } catch { Write-Warn "reload failed: $($_.Exception.Message)" }
    }
}

function Restart-Caddy {
    # Another Caddy (brivio's local dev proxy, elevated, admin :22019) may
    # already own :443 on every address. Then we cannot bind; we add our host
    # to it instead. SNI picks the right route, cert comes from our files.
    $foreign = Get-ForeignCaddyAdmin
    if ($foreign) { Attach-ToForeignCaddy $foreign; return }
    $running = Get-Process caddy -ErrorAction SilentlyContinue
    if ($running) {
        try { Invoke-RestMethod -Method POST -Uri 'http://localhost:2019/load' -ContentType 'text/caddyfile' -Body (Get-Content $Caddyfile -Raw) | Out-Null; Write-Ok 'caddy reloaded'; return } catch {}
        $running | Stop-Process -Force
    }
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep 3
    if (Get-Process caddy -ErrorAction SilentlyContinue) { Write-Ok 'caddy running' } else { throw 'caddy failed to start; see .private/publish' }
}

function Get-ForeignCaddyAdmin {
    $l = Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $l) { return $null }
    $owner = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    if ($owner -and $owner.Path -and $owner.Path -like "$env:LOCALAPPDATA*") { return $null }   # that is ours
    foreach ($port in 22019, 2019) {
        try {
            $cfg = Invoke-RestMethod "http://127.0.0.1:$port/config/" -TimeoutSec 3
            if ($cfg.apps.http.servers) { return @{ port = $port; cfg = $cfg } }
        } catch {}
    }
    throw "something holds :443 (pid $($l.OwningProcess)) but exposes no Caddy admin API"
}

function Set-CaddyPath($base, $path, $json) {
    # Caddy admin: PUT creates, PATCH replaces, POST appends to arrays.
    $exists = $true
    try { Invoke-RestMethod "$base$path" -TimeoutSec 3 | Out-Null } catch { $exists = $false }
    $m = if ($exists) { 'PATCH' } else { 'PUT' }
    Invoke-RestMethod -Method $m "$base$path" -ContentType 'application/json' -Body $json | Out-Null
}

function Attach-ToForeignCaddy($admin) {
    $base = "http://127.0.0.1:$($admin.port)"
    $srvName = ($admin.cfg.apps.http.servers.PSObject.Properties | Where-Object { $_.Value.listen -contains ':443' } | Select-Object -First 1).Name
    if (-not $srvName) { throw 'foreign caddy has no :443 server' }
    $p = Cert-Paths
    $route = @{
        '@id'    = 'vmui-mui'
        match    = @(@{ host = @($Domain) })
        terminal = $true
        handle   = @(
            @{ handler = 'encode'; encodings = @{ zstd = @{}; gzip = @{} }; prefer = @('zstd', 'gzip') },
            @{ handler = 'headers'; response = @{ set = @{ 'Strict-Transport-Security' = @('max-age=31536000'); 'X-Content-Type-Options' = @('nosniff'); 'Referrer-Policy' = @('strict-origin-when-cross-origin') } } },
            @{ handler = 'reverse_proxy'; upstreams = @(@{ dial = "127.0.0.1:$Upstream" }); flush_interval = -1
               headers = @{ request = @{ set = @{ 'X-Forwarded-Proto' = @('https'); 'X-Real-IP' = @('{http.request.remote.host}') } } } }
        )
    }
    $json = $route | ConvertTo-Json -Depth 12 -Compress
    $exists = $false
    try { Invoke-RestMethod "$base/id/vmui-mui" -TimeoutSec 3 | Out-Null; $exists = $true } catch {}
    if ($exists) { Invoke-RestMethod -Method PATCH "$base/id/vmui-mui" -ContentType 'application/json' -Body $json | Out-Null }
    else {
        # Prepend: the brivio route is `terminal` but host-matched, so order
        # only matters for a request matching neither; keep ours first anyway.
        Invoke-RestMethod -Method PUT "$base/config/apps/http/servers/$srvName/routes/0" -ContentType 'application/json' -Body $json | Out-Null
    }

    # Certificate: load_files entry keyed by our tag; replace if present.
    $certEntry = @{ certificate = ($p.crt -replace '\\', '/'); key = ($p.key -replace '\\', '/'); tags = @('vmui-mui') }
    $tls = $admin.cfg.apps.tls
    $existing = @()
    if ($tls -and $tls.certificates -and $tls.certificates.load_files) { $existing = @($tls.certificates.load_files | Where-Object { -not ($_.tags -contains 'vmui-mui') }) }
    $loadFiles = @($existing) + @($certEntry)
    if (-not $tls) { Invoke-RestMethod -Method PUT "$base/config/apps/tls" -ContentType 'application/json' -Body '{}' | Out-Null }
    if (-not ($tls -and $tls.certificates)) { Invoke-RestMethod -Method PUT "$base/config/apps/tls/certificates" -ContentType 'application/json' -Body '{}' | Out-Null }
    Set-CaddyPath $base '/config/apps/tls/certificates/load_files' ($loadFiles | ConvertTo-Json -Depth 5 -Compress -AsArray)

    # Keep automation from trying ACME for our name (we bring the cert).
    $skip = @($admin.cfg.apps.http.servers.$srvName.automatic_https.skip_certificates) + @($Domain) | Select-Object -Unique
    Set-CaddyPath $base "/config/apps/http/servers/$srvName/automatic_https/skip_certificates" ($skip | ConvertTo-Json -Compress -AsArray)
    Write-Ok "attached to existing caddy (admin :$($admin.port), server $srvName)"
    # Our own task must not fight for the port.
    Get-Process caddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$env:LOCALAPPDATA*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
}

function Test-Live {
    Write-Step "verify: https://$Domain"
    $r = curl.exe -s -o NUL -w '%{http_code} %{ssl_verify_result} %{time_total}' "https://$Domain/sign-in" --max-time 10
    if ($r -match '^(200|30\d) 0 ') { Write-Ok "live: $r" } else { Write-Warn "unexpected: $r" }
}

function Show-Status {
    $resolved = (Resolve-DnsName $Domain -Type A -ErrorAction SilentlyContinue | Where-Object Type -eq A | Select-Object -First 1).IPAddress
    Write-Host "  dns      $Domain -> $resolved (want $TailnetIp)"
    $p = Cert-Paths
    if (Test-Path $p.crt) { $c = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($p.crt); Write-Host ("  cert     expires {0:yyyy-MM-dd} ({1:N0} days)" -f $c.NotAfter, ($c.NotAfter - (Get-Date)).TotalDays) } else { Write-Host '  cert     none' }
    $t = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
    $live = if (Get-Process caddy -ErrorAction SilentlyContinue) { 'running' } else { 'NOT running' }
    Write-Host "  caddy    task=$($t ?? 'absent') process=$live"
    $up = Get-NetTCPConnection -LocalPort $Upstream -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    Write-Host "  upstream :$Upstream $(if ($up) { 'listening' } else { 'NOT listening - start vmui (pnpm start)' })"
    Test-Live
}

switch ($PSCmdlet.ParameterSetName) {
    'Status' { Show-Status }
    'Renew' {
        # The daily task calls this. Until 2026-10-06 it always forced, so LE issued a new cert every day.
        $p = Cert-Paths
        $before = if (Test-Path $p.crt) { (Get-FileHash $p.crt).Hash }
        Ensure-Cert -Force:$Force
        if ((Get-FileHash $p.crt).Hash -ne $before) { Write-Caddyfile; Restart-Caddy } else { Write-Ok 'not due; caddy untouched' }
        Test-Live
    }
    'Ensure' { Ensure-Attached }
    'Remove' {
        Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $RenewTask -Confirm:$false -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $EnsureTask -Confirm:$false -ErrorAction SilentlyContinue
        try { Invoke-RestMethod -Method DELETE 'http://127.0.0.1:22019/id/vmui-mui' -TimeoutSec 3 | Out-Null } catch {}
        Write-Ok "removed (cert files kept in .private/publish; delete the A record for $Domain in Brivio > DNS)"
    }
    default {
        Ensure-Dns
        Ensure-Cert
        Write-Caddyfile
        Ensure-CaddyTask
        Restart-Caddy
        Show-Status
    }
}
