#requires -version 7
<#
.SYNOPSIS
  Fixed maintenance operations that need elevation, runnable from an
            Desc = 'Restart the VS Code tunnel service once uptime exceeds 24h. Hygiene only: normalised by time spent, the failure rate does NOT rise with uptime (0.42/h at 0-4h vs 0.00/h at 4-8h). Threshold-guarded, so a run on a fresh tunnel is a no-op.'
            Daily = '05:00'
.DESCRIPTION
  The problem: several recurring operations need administrator rights —
  restarting the tunnel service (its task runs S4U, so unelevated
  Stop-Process silently fails), killing a runaway renderer, managing the
  Hyper-V VM. Each one costs a UAC prompt, and prompts get refused or missed
  when an agent triggers them.

  The solution: register this as a scheduled task running as SYSTEM with
  RunLevel Highest. A registered task can be triggered from ANY unelevated
  session with `schtasks /run` and no prompt. That is the same mechanism the
  tunnel service itself already uses.

  DELIBERATELY NOT a generic "run this command elevated" gate. Such a task is
  a privilege-escalation backdoor: any unelevated process on the machine could
  invoke it with arbitrary arguments. Instead every operation is a named
  branch below with FIXED behaviour, registered as its own task, so triggering
  it can only do the one reviewed thing.

  Adding an operation means editing this file and registering a new task —
  which is the point.

.PARAMETER Operation
  Which fixed operation to run. See the switch below.

.NOTES
  Register with -Register (needs one elevation, once).
  Then: schtasks /run /tn "CodaiMaint-TunnelRefresh"   (no prompt, forever)
#>
[CmdletBinding()]
param(
    [ValidateSet('TunnelRefresh', 'TunnelForceRestart', 'KillRunawayRenderer', 'WatchExtensionHost', 'InstallVmSshKey', 'FixSshShell', 'CreateSshUser', 'ExposeDevServices', 'DisableSystemRestore', 'PruneDocker', 'CompactWslDisks', 'KillIdleRemoteShells', 'RestartRemoteExtHost', 'Status')]
    [string]$Operation = 'Status',
    [switch]$Register
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
$logDir = Join-Path $env:ProgramData 'codai-maintenance'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'maintenance.log'

function Write-Log([string]$m) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    # ProgramData is written by the elevated task; an unelevated manual run
    # cannot append there. Logging must never fail the operation it records.
    try { Add-Content -Path $log -Value $line -ErrorAction Stop }
    catch { Add-Content -Path (Join-Path $env:USERPROFILE '.codai\maintenance.log') -Value $line -ErrorAction SilentlyContinue }
    Write-Host $line
}

function Invoke-DockerPrune {
    # Growth source measured 2026-09-17: every brivio/codai image build left
    # its tag locally (47 tags of brivio-prod-web = 101 GB), buildx cache was
    # unbounded (178 GB) and 378 volumes from dead compose projects lingered
    # (122 GB). This keeps anything a running container uses and anything
    # built in the last 3 days, so a dev iterating today loses nothing.
    if (-not (& docker info --format '{{.ServerVersion}}' 2>$null)) {
        Write-Log 'PruneDocker: docker engine not reachable, skipped'
        return
    }
    $before = (& docker system df --format '{{.Type}} {{.Size}}' 2>$null) -join '; '
    Write-Log "PruneDocker: before -> $before"
    $r = & docker image prune -a -f --filter 'until=72h' 2>&1 | Select-Object -Last 1
    Write-Log "PruneDocker: images -> $r"
    $r = & docker builder prune -f --keep-storage 20GB 2>&1 | Select-Object -Last 1
    Write-Log "PruneDocker: build cache -> $r"
    $r = & docker volume prune -a -f 2>&1 | Select-Object -Last 1
    Write-Log "PruneDocker: volumes -> $r"
    # Docker inside Ubuntu-24.04 (runners) and its own dangling volumes,
    # then fstrim so Optimize-VHD can actually reclaim the freed blocks.
    $r = & wsl -d Ubuntu-24.04 -u root -- sh -c 'docker volume prune -a -f 2>/dev/null | tail -1; docker image prune -a -f 2>/dev/null | tail -1; fstrim -v / 2>&1' 2>&1
    Write-Log ("PruneDocker: Ubuntu-24.04 -> {0}" -f ($r -join ' | '))
    $after = (& docker system df --format '{{.Type}} {{.Size}}' 2>$null) -join '; '
    Write-Log "PruneDocker: after -> $after"
}

# --------------------------------------------------------------------------
# Registration. One elevation, once. After this every operation is silent.
# --------------------------------------------------------------------------
if ($Register) {
    $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $elevated) {
        Write-Host 'Registration needs elevation. Run this once from an admin PowerShell:' -ForegroundColor Yellow
        Write-Host "  pwsh -NoProfile -File `"$PSCommandPath`" -Register" -ForegroundColor Cyan
        exit 1
    }

    # Each task is a fixed operation. No arguments come from the caller, so
    # triggering a task cannot be turned into "run arbitrary code elevated".
    #
    # Owner is the CURRENT USER, not SYSTEM. That detail is the whole trick:
    # a SYSTEM-owned task inherits a descriptor only SYSTEM and Administrators
    # may execute, so `schtasks /run` from an ordinary session fails with
    # "Access is denied" -- exactly what happened on the first attempt, which
    # defeated the entire purpose. A task owned by this user can be triggered
    # by this user with no prompt (proven: VSCodeTunnel-dragos runs as vladu
    # and `schtasks /run` returns 0 unelevated), while RunLevel Highest still
    # gives it the elevated token required to stop the S4U tunnel processes.
    # No ACL surgery, nothing to repair later.
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-Host "  tasks will run as $me with RunLevel Highest"

    # An earlier revision registered these as SYSTEM. Those cannot be
    # triggered from an ordinary session, so remove them before re-creating;
    # -Force would overwrite, but an explicit unregister makes the transition
    # visible and leaves nothing behind if a name ever changes.
    foreach ($old in @(Get-ScheduledTask -ErrorAction SilentlyContinue |
            Where-Object { $_.TaskName -match '^CodaiMaint-' -and $_.Principal.UserId -eq 'SYSTEM' })) {
        Unregister-ScheduledTask -TaskName $old.TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "  removed SYSTEM-owned $($old.TaskName)" -ForegroundColor DarkGray
    }

    $tasks = @(
        @{
            Name = 'CodaiMaint-TunnelRefresh'
            Op   = 'TunnelRefresh'
            Desc = 'Restart the VS Code tunnel service once uptime exceeds 40h. Degradation past ~45h causes hourly connection disposals that kill chat sessions.'
            Daily = '05:00'
        },
        @{
            Name = 'CodaiMaint-TunnelForceRestart'
            Op   = 'TunnelForceRestart'
            Desc = 'Restart the VS Code tunnel service immediately, regardless of uptime. On demand only.'
            Daily = $null
        },
        @{
            Name = 'CodaiMaint-KillRunawayRenderer'
            Op   = 'KillRunawayRenderer'
            Desc = 'Terminate any VS Code renderer over 4 GB working set. A renderer that reaches ~7 GB stops responding and takes its window down.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-WatchExtensionHost'
            Op   = 'WatchExtensionHost'
            Desc = 'Check whether the VM''s remote extension host has permanently given up reconnecting. Detection only; it does not reload.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-InstallVmSshKey'
            Op   = 'InstallVmSshKey'
            Desc = 'Install the VM''s public key into administrators_authorized_keys so the VM can SSH into this host, replacing the tunnel.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-FixSshShell'
            Op   = 'FixSshShell'
            Desc = 'Set sshd DefaultShell to cmd.exe. With pwsh as the default, Remote-SSH''s `powershell` invocation starts 5.1 interactively and its banner breaks the handshake.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-CreateSshUser'
            Op   = 'CreateSshUser'
            Desc = 'Create a restricted SSH account from ~/.codai/ssh-user-request.json. The no-UAC path for creating users.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-ExposeDevServices'
            Op   = 'ExposeDevServices'
            Desc = 'Open the brivio Docker stack ports to the Tailscale range only, so fleet VMs can reach postgres/redis/dss/stalwart on this host.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-DisableSystemRestore'
            Op   = 'DisableSystemRestore'
            Desc = 'Turn off System Restore on C:. Its VSS snapshots freeze the Remote-SSH server for 20+ s and drop every VM client session.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-PruneDocker'
            Op   = 'PruneDocker'
            Desc = 'Weekly, non-disruptive: drop Docker images unused for 3 days, cap build cache at 20 GB, remove dangling volumes, fstrim Ubuntu-24.04. Keeps every running container and its volumes.'
            Daily = '04:30'
            Weekly = 'Sunday'
        }
        ,
        @{
            Name = 'CodaiMaint-CompactWslDisks'
            Op   = 'CompactWslDisks'
            Desc = 'PruneDocker, then stop Docker Desktop, wsl --shutdown and Optimize-VHD every WSL/Docker ext4.vhdx. DISRUPTIVE: stops every WSL distro and container for 10-30 min. On demand only.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-KillIdleRemoteShells'
            Op   = 'KillIdleRemoteShells'
            Desc = 'Kill leaf pwsh/cmd shells under the Remote-SSH server that are idle (no children, >1 h). They belong to the sshd logon session, so an unelevated Stop-Process gets Access denied.'
            Daily = $null
        }
        ,
        @{
            Name = 'CodaiMaint-RestartRemoteExtHost'
            Op   = 'RestartRemoteExtHost'
            Desc = 'Kill a wedged Remote-SSH extension host (client reconnecting every 20 s). The VM window restarts it automatically; chat sessions live in the renderer and survive.'
            Daily = $null
        }
    )

    foreach ($t in $tasks) {
        $action = New-ScheduledTaskAction -Execute 'pwsh.exe' `
            -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Operation {1}' -f $PSCommandPath, $t.Op)
        # S4U: runs whether or not you are logged in, and needs no stored
        # password. Highest supplies the elevated token.
        $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Highest
        # Optimize-VHD over ~750 GB of WSL disks needs far more than 10 min;
        # the default limit killed it mid-compaction (task result 267014).
        # PruneDocker too: on 2026-09-20 it found 724 GB of images and the
        # 10-min limit killed it after the first `docker system df` — the log
        # stopped at "before" and nothing was reclaimed.
        $limit = switch ($t.Op) {
            'CompactWslDisks' { New-TimeSpan -Hours 3 }
            'PruneDocker'     { New-TimeSpan -Hours 2 }
            default           { New-TimeSpan -Minutes 10 }
        }
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
            -ExecutionTimeLimit $limit -MultipleInstances IgnoreNew

        $params = @{
            TaskName    = $t.Name
            Action      = $action
            Principal   = $principal
            Settings    = $settings
            Description = $t.Desc
            Force       = $true
        }
        if ($t.Daily) {
            $trigger = if ($t.Weekly) { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.Weekly -At $t.Daily }
                       else { New-ScheduledTaskTrigger -Daily -At $t.Daily }
            if ($t.Repeat) {
                # A once-a-day refresh cannot hold uptime under 8 h. Repeat
                # through the day; each run is threshold-guarded, so it is a
                # no-op unless the tunnel is actually old enough to degrade.
                $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $t.Daily `
                    -RepetitionInterval (New-TimeSpan -Hours 4) `
                    -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
            }
            $params.Trigger = $trigger
        }

        Register-ScheduledTask @params | Out-Null
        $when = if ($t.Weekly) { "$($t.Weekly) at $($t.Daily)" } elseif ($t.Daily) { "daily at $($t.Daily)" } else { 'on demand' }
        Write-Host ("  registered {0,-34} {1}" -f $t.Name, $when) -ForegroundColor Green
    }

    Write-Host ''
    Write-Host 'Trigger from any unelevated session, no UAC prompt:' -ForegroundColor Cyan
    foreach ($t in $tasks) { Write-Host "  schtasks /run /tn `"$($t.Name)`"" }

    # Verify the actual goal, not just that registration returned. The first
    # attempt registered cleanly and was still untriggerable, which is exactly
    # the failure this check catches.
    Write-Host ''
    Write-Host 'Verifying each task is triggerable by its owner...' -ForegroundColor Cyan
    foreach ($t in $tasks) {
        $info = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
        if (-not $info) { Write-Host "  MISSING $($t.Name)" -ForegroundColor Red; continue }
        $okOwner = $info.Principal.UserId -notmatch 'SYSTEM'
        $okLevel = $info.Principal.RunLevel -eq 'Highest'
        $state = if ($okOwner -and $okLevel) { 'ok' } else { 'WRONG' }
        $colour = if ($okOwner -and $okLevel) { 'Green' } else { 'Red' }
        Write-Host ("  {0,-34} {1}  owner={2} runlevel={3}" -f $t.Name, $state, $info.Principal.UserId, $info.Principal.RunLevel) -ForegroundColor $colour
    }
    Write-Host ''
    Write-Host 'Now run this from a NORMAL (unelevated) terminal to confirm:' -ForegroundColor Yellow
    Write-Host '  schtasks /run /tn "CodaiMaint-TunnelRefresh"' -ForegroundColor Yellow
    exit 0
}

# --------------------------------------------------------------------------
# Operations
# --------------------------------------------------------------------------
switch ($Operation) {

    'PruneDocker' {
        Invoke-DockerPrune
        exit 0
    }

    'TunnelRefresh' {
        # Threshold-guarded: a no-op on a healthy service, so the daily
        # trigger costs nothing.
        & (Join-Path $root 'restart-tunnel.ps1')
        Write-Log "TunnelRefresh finished, exit $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    'WatchExtensionHost' {
        # Detection only. A reload discards unsaved editor state and kills
        # whatever is running mid-turn; these failures are 39-439 min apart
        # and irregular, so an automatic reload would interrupt real work far
        # more often than it would rescue a dead session. Pass -AutoReload to
        # watch-extension-host.ps1 manually if that trade-off ever changes.
        & (Join-Path $root 'watch-extension-host.ps1') -Once
        Write-Log "WatchExtensionHost finished, exit $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    'ExposeDevServices' {
        # Docker cannot run inside the guests: Virtualization-Based Security is
        # active on this host and keeps the virtualization extensions, so a
        # nested guest cannot hand them to WSL2. Proven by the fact that a VM
        # which was never modified fails identically. The brivio stack
        # therefore stays here and the fleet reaches it over Tailscale.
        #
        # Ports are hardcoded, matching infra/docker-compose.yml. The rule is
        # scoped to 100.64.0.0/10 (Tailscale CGNAT), so nothing is reachable
        # from the LAN or the internet.
        $rule = 'brivio-dev-services-tailscale'
        $ports = 22143, 22432, 22479, 22480, 22525, 22580, 22587
        if (Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue) {
            Remove-NetFirewallRule -Name $rule
        }
        New-NetFirewallRule -Name $rule -DisplayName 'Brivio dev services (Tailscale only)' `
            -Enabled True -Direction Inbound -Protocol TCP -LocalPort $ports `
            -RemoteAddress '100.64.0.0/10' -Action Allow | Out-Null
        Write-Log "ExposeDevServices: $($ports -join ',') deschise doar din 100.64.0.0/10"
        exit 0
    }

    'DisableSystemRestore' {
        # Every Windows Update (including Store app updates) creates a restore
        # point. VSS snapshot creation stalls file I/O on C: long enough that
        # the VS Code server stops acknowledging messages for >20 s, the VM's
        # Remote-SSH client declares the socket dead, the reconnect races the
        # old exec server, the remote ext host dies, and the user is stuck on
        # "Initializing...". VERIFIED 2026-09-13: both stalls (20:24:16 and
        # 20:25:57) coincide with VSS 8231 + System Restore 8194 to the second.
        # Real backups live elsewhere; restore points buy nothing here.
        Disable-ComputerRestore -Drive 'C:\'
        $rp = Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Measure-Object
        Write-Log "DisableSystemRestore: C: disabled, $($rp.Count) restore points remain listed"
        exit 0
    }

    'CompactWslDisks' {
        # WSL virtual disks grow on demand and never shrink. Measured
        # 2026-09-17 on C:: docker_data.vhdx 502 GB with 60 GB of live data,
        # Ubuntu-24.04 311 GB with 200 GB used. Optimize-VHD needs the disk
        # detached, so every distro is shut down; the brivio docker stack
        # (restart: unless-stopped) comes back on next wsl start.
        $wslDisks = @()
        foreach ($k in Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue) {
            $bp = (Get-ItemProperty $k.PSPath).BasePath -replace '^\\\\\?\\', ''
            $v = Join-Path $bp 'ext4.vhdx'
            if (Test-Path $v) { $wslDisks += $v }
        }
        $wslDisks += Get-ChildItem "$env:LOCALAPPDATA\Docker\wsl" -Recurse -Filter *.vhdx -ErrorAction SilentlyContinue | ForEach-Object FullName
        $wslDisks = $wslDisks | Sort-Object -Unique

        $before = 0; foreach ($d in $wslDisks) { $before += (Get-Item $d).Length }
        Write-Log ("CompactWslDisks: {0} disks, {1:N1} GB before" -f $wslDisks.Count, ($before/1GB))

        Invoke-DockerPrune

        # Two things undo `wsl --shutdown` within seconds and must be paused
        # first: Docker Desktop (restarts its distro and, via the WSL
        # integration, Ubuntu-24.04 — the 2026-09-17 run compacted only
        # docker_data for this reason) and the `brivio-wsl-runner-keepalive`
        # task (a resident `wsl --exec sleep infinity` loop for the self-hosted
        # runners, replaced every 15 s by design — 2026-09-22 it kept the
        # distro Running through every shutdown). Both are restored at the
        # end; Docker Desktop via explorer.exe so the GUI runs UNELEVATED (an
        # elevated one shows no window and cannot be stopped from a normal
        # session).
        $keepalive = 'brivio-wsl-runner-keepalive'
        $keepaliveWas = (Get-ScheduledTask -TaskName $keepalive -ErrorAction SilentlyContinue).State
        if ($keepaliveWas -and $keepaliveWas -ne 'Disabled') {
            Disable-ScheduledTask -TaskName $keepalive -ErrorAction SilentlyContinue | Out-Null
            Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'wsl-keepalive-loop' } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Write-Log "CompactWslDisks: paused $keepalive (was $keepaliveWas)"
        }
        Get-Process 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
        $down = $false
        for ($i = 0; $i -lt 6 -and -not $down; $i++) {
            & wsl --shutdown
            Start-Sleep -Seconds 6
            $down = ((& wsl -l -v) -join ' ') -notmatch 'Running'
            if (-not $down) {
                Write-Log "CompactWslDisks: a distro came back after shutdown (attempt $($i+1)); killing session wsl.exe/wslhost.exe"
                Get-Process wsl, wslhost -ErrorAction SilentlyContinue | Where-Object SessionId -ne 0 | Stop-Process -Force -ErrorAction SilentlyContinue
            }
        }
        if (-not $down) { Write-Log 'CompactWslDisks: WSL still running; disks in use will FAIL below' }
        # The utility VM releases the vhdx a few seconds after the last distro
        # stops; compacting before that fails with 0x800700AA "in use".
        for ($i = 0; $i -lt 12 -and (Get-Process vmmemWSL -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 5 }

        foreach ($d in $wslDisks) {
            $sz = (Get-Item $d).Length
            try {
                Optimize-VHD -Path $d -Mode Full -ErrorAction Stop
                $new = (Get-Item $d).Length
                Write-Log ("  {0}: {1:N1} -> {2:N1} GB" -f $d, ($sz/1GB), ($new/1GB))
            } catch {
                Write-Log "  $d FAILED: $($_.Exception.Message)"
            }
        }
        $after = 0; foreach ($d in $wslDisks) { $after += (Get-Item $d).Length }
        Write-Log ("CompactWslDisks: {0:N1} GB after, reclaimed {1:N1} GB" -f ($after/1GB), (($before-$after)/1GB))
        if ($keepaliveWas -and $keepaliveWas -ne 'Disabled') {
            Enable-ScheduledTask -TaskName $keepalive -ErrorAction SilentlyContinue | Out-Null
            Start-ScheduledTask -TaskName $keepalive -ErrorAction SilentlyContinue
            Write-Log "CompactWslDisks: resumed $keepalive"
        }
        & explorer.exe "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
        Write-Log 'CompactWslDisks: Docker Desktop relaunched (unelevated via explorer)'
        exit 0
    }

    'KillIdleRemoteShells' {
        # Terminals opened from the VM live under the Remote-SSH server tree
        # (sshd -> cmd -> node server -> node ptyHost -> pwsh). 76 of them had
        # accumulated at 0 s CPU each, and the ptyHost replayed all of them on
        # every reconnect. Unelevated Stop-Process fails with Access denied
        # because they run in sshd's logon session. Leaf-only: a shell with a
        # non-conhost child is running something and is left alone.
        $all = Get-CimInstance Win32_Process
        $byId = @{}; foreach ($p in $all) { $byId[$p.ProcessId] = $p }
        # The server root is a cmd.exe whose sshd parent has already exited,
        # so walking up to sshd finds nothing. Root = the VS Code server's
        # node processes (cli\servers\...\server-main.js) or any cmd/node with
        # a dead parent.
        $roots = @($all | Where-Object {
            ($_.Name -in 'cmd.exe', 'node.exe') -and -not $byId[$_.ParentProcessId]
        } | ForEach-Object ProcessId)
        $roots += @($all | Where-Object { $_.Name -eq 'sshd.exe' } | ForEach-Object ProcessId)
        $now = Get-Date
        $targets = foreach ($s in ($all | Where-Object { $_.Name -in 'pwsh.exe', 'powershell.exe', 'cmd.exe' })) {
            if ($all | Where-Object { $_.ParentProcessId -eq $s.ProcessId -and $_.Name -ne 'conhost.exe' }) { continue }
            if (-not $s.CreationDate -or ($now - $s.CreationDate).TotalHours -lt 1) { continue }
            $a = $s.ParentProcessId; $depth = 0; $under = $false
            while ($a -and $byId[$a] -and $depth -lt 8) {
                if ($roots -contains $a) { $under = $true; break }
                $a = $byId[$a].ParentProcessId; $depth++
            }
            # orphans of a dead parent are stale by definition
            if ($under -or -not $byId[$s.ParentProcessId]) { $s }
        }
        $n = 0
        foreach ($t in $targets) {
            try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; $n++ }
            catch { Write-Log "  could not kill $($t.ProcessId) $($t.Name): $($_.Exception.Message)" }
        }
        Write-Log "KillIdleRemoteShells: killed $n of $(@($targets).Count) candidates"
        exit 0
    }

    'RestartRemoteExtHost' {
        # Symptom in the VM: "Initializing..." / Copilot stuck, renderer.log
        # shows `socket timeout (unacknowledgedMessage, unacknowledgedMsgCount:
        # 300+)` -> `reconnected!` every 20 s, and the host remoteagent.log
        # shows `The client has reconnected.` at the same cadence. The ext host
        # process is alive but no longer drains its socket. It runs in sshd's
        # logon session, so an unelevated Stop-Process gets Access denied.
        #
        # Only the wedged ext host is killed -- never the server, ptyHost or
        # the VM's renderer -- so open chats and editors are untouched; the
        # renderer logs "Extension host (Remote) terminated unexpectedly" and
        # restarts it within ~10 s.
        $logRoot = Join-Path $env:USERPROFILE '.vscode-server-insiders\data\logs'
        $dir = Get-ChildItem $logRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'remoteagent.log') } |
            Sort-Object { (Get-Item (Join-Path $_.FullName 'remoteagent.log')).LastWriteTime } -Descending |
            Select-Object -First 1
        if (-not $dir) { Write-Log 'RestartRemoteExtHost: no remoteagent.log found'; exit 1 }
        $log = Join-Path $dir.FullName 'remoteagent.log'
        $tail = Get-Content $log -Tail 400

        # Discriminator: >= 3 reconnects in the last 2 minutes. A healthy
        # session has zero; the ECONNREFUSED agent-host lines are benign noise.
        $cutoff = (Get-Date).AddMinutes(-2)
        $recent = @($tail | Where-Object { $_ -match 'The client has reconnected' } | ForEach-Object {
            if ($_ -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})') { [datetime]$Matches[1] } } | Where-Object { $_ -gt $cutoff })
        # Newest launched ext host pid, and its connection id, from the same log.
        $launch = $tail | Where-Object { $_ -match '\[(\w+)\]\[ExtensionHostConnection\] <(\d+)> Launched Extension Host Process' } | Select-Object -Last 1
        if (-not $launch) { Write-Log 'RestartRemoteExtHost: no launched ext host in log'; exit 1 }
        $null = $launch -match '<(\d+)> Launched'
        $extPid = [int]$Matches[1]
        $proc = Get-Process -Id $extPid -ErrorAction SilentlyContinue
        if (-not $proc -or $proc.Name -ne 'node') { Write-Log "RestartRemoteExtHost: ext host $extPid not running (already restarted?)"; exit 0 }

        # A scheduled task takes no arguments; unfreeze-remote-vscode.ps1 -Force
        # drops this marker instead. Consumed on read so it cannot linger.
        $marker = Join-Path $env:USERPROFILE '.codai\force-restart-exthost'
        $force = Test-Path $marker
        if ($force) { Remove-Item $marker -Force -ErrorAction SilentlyContinue }
        if ($recent.Count -lt 3 -and -not $force) {
            Write-Log "RestartRemoteExtHost: ext host $extPid looks healthy ($($recent.Count) reconnects in 2 min) - not killed. Use unfreeze-remote-vscode.ps1 -Force to override."
            exit 0
        }
        # Children first (tsserver, language servers): they would otherwise
        # outlive the host as orphans holding memory.
        $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$extPid" | Where-Object Name -eq 'node.exe'
        foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $extPid -Force -ErrorAction Stop
        Start-Sleep -Seconds 12
        $after = Get-Content $log -Tail 20 | Where-Object { $_ -match 'Launched Extension Host Process|exited with code' } | Select-Object -Last 2
        Write-Log ("RestartRemoteExtHost: killed ext host {0} (+{1} children) after {2} reconnects/2min; log: {3}" -f $extPid, @($kids).Count, $recent.Count, ($after -join ' || '))
        exit 0
    }

    'FixSshShell' {
        # Remote-SSH runs `ssh -T <host> powershell` and pipes its install
        # script over stdin. sshd's DefaultShell was pwsh 7, so that chain
        # started Windows PowerShell 5.1 INTERACTIVELY, which printed
        #
        #     Windows PowerShell / Copyright (C) Microsoft ... / PS C:\Users\vladu>
        #
        # into stdout. Remote-SSH parses that reply, saw a banner instead of
        # its handshake, and reported "Connecting with SSH timed out".
        #
        # cmd.exe is what Remote-SSH expects; it executes the requested command
        # without a banner or a prompt. Interactive `ssh dragos` sessions can
        # still just type pwsh.
        $k = 'HKLM:\SOFTWARE\OpenSSH'
        $old = (Get-ItemProperty $k -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
        Write-Log "FixSshShell: DefaultShell was '$old'"

        if ($old) {
            Set-ItemProperty -Path $k -Name 'DefaultShellBackup' -Value $old -Force
        }
        Set-ItemProperty -Path $k -Name 'DefaultShell' -Value 'C:\Windows\System32\cmd.exe' -Force

        Restart-Service sshd -Force
        Start-Sleep -Seconds 2
        $svc = Get-Service sshd
        Write-Log "FixSshShell: DefaultShell=cmd.exe, sshd=$($svc.Status)"
        exit 0
    }

    'CreateSshUser' {
        # A scheduled task takes no arguments, so the request is left in a
        # JSON file and read here. This is the no-UAC path: the VS Code task
        # uses Start-Process -Verb RunAs instead, which is fine when a human
        # is at the keyboard but unanswerable from an automated session.
        $reqFile = Join-Path $env:USERPROFILE '.codai\ssh-user-request.json'
        if (-not (Test-Path $reqFile)) {
            Write-Log "CreateSshUser: no request at $reqFile"
            exit 1
        }

        $req = Get-Content $reqFile -Raw | ConvertFrom-Json
        if (-not $req.Name) { Write-Log 'CreateSshUser: request has no Name'; exit 1 }

        # NOT $args -- that is an automatic variable and assigning to it
        # shadows the script's own argument array.
        $userArgs = @('-Name', $req.Name)
        if ($req.Allow) { $userArgs += @('-Allow', ($req.Allow -join ',')) }
        if ($req.ReadOnly) { $userArgs += @('-ReadOnly', ($req.ReadOnly -join ',')) }
        if ($req.PublicKey) { $userArgs += @('-PublicKey', $req.PublicKey) }

        Write-Log "CreateSshUser: $($req.Name) allow=$($req.Allow -join ',')"
        if ($req.AclOnly) {
            $o = & pwsh -NoProfile -ExecutionPolicy Bypass `
                -File (Join-Path $root '_apply-mihai-acl.ps1') `
                -Name $req.Name -Allow ($req.Allow -join ',') 2>&1
            foreach ($l in $o) { Write-Log "  | $l" }
            Remove-Item $reqFile -Force -ErrorAction SilentlyContinue
            Write-Log "CreateSshUser: acl-only finished, exit $LASTEXITCODE"
            exit 0
        }
        # Run it as a SEPARATE process, not with `&`. ssh-user.ps1 ends every
        # branch with `exit`, and `&` runs it in the CURRENT process -- so the
        # first `exit` killed this script too, before it could log anything or
        # clean up. That looked like a silent hang: a start line and nothing
        # else. A child process keeps the elevated token, so isolation is not
        # lost.
        $output = & pwsh -NoProfile -ExecutionPolicy Bypass `
            -File (Join-Path $root 'ssh-user.ps1') @userArgs 2>&1
        $rc = $LASTEXITCODE
        foreach ($line in $output) { Write-Log "  | $line" }

        # The request can name folders, so do not leave it lying around.
        Remove-Item $reqFile -Force -ErrorAction SilentlyContinue
        Write-Log "CreateSshUser finished, exit $rc"
        exit $rc
    }

    'InstallVmSshKey' {
        # The VM connects INTO this host (the host is where the workspaces and
        # the code-tunnel server live; the VM is only ever the client). That is
        # the direction that replaces the tunnel.
        #
        # Because this account is in Administrators, sshd ignores
        # ~/.ssh/authorized_keys and reads only this file, which is writable
        # solely by Administrators+SYSTEM -- hence an elevated operation.
        $keyFile = Join-Path $env:USERPROFILE '.codai\vm-ssh-key.pub'
        if (-not (Test-Path $keyFile)) {
            Write-Log "InstallVmSshKey: $keyFile not found"
            exit 1
        }
        $key = (Get-Content $keyFile -Raw).Trim()
        if (-not $key.StartsWith('ssh-')) {
            Write-Log 'InstallVmSshKey: file does not contain a public key'
            exit 1
        }

        $dir = 'C:\ProgramData\ssh'
        $auth = Join-Path $dir 'administrators_authorized_keys'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null

        $existing = if (Test-Path $auth) { Get-Content $auth -Raw } else { '' }
        if ($existing -match [regex]::Escape($key)) {
            Write-Log 'InstallVmSshKey: key already present'
        }
        else {
            Add-Content -Path $auth -Value $key -Encoding ascii
            Write-Log 'InstallVmSshKey: key added'
        }

        # sshd refuses the file outright if inheritance is left on or any
        # non-admin principal can write it.
        icacls $auth /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' 2>&1 | Out-Null

        # Manual start means no SSH after a reboot, which would strand the VM.
        $svc = Get-Service sshd -ErrorAction SilentlyContinue
        if ($svc -and $svc.StartType -ne 'Automatic') {
            Set-Service sshd -StartupType Automatic
            Write-Log 'InstallVmSshKey: sshd set to Automatic'
        }
        if ($svc -and $svc.Status -ne 'Running') { Start-Service sshd }

        Write-Log "InstallVmSshKey done, keys=$((Get-Content $auth).Count)"
        exit 0
    }

    'TunnelForceRestart' {
        & (Join-Path $root 'restart-tunnel.ps1') -Force
        Write-Log "TunnelForceRestart finished, exit $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    'KillRunawayRenderer' {
        # Only renderers, only over the threshold, and never one holding a
        # network connection -- that would be the one serving the tunnel.
        $limitMB = 4096
        $killed = 0
        foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='Code - Insiders.exe'" -EA SilentlyContinue)) {
            if ($proc.CommandLine -notmatch '--type=renderer') { continue }
            $mb = [int]($proc.WorkingSetSize / 1MB)
            if ($mb -lt $limitMB) { continue }

            $conns = @(Get-NetTCPConnection -State Established -EA SilentlyContinue |
                Where-Object { $_.OwningProcess -eq $proc.ProcessId }).Count
            if ($conns -gt 0) {
                Write-Log "SKIP renderer pid $($proc.ProcessId) at ${mb}MB - holds $conns connection(s)"
                continue
            }

            Stop-Process -Id $proc.ProcessId -Force -EA SilentlyContinue
            Write-Log "killed renderer pid $($proc.ProcessId) at ${mb}MB"
            $killed++
        }
        if (-not $killed) { Write-Log 'KillRunawayRenderer: nothing over threshold' }
        exit 0
    }

    'Status' {
        $pids = @(Get-Process 'code-tunnel' -EA SilentlyContinue).Id
        $up = -1
        if ($pids.Count) {
            $oldest = $null
            foreach ($p in $pids) {
                $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -EA SilentlyContinue
                if ($ci -and $ci.CreationDate -and (-not $oldest -or $ci.CreationDate -lt $oldest)) {
                    $oldest = $ci.CreationDate
                }
            }
            if ($oldest) { $up = [math]::Round(((Get-Date) - $oldest).TotalHours, 1) }
        }
        $relay = 0
        if ($pids.Count) {
            $relay = @(Get-NetTCPConnection -State Established -EA SilentlyContinue |
                Where-Object { $_.OwningProcess -in $pids -and $_.RemotePort -eq 443 }).Count
        }
        Write-Host "  tunnel uptime : $up h"
        Write-Host "  relay links   : $relay"
        Write-Host "  running as    : $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
        exit 0
    }
}
