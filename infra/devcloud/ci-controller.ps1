<#
  devcloud F3 (DC-041): ci-controller on Cloud Run + its IAM, secrets and runner-project grants.
  pwsh -NoProfile -File infra/devcloud/ci-controller.ps1              # provision (idempotent) + deploy
  pwsh -NoProfile -File infra/devcloud/ci-controller.ps1 -Verify      # unsigned 401, signed ping 200 through the real path
  pwsh -NoProfile -File infra/devcloud/ci-controller.ps1 -Jobs 5      # last per-job records (duration + cost)
  Secrets devcloud-runners-{app-id,app-key,webhook-secret} are written by github-app.ps1 (never printed).
  Deploy only from a clean tree (deploy-clean.ps1): the source upload is the working directory.
#>
param([switch]$Verify, [int]$Jobs = 0, [string]$Project = 'dragos-devcloud', [string]$Region = 'europe-west4',
  [string]$RunnerProject = 'codai-training', [string]$Org = 'codai-ro', [string]$AllowRepos = 'codai-ro/codai-cc')
$ErrorActionPreference = 'Stop'
function G { $o = & gcloud @args 2>&1; if ($LASTEXITCODE) { throw "gcloud $($args -join ' ') failed: $o" }; $o }
$svc = 'ci-controller'; $sa = "ci-controller@$Project.iam.gserviceaccount.com"; $bucket = "$Project-devcloud-jobs"
$secrets = 'devcloud-runners-app-id', 'devcloud-runners-app-key', 'devcloud-runners-webhook-secret'

if ($Jobs -gt 0) {
  $names = @(G storage ls "gs://$bucket/ci/jobs/" | Select-Object -Last $Jobs)
  foreach ($n in $names) { G storage cat $n | ConvertFrom-Json | Select-Object job, jobName, conclusion, machine, model, zone, queueSec, jobSec, vmSec, vmDeleted, costUsd | Format-List | Out-String | Write-Output }
  return
}

if (-not $Verify) {
  $s = & gcloud iam service-accounts describe $sa --project $Project --format='value(email)' 2>$null
  if (-not $s) { G iam service-accounts create ci-controller --project $Project --display-name 'devcloud ci-controller (GitHub workflow_job -> JIT VM)' | Out-Null; 'SA created' }
  foreach ($n in $secrets) {
    if (-not (& gcloud secrets describe $n --project $Project --format='value(name)' 2>$null)) { throw "secret $n missing: run infra/devcloud/github-app.ps1 first" }
    G secrets add-iam-policy-binding $n --project $Project --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor --condition None | Out-Null
  }
  # Runner VMs live in the runner project; the controller creates/deletes them and nothing else.
  G projects add-iam-policy-binding $RunnerProject --member "serviceAccount:$sa" --role roles/compute.instanceAdmin.v1 --condition None | Out-Null
  G storage buckets add-iam-policy-binding "gs://$bucket" --member "serviceAccount:$sa" --role roles/storage.objectAdmin | Out-Null
  Push-Location (Join-Path $PSScriptRoot 'ci-controller')
  try {
    G run deploy $svc --project $Project --region $Region --source . --service-account $sa `
      --allow-unauthenticated --no-cpu-throttling --min-instances 0 --max-instances 2 --concurrency 20 --cpu 1 --memory 512Mi --timeout 120 `
      --set-env-vars "CONTROL_PROJECT=$Project,RUNNER_PROJECT=$RunnerProject,GH_ORG=$Org,ALLOW_REPOS=$AllowRepos,BUCKET=$bucket" `
      --labels 'owner=devcloud,purpose=ci' | Out-Null
  } finally { Pop-Location }
  $url = (G run services describe $svc --project $Project --region $Region --format='value(status.url)').Trim()
  "deployed $url  (webhook URL: $url/webhook)"
}

# Verify through the real path: unsigned -> 401, correctly signed ping -> 200 'pong', health -> new revision.
$url = (G run services describe $svc --project $Project --region $Region --format='value(status.url)').Trim()
$rev = (G run services describe $svc --project $Project --region $Region --format='value(status.latestReadyRevisionName)').Trim()
$secret = (G secrets versions access latest --secret devcloud-runners-webhook-secret --project $Project) -join ''
$body = '{"zen":"verify","hook_id":0}'
$sig = 'sha256=' + -join ([Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret)).ComputeHash([Text.Encoding]::UTF8.GetBytes($body)) | ForEach-Object { $_.ToString('x2') })
$secret = $null
$h = { param($hdr) try { $r = Invoke-WebRequest "$url/webhook" -Method Post -Body $body -ContentType 'application/json' -Headers $hdr -SkipHttpErrorCheck -TimeoutSec 20; "$($r.StatusCode) $($r.Content)" } catch { "ERR $($_.Exception.Message)" } }
$unsigned = & $h @{ 'X-GitHub-Event' = 'ping' }
$bad = & $h @{ 'X-GitHub-Event' = 'ping'; 'X-Hub-Signature-256' = 'sha256=' + ('0' * 64) }
$signed = & $h @{ 'X-GitHub-Event' = 'ping'; 'X-Hub-Signature-256' = $sig }
$health = (Invoke-RestMethod "$url/health" -TimeoutSec 20).rev
"unsigned=$unsigned bad=$bad signed=$signed health.rev=$health latest=$rev"
if ($unsigned -notlike '401*' -or $bad -notlike '401*' -or $signed -ne '200 pong' -or $health -ne $rev) { throw 'verify FAILED' }
'VERIFY OK'
