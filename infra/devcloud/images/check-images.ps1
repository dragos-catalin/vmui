<#
.SYNOPSIS
  Verifies every declared devcloud CI runner image against its single source (images.json).

.DESCRIPTION
  A baked family rots silently: the pool keeps booting it, the jobs keep passing, and nobody
  notices that the toolchain it promises (Flutter, Shorebird, VS Build Tools) is two months old or
  that a rebake dropped a layer. This check reads `infra/devcloud/images/images.json` - the single
  source for what each family is and how it is baked - and for every declared family asserts:

    * the family exists (a missing family is a WARN, unless the entry says "required": true);
    * the newest image carries the declared `toolchain` label (a renamed toolchain is otherwise
      invisible: the family keeps answering with an image baked for something else);
    * the newest image's DESCRIPTION still contains every marker the entry declares - this is what
      catches a rebake that lost Flutter or Shorebird, and it is the reason markers are facts
      ("shorebird ") and not version numbers duplicated from bake.mjs;
    * the age of the newest image is under `warnAfterDays` (a warning) and under the entry's
      `maxAgeDays` (a failure).

    It also reaps orphan bake VMs: `bake.mjs` deletes its throwaway VM in a `finally`, which a killed
    shell never reaches, so a leftover keeps its 100-150 GB boot disk in TERMINATED state forever. Only
    instances labelled `purpose=ci-bake` are candidates; a running bake and every other VM are untouched.

  The check refuses to pass vacuously: an entry with no markers contributes the two markers every
  image has, and a run that finds zero declared families exits 2.

    pwsh -NoProfile -File infra/devcloud/images/check-images.ps1
    pwsh -NoProfile -File infra/devcloud/images/check-images.ps1 -RegisterTask    # daily 08:30
    pwsh -NoProfile -File infra/devcloud/images/check-images.ps1 -Quiet -Mail

  Exit 0 = every family is fresh and intact, 1 = at least one failure or warning, 2 = misconfigured.

.PARAMETER RegisterTask
  Register (or replace) the scheduled task `devcloud-check-images` that runs this daily at 08:30
  through the hidden-run shim, so the sentinel does not depend on anyone remembering to look.

.PARAMETER WarnAfterDays
  Override the global age at which an image is reported as getting old. Per-entry maxAgeDays
  still decides failure.

.PARAMETER Quiet
  Print only the verdict line (for the scheduled task).

.PARAMETER Mail
  Also send a report to $env:DEVCLOUD_ALERT_TO through Brivio (this machine's only mail route).
  Env-gated and no-op clean: needs BRIVIO_API_KEY, skips itself with a line when unset.

.PARAMETER NoSweep
    Do not delete orphan bake VMs (inspect them instead).
#>
[CmdletBinding()]
param(
    [switch]$RegisterTask,
    [int]$WarnAfterDays = 0,
    [switch]$Quiet,
        [switch]$Mail,
        [switch]$NoSweep
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$source = Join-Path $here 'images.json'

# The scheduled task must call the script in the CANONICAL clone, never in the worktree slot it was
# installed from: a slot is leased and returned, so a task pointing at one dies the moment it is
# released. git rev-parse --show-toplevel is the slot in a worktree - the common dir is not.
if ($RegisterTask) {
    $common = (& git -C $here rev-parse --path-format=absolute --git-common-dir) -replace '/', '\'
    $root = Split-Path $common -Parent
    $script0 = Join-Path $root 'infra\devcloud\images\check-images.ps1'
    if (-not (Test-Path $script0)) {
        throw "the task would point at $script0, which does not exist - land this branch in $root first, then register."
    }
    $vbs = Join-Path $root 'scripts\hidden-run.vbs'
    if (-not (Test-Path $vbs)) { throw "hidden-run.vbs not found at $vbs" }
    $tr = 'wscript.exe "' + $vbs + '" "powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "' + $script0 + '" -Quiet -Mail'
    & schtasks /create /tn 'devcloud-check-images' /tr $tr /sc daily /st 08:30 /f | Out-Null
    "check-images: task 'devcloud-check-images' registered (daily 08:30) -> $script0"
    return
}

function Say([string]$Text, [string]$Colour = 'Gray') {
    if (-not $Quiet) { Write-Host $Text -ForegroundColor $Colour }
}

if (-not (Test-Path $source)) { throw "missing $source" }
$cfg = Get-Content $source -Raw | ConvertFrom-Json
if (-not $cfg.images.PSObject.Properties.Count) {
    Write-Host 'check-images: ABORTED - images.json declares no family, so this check would pass vacuously.' -ForegroundColor Red
    exit 2
}

$project = [string]$cfg.project
$globalWarn = if ($WarnAfterDays -gt 0) { $WarnAfterDays } else { [int]$cfg.warnAfterDays }
$always = @($cfg.markersEveryImageHas)

$lines = @()
$bad = @()
$warn = @()
$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm')
if (-not $Quiet) { "devcloud image check - $stamp (project $project, warn after $globalWarn days)" }

foreach ($p in ($cfg.images.PSObject.Properties | Sort-Object Name)) {
    $family = $p.Name
    $e = $p.Value
    $img = (gcloud compute images describe-from-family $family --project $project --format=json 2>$null | ConvertFrom-Json)
    if (-not $img) {
        if ($e.required) {
            $bad += "$family is required but no image exists"
            $lines += '  {0,-32} FAIL     not baked' -f $family
        } else {
            $warn += "$family has never been baked here"
            $lines += '  {0,-32} WARN     not baked' -f $family
        }
        continue
    }

    $age = ([DateTime]::UtcNow - [DateTime]$img.creationTimestamp).TotalDays
    $markers = @($always) + @($e.markers)
    $problems = @()
    if ([string]$img.labels.toolchain -ne [string]$e.toolchain) {
        $problems += "toolchain label is '$($img.labels.toolchain)', declared '$($e.toolchain)'"
    }
    foreach ($m in $markers) {
        if ($img.description -notlike "*$m*") { $problems += "description lost the marker '$m'" }
    }
    if ($age -gt [double]$e.maxAgeDays) { $problems += "image is $([math]::Round($age, 1)) days old (max $($e.maxAgeDays))" }
    elseif ($age -gt $globalWarn) { $warn += "$family is $([math]::Round($age, 1)) days old (> $globalWarn)" }

    if ($problems.Count) {
        $bad += @($problems | ForEach-Object { "$family`: $_" })
        $lines += '  {0,-32} FAIL     {1}' -f $family, $problems[0]
        if (-not $Quiet) { foreach ($pr in $problems) { Say "      - $pr" 'Red' } }
    } else {
        $state = if ($age -gt $globalWarn) { 'WARN' } else { 'OK' }
        $lines += '  {0,-32} {1,-8} {2} ({3:N1} days old)' -f $family, $state, $img.name, $age
    }
}

    # Orphan bake VMs. bake.mjs deletes its throwaway VM in a `finally`, which a killed shell never reaches,
    # so a leftover sits in TERMINATED state holding its 100-150 GB boot disk (found 2026-11-25: one left by
    # an aborted bake). Same label as the sweep inside bake.mjs, so a workspace or another agent's VM is never
    # a candidate; a bake still in flight (RUNNING/PROVISIONING) is skipped even if it is old.
    if (-not $NoSweep) {
      $inst = @()
      $inst = @(& gcloud compute instances list --project $project --filter 'labels.purpose=ci-bake' --format=json 2>$null | ConvertFrom-Json)
      if ($LASTEXITCODE -ne 0) { $warn += "could not list bake VMs (gcloud exit $LASTEXITCODE)"; $inst = @() }
      $reaped = @()
      foreach ($i in $inst) {
        if (-not $i) { continue }
        if ("$($i.status)" -in @('RUNNING', 'PROVISIONING', 'STAGING', 'REPAIRING', 'SUSPENDING')) { continue }
        $z = ("$($i.zone)" -split '/')[-1]
        & gcloud compute instances delete "$($i.name)" --zone $z --project $project --quiet 2>$null | Out-Null
        $reaped += "$($i.name)@$z ($($i.status))"
      }
      if ($reaped.Count) {
        $warn += "reaped $($reaped.Count) orphan bake VM(s): $($reaped -join ', ')"
        $lines += '  {0,-32} REAP     {1}' -f 'orphan bake vm', ($reaped -join ', ')
      }
    }

if (-not $Quiet) {
    ''
    $lines | ForEach-Object { Write-Host $_ -ForegroundColor $(if ($_ -match 'FAIL') { 'Red' } elseif ($_ -match 'WARN') { 'Yellow' } else { 'Gray' }) }
    ''
    if ($bad.Count) { Write-Host 'failures:' -ForegroundColor Red; $bad | ForEach-Object { Write-Host "  $_" -ForegroundColor Red } }
    if ($warn.Count) { Write-Host 'warnings:' -ForegroundColor Yellow; $warn | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow } }
}

$verdict = if ($bad.Count) { "IMAGE-CHECK: $($bad.Count) failure(s), $($warn.Count) warning(s)" }
elseif ($warn.Count) { "IMAGE-CHECK: $($warn.Count) warning(s)" }
else { 'IMAGE-CHECK: OK' }
Write-Host $verdict -ForegroundColor $(if ($bad.Count) { 'Red' } elseif ($warn.Count) { 'Yellow' } else { 'Green' })

if ($Mail) {
    if (-not $env:DEVCLOUD_ALERT_TO -or -not $env:BRIVIO_API_KEY) {
        if (-not $Quiet) { Write-Host 'MAIL: skipped (DEVCLOUD_ALERT_TO and/or BRIVIO_API_KEY not set)' }
    } elseif (-not ($bad.Count -or $warn.Count)) {
        if (-not $Quiet) { Write-Host 'MAIL: not sent (nothing to report)' }
    } else {
        $body = @{
            to      = $env:DEVCLOUD_ALERT_TO
            subject = '[devcloud] image check: ' + $bad.Count + ' failure(s), ' + $warn.Count + ' warning(s)'
            text    = ($lines -join "`n") + "`n`n" + (($bad + $warn) -join "`n")
        } | ConvertTo-Json -Compress
        try {
            $url = if ($env:BRIVIO_MAIL_URL) { $env:BRIVIO_MAIL_URL } else { 'https://api.brivio.ro/v1/mail/send' }
            Invoke-RestMethod -Method Post -Uri $url -Headers @{ Authorization = "Bearer $env:BRIVIO_API_KEY" } -ContentType 'application/json' -Body $body | Out-Null
            if (-not $Quiet) { Write-Host 'MAIL: sent' }
        } catch {
            Write-Host "MAIL: failed ($($_.Exception.Message))" -ForegroundColor Yellow
        }
    }
}

exit $(if ($bad.Count) { 1 } elseif ($warn.Count) { 1 } else { 0 })
