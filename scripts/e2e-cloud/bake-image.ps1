<#
.SYNOPSIS
  Bake image family vmui-e2e-runner in dragos-devcloud (Ubuntu 24.04, Node 24, corepack,
  Playwright chromium for the lockfile's version, lighthouse, fonts incl. Romanian glyphs,
  warm pnpm store). Re-run when Playwright or the lockfile moves a lot; a stale image still
  works, it is just slower.

  pwsh -NoProfile -File scripts/e2e-cloud/bake-image.ps1 [-LighthouseVersion 13.5.0]

  Creates a temp VM, waits for it to power itself off, images its disk, and ALWAYS deletes
  the temp VM (finally). Keeps the newest 3 images of the family.
#>
param(
  [string]$Project = 'dragos-devcloud',
  [string]$Zone = 'europe-central2-a',
  [string]$LighthouseVersion = '13.5.0'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$tmp = Join-Path $root '.copilot-tmp\e2e-cloud'
New-Item -ItemType Directory -Force $tmp | Out-Null

$family = 'vmui-e2e-runner'
$bucket = "vmui-e2e-runs-$Project"
$sa = "vmui-e2e-runner@$Project.iam.gserviceaccount.com"
$lock = Get-Content "$root\pnpm-lock.yaml" -Raw
$pw = [regex]::Match($lock, "\n  '@playwright/test@([\d.]+)':").Groups[1].Value
if (-not $pw) { throw 'could not read the @playwright/test version from pnpm-lock.yaml' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$vm = "vmui-e2e-bake-$stamp"
$marker = "gs://$bucket/cache/bake-$vm.ok"
Write-Host "playwright=$pw lighthouse=$LighthouseVersion -> $vm"

# Lockfile + manifests only, for `pnpm fetch`.
$list = Join-Path $tmp 'bake.files'
git -C $root ls-files 'pnpm-lock.yaml' 'pnpm-workspace.yaml' 'package.json' '*/package.json' '*/*/package.json' '.npmrc' |
  Set-Content -Encoding ascii $list
$tgz = Join-Path $tmp 'bake-manifests.tgz'
tar -czf $tgz -C $root -T $list
if ($LASTEXITCODE) { throw 'tar failed' }
gcloud storage cp -q $tgz "gs://$bucket/cache/bake-manifests.tgz" --project $Project
if ($LASTEXITCODE) { throw 'upload failed' }

$startup = Join-Path $tmp 'bake-image.sh'
[IO.File]::WriteAllText($startup, ((Get-Content "$PSScriptRoot\bake-image.sh" -Raw) -replace "`r`n", "`n"))
$md = "playwright-version=$pw,lighthouse-version=$LighthouseVersion,bundle=gs://$bucket/cache/bake-manifests.tgz,marker=$marker"

$created = $false
try {
  gcloud compute instances create $vm --project $Project --zone $Zone --machine-type n2d-standard-8 `
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud --boot-disk-size 40GB --boot-disk-type pd-ssd `
    --service-account $sa --scopes cloud-platform `
    '--labels=purpose=e2e-bake,owner=vmui' --max-run-duration 2h --instance-termination-action STOP `
    "--metadata=$md" "--metadata-from-file=startup-script=$startup"
  if ($LASTEXITCODE) { throw 'bake VM create failed' }
  $created = $true

  Write-Host 'waiting for the bake VM to power itself off (~6-10 min)...'
  $deadline = (Get-Date).AddMinutes(40)
  do {
    Start-Sleep -Seconds 30
    $status = gcloud compute instances describe $vm --project $Project --zone $Zone --format 'value(status)'
    $tail = gcloud compute instances get-serial-port-output $vm --project $Project --zone $Zone 2>$null |
      Select-String 'BAKE_OK|startup-script.*(exit status|Error)' | Select-Object -Last 1
    Write-Host "  $status $tail"
    if ("$tail" -match 'exit status [1-9]') { throw "bake script failed on $vm (see serial output above)" }
  } while ($status -ne 'TERMINATED' -and (Get-Date) -lt $deadline)
  if ($status -ne 'TERMINATED') { throw 'bake VM did not power off within 40 min' }

  gcloud storage ls $marker --project $Project *> $null
  if ($LASTEXITCODE -ne 0) { throw 'BAKE_OK marker not found in GCS - NOT creating an image' }

  $pwLabel = $pw -replace '\.', '-'
  $lhLabel = $LighthouseVersion -replace '\.', '-'
  gcloud compute images create "$family-$stamp" --project $Project --source-disk $vm --source-disk-zone $Zone `
    --family $family --storage-location europe-central2 "--labels=owner=vmui,playwright=$pwLabel,lighthouse=$lhLabel"
  if ($LASTEXITCODE) { throw 'image create failed' }
  gcloud storage rm -q $marker --project $Project *> $null

  # Keep the newest 3 images in the family.
  gcloud compute images list --project $Project --filter "family=$family" --sort-by '~creationTimestamp' --format 'value(name)' |
    Select-Object -Skip 3 | ForEach-Object { gcloud compute images delete $_ --project $Project --quiet }
  Write-Host "OK image $family-$stamp (family $family)"
}
finally {
  if ($created) {
    gcloud compute instances delete $vm --project $Project --zone $Zone --quiet --delete-disks all
    if ($LASTEXITCODE) { Write-Warning "could not delete bake VM $vm - delete it by hand" }
  }
}
