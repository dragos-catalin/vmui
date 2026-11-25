<#
  Does the DEPLOYED weekly rebake actually describe what this directory says it does?

  Why this exists (2026-11-25). The Cloud Scheduler body is a *deployed copy* of
  build.json: posted once by -Schedule and never re-derived from it. build.json
  gained the rust-tauri-win and win-desktop families in October, the deployed body
  kept the six steps of the version before them, and those two families were simply
  never rebaked again — 1006 h and 945 h old when someone looked. No script compared
  the two, so nothing could report it. -Schedule is the repair; this is the check.

  Read-only, and cheap enough to run in any gate. Exit 0 when in sync, 1 on drift,
  2 when the scheduler job does not exist yet.

  pwsh -NoProfile -File infra/devcloud/images/check-schedule-drift.ps1
#>
[CmdletBinding()]
param(
    [string]$Project = 'codai-training',
    [string]$Control = 'dragos-devcloud',
    [string]$Region = 'europe-west4',
    [string]$Job = 'devcloud-image-rebake'
)

$ErrorActionPreference = 'Stop'
$declaredFile = Join-Path $PSScriptRoot 'build.json'

$raw = & gcloud scheduler jobs describe $Job --project $Control --location $Region --format='value(httpTarget.body)' 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "check-schedule-drift: no scheduler job '$Job' in $Control/$Region — nothing deployed to compare against" -ForegroundColor Yellow
    exit 2
}
$b64 = ($raw | Select-Object -First 1)
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64.Trim()))
$live = $json | ConvertFrom-Json
$declared = Get-Content $declaredFile -Raw | ConvertFrom-Json

# A step is the same when it will do the same thing: same id (the family), same
# builder and the same arguments. Comparing ids alone would miss a renamed script
# baked into the step.
function Step-Fingerprint($step) {
    '{0} | {1} | {2}' -f $step.id, $step.name, (@($step.args) -join ' ')
}

$liveSteps = @($live.steps)
$declSteps = @($declared.steps)
$liveById = @{}; foreach ($s in $liveSteps) { $liveById[[string]$s.id] = $s }
$declIds = @($declSteps | ForEach-Object { [string]$_.id })
$liveIds = @($liveSteps | ForEach-Object { [string]$_.id })

$missing = @($declIds | Where-Object { $liveIds -notcontains $_ })
$extra = @($liveIds | Where-Object { $declIds -notcontains $_ })
$changed = @()
foreach ($id in ($declIds | Where-Object { $liveIds -contains $_ })) {
    $d = $declSteps | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
    if ((Step-Fingerprint $d) -ne (Step-Fingerprint $liveById[$id])) {
        $changed += $id
    }
}

'check-schedule-drift: deployed rebake vs build.json'
'  steps      : live {0} / declared {1}' -f $liveSteps.Count, $declSteps.Count
'  timeout    : live {0} / declared {1}' -f $live.timeout, $declared.timeout
'  order      : live {0}' -f ($liveIds -join ', ')
'               repo {0}' -f ($declIds -join ', ')
'  not rebaked (in the repo, absent from the deployed body): {0}' -f $(if ($missing) { $missing -join ', ' } else { 'none' })
'  stale       (deployed, no longer in the repo)          : {0}' -f $(if ($extra) { $extra -join ', ' } else { 'none' })
'  changed     (same id, different work)                  : {0}' -f $(if ($changed) { $changed -join ', ' } else { 'none' })

$drift = @($missing + $extra + $changed)
if ($drift.Count -or $live.timeout -ne $declared.timeout -or $liveSteps.Count -ne $declSteps.Count) {
    ''
    Write-Host 'DRIFT: the deployed rebake is not what this repo would deploy — run: images.ps1 -Schedule' -ForegroundColor Red
    exit 1
}
''
Write-Host 'IN SYNC: every declared family is in the deployed rebake, unchanged.' -ForegroundColor Green
exit 0
