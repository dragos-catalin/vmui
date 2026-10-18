<#
.SYNOPSIS
  Idempotent GCP provisioning for vmui cloud browser tests (project dragos-devcloud).

.DESCRIPTION
  Safe to re-run: every step LISTS/describes before it creates, and nothing is ever deleted.
  Resources (all prefixed vmui-e2e-*):
    bucket  gs://vmui-e2e-runs-dragos-devcloud   run bundles, logs, reports (runs/ 14 d, cache/ 30 d)
    SA      vmui-e2e-runner                      identity of every e2e VM (and of the bake VM)
    role    vmuiE2eSelfDelete                    compute.instances.delete/get, bound with a
                                                 name-prefix condition: only VMs named vmui-e2e-*
  The caller gets roles/iam.serviceAccountUser on the SA so `run.mjs` can attach it to a VM.

  pwsh -NoProfile -File scripts/e2e-cloud/provision.ps1
#>
param(
  [string]$Project = 'dragos-devcloud',
  [string]$Region = 'europe-central2'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$bucket = "vmui-e2e-runs-$Project"
$saName = 'vmui-e2e-runner'
$runnerSa = "$saName@$Project.iam.gserviceaccount.com"
$roleId = 'vmuiE2eSelfDelete'

function Exists([scriptblock]$probe) { & $probe *> $null; return ($LASTEXITCODE -eq 0) }
function Run([string[]]$argv) {
  & gcloud @argv --project $Project --quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "gcloud $($argv -join ' ') failed ($LASTEXITCODE)" }
}

Write-Host '== apis'
$enabled = @(gcloud services list --enabled --project $Project --format 'value(config.name)')
foreach ($api in 'compute.googleapis.com', 'storage.googleapis.com', 'iam.googleapis.com', 'logging.googleapis.com') {
  if ($enabled -notcontains $api) { Run @('services', 'enable', $api) }
}

Write-Host '== bucket'
if (-not (Exists { gcloud storage buckets describe "gs://$bucket" --project $Project })) {
  Run @('storage', 'buckets', 'create', "gs://$bucket", "--location=$Region", '--uniform-bucket-level-access', '--public-access-prevention')
} else { Write-Host "  exists gs://$bucket" }
$lc = Join-Path ([IO.Path]::GetTempPath()) 'vmui-e2e-lifecycle.json'
[IO.File]::WriteAllText($lc, '{"rule":[{"action":{"type":"Delete"},"condition":{"age":14,"matchesPrefix":["runs/"]}},{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["cache/"]}}]}')
Run @('storage', 'buckets', 'update', "gs://$bucket", "--lifecycle-file=$lc")
Remove-Item $lc -Force

Write-Host '== service account'
if (-not (Exists { gcloud iam service-accounts describe $runnerSa --project $Project })) {
  Run @('iam', 'service-accounts', 'create', $saName, '--display-name=vmui cloud e2e runner VMs')
  # IAM is eventually consistent: a binding right after create can 400 "does not exist".
  Start-Sleep -Seconds 10
} else { Write-Host "  exists $runnerSa" }

Write-Host '== self-delete role'
if (-not (Exists { gcloud iam roles describe $roleId --project $Project })) {
  Run @('iam', 'roles', 'create', $roleId, '--title=vmui e2e runner self delete', '--permissions=compute.instances.delete,compute.instances.get', '--stage=GA')
} else { Write-Host "  exists $roleId" }
# Only VMs named vmui-e2e-* can be deleted by the runner identity.
$cond = 'expression=resource.name.extract("/instances/{name}").startsWith("vmui-e2e-"),title=vmui-e2e-vms-only'
Run @('projects', 'add-iam-policy-binding', $Project, "--member=serviceAccount:$runnerSa", "--role=projects/$Project/roles/$roleId", "--condition=$cond")
Run @('projects', 'add-iam-policy-binding', $Project, "--member=serviceAccount:$runnerSa", '--role=roles/logging.logWriter', '--condition=None')

Write-Host '== bucket access'
Run @('storage', 'buckets', 'add-iam-policy-binding', "gs://$bucket", "--member=serviceAccount:$runnerSa", '--role=roles/storage.objectAdmin')

Write-Host '== caller may attach the SA'
$caller = (gcloud config get-value account 2>$null | Select-Object -First 1)
if (-not $caller) { throw 'no active gcloud account (gcloud auth login)' }
$caller = "$caller".Trim()
$memberType = 'user'
if ($caller -like '*.gserviceaccount.com') { $memberType = 'serviceAccount' }
Run @('iam', 'service-accounts', 'add-iam-policy-binding', $runnerSa, "--member=${memberType}:$caller", '--role=roles/iam.serviceAccountUser')

Write-Host "OK  bucket=gs://$bucket  runner=$runnerSa  role=projects/$Project/roles/$roleId"
