<#
  devcloud DC-042: CI runner images per toolchain (family devcloud-ci-<toolchain> in the runner project).
  pwsh -NoProfile -File infra/devcloud/images/images.ps1 -Bake node24 [-Lock <codai>\pnpm-lock.yaml]   # bake one family from here
  pwsh -NoProfile -File infra/devcloud/images/images.ps1 -List                                       # families, newest image, age, size
  pwsh -NoProfile -File infra/devcloud/images/images.ps1 -BootTest node24                            # boot the family, time "runner ready"
  pwsh -NoProfile -File infra/devcloud/images/images.ps1 -Schedule                                   # weekly Cloud Scheduler -> Cloud Build rebake of all families
  pwsh -NoProfile -File infra/devcloud/images/images.ps1 -RunNow                                     # trigger the scheduled rebake once
  Toolchains: node24 android-jdk21 rust-tauri-linux python-uv flutter polyglot (layers: image-setup.sh).
  Bake VMs have no service account; node24/polyglot warm the pnpm store from the codai lockfile
  (local -Lock, or fetched with the devcloud-runners App = needs Contents: read).
#>
param([string]$Bake, [string]$Lock, [string]$Workspace, [switch]$List, [string]$BootTest, [switch]$Schedule, [switch]$RunNow,
  [string]$Project = 'codai-training', [string]$Control = 'dragos-devcloud', [string]$Region = 'europe-west4',
  [string]$Cron = '30 1 * * 0')
$ErrorActionPreference = 'Stop'
function G { $o = & gcloud @args 2>&1; if ($LASTEXITCODE) { throw "gcloud $($args -join ' ') failed: $o" }; $o }
$here = $PSScriptRoot
$sa = "devcloud-image-baker@$Control.iam.gserviceaccount.com"
$bucket = "$Control-devcloud-jobs"

if ($Bake) {
  $a = @("$here/bake.mjs", '--toolchain', $Bake, '--project', $Project, '--control', $Control)
  if ($Lock) { $a += '--lock', $Lock; if ($Workspace) { $a += '--workspace', $Workspace } }
  & node @a; exit $LASTEXITCODE
}

if ($List) {
  $imgs = G compute images list --project $Project --no-standard-images --filter 'family~^devcloud-ci-' --format=json | ConvertFrom-Json
  $imgs | Group-Object family | ForEach-Object {
    $n = $_.Group | Sort-Object creationTimestamp -Descending | Select-Object -First 1
    [pscustomobject]@{ family = $_.Name; newest = $n.name; ageH = [math]::Round(((Get-Date) - [datetime]$n.creationTimestamp).TotalHours, 1); diskGb = $n.diskSizeGb; archiveGb = [math]::Round($n.archiveSizeBytes / 1GB, 1); count = $_.Count; lock = $n.labels.lock }
  } | Format-Table -AutoSize | Out-String -Width 200
  return
}

if ($BootTest) {
  # Same shape as a CI job VM (no SA, Spot, c4d-highcpu-16); a probe script logs when the image's runner is
  # usable (node + pnpm + runner config present) and powers off. Measures create -> ready from the serial log.
  $vm = "boot-$BootTest-" + (Get-Date -Format 'MMddHHmmss')
  $probe = Join-Path $env:TEMP 'boot-probe.sh'
  $sh = @'
#!/bin/bash
exec > /dev/ttyS0 2>&1
test -f /opt/devcloud/baked && echo "::image $(cat /opt/devcloud/image.json)"
su - runner -c 'cd /opt/actions-runner && ./config.sh --help >/dev/null 2>&1 && node -v && pnpm -v && google-chrome --version' && echo "::runner-ready $(cut -d. -f1 /proc/uptime)s"
sleep 2; shutdown -h now
'@
  [IO.File]::WriteAllText($probe, ($sh -replace "`r`n", "`n"))
  $t0 = Get-Date
  G compute instances create $vm --project $Project --zone "$Region-a" --machine-type c4d-highcpu-16 --image-family "devcloud-ci-$BootTest" --image-project $Project `
    --boot-disk-size 100GB --boot-disk-type hyperdisk-balanced --provisioning-model SPOT --instance-termination-action DELETE --max-run-duration 900s `
    --no-service-account --no-scopes --metadata-from-file "startup-script=$probe" --labels 'owner=devcloud,purpose=ci-boottest' | Out-Null
  $created = Get-Date
  try {
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep 3
      $s = (& gcloud compute instances get-serial-port-output $vm --project $Project --zone "$Region-a" 2>$null) -join "`n"
      if ($s -match '::runner-ready (\d+)s') {
        $ready = Get-Date
        $img = if ($s -match '::image (\{[^\n]*\})') { $Matches[1] } else { '(not baked)' }
        "boot-test ${BootTest}: create call $([math]::Round(($created - $t0).TotalSeconds,1))s, create->ready $([math]::Round(($ready - $t0).TotalSeconds,1))s wall, guest uptime at ready $($s -replace '(?s).*::runner-ready (\d+)s.*','$1')s"
        "image: $img"
        $tot = ($ready - $t0).TotalSeconds
        if ($tot -ge 60) { 'BOOT-TEST SLOW (>= 60 s)'; exit 2 }
        'BOOT-TEST OK (< 60 s)'; return
      }
    }
    'BOOT-TEST TIMEOUT'; exit 1
  } finally { & gcloud compute instances delete $vm --project $Project --zone "$Region-a" --quiet 2>&1 | Out-Null; "deleted $vm" }
}

if ($Schedule -or $RunNow) {
  # Build SA: creates/deletes bake VMs + images in the runner project, reads the App secrets (lockfile fetch).
  if (-not (& gcloud iam service-accounts describe $sa --project $Control --format='value(email)' 2>$null)) {
    G iam service-accounts create devcloud-image-baker --project $Control --display-name 'devcloud CI image baker (Cloud Build)' | Out-Null; 'SA created'
  }
  G projects add-iam-policy-binding $Project --member "serviceAccount:$sa" --role roles/compute.instanceAdmin.v1 --condition None | Out-Null
  G projects add-iam-policy-binding $Project --member "serviceAccount:$sa" --role roles/compute.storageAdmin --condition None | Out-Null
  G projects add-iam-policy-binding $Control --member "serviceAccount:$sa" --role roles/logging.logWriter --condition None | Out-Null
  foreach ($n in 'devcloud-runners-app-id', 'devcloud-runners-app-key') {
    G secrets add-iam-policy-binding $n --project $Control --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor --condition None | Out-Null
  }
  G storage buckets add-iam-policy-binding "gs://$bucket" --member "serviceAccount:$sa" --role roles/storage.objectViewer | Out-Null
  # Source = this directory (bake.mjs + image-setup.sh), uploaded on every -Schedule so the weekly bake runs the committed scripts.
  $tgz = Join-Path $env:TEMP 'devcloud-images-src.tgz'
  tar -czf $tgz -C $here bake.mjs image-setup.sh
  G storage cp $tgz "gs://$bucket/images/source.tgz" | Out-Null
  # Lockfile fallback for the warm pnpm store when the App has no Contents: read (bake.mjs tries GitHub first).
  $codai = 'E:\gh\codai'
  if (Test-Path $codai) {
    & git -C $codai fetch -q origin main
    foreach ($f in 'pnpm-lock.yaml', 'pnpm-workspace.yaml') {
      $tmp = Join-Path $env:TEMP "devcloud-$f"
      cmd /c "git -C $codai cat-file blob origin/main:$f > `"$tmp`""
      G storage cp $tmp "gs://$bucket/images/$f" | Out-Null
    }
    'lockfile copy uploaded (codai origin/main)'
  }
  $b = Get-Content (Join-Path $here 'build.json') -Raw | ConvertFrom-Json
  $b.PSObject.Properties.Remove('comment')
  $b | Add-Member source @{ storageSource = @{ bucket = $bucket; object = 'images/source.tgz' } }
  $b | Add-Member serviceAccount "projects/$Control/serviceAccounts/$sa"
  $body = Join-Path $env:TEMP 'devcloud-images-build.json'
  [IO.File]::WriteAllText($body, ($b | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  if ($RunNow) {
    $tok = (G auth print-access-token).Trim()
    $r = Invoke-RestMethod -Method Post "https://cloudbuild.googleapis.com/v1/projects/$Control/locations/$Region/builds" -Headers @{ Authorization = "Bearer $tok" } -ContentType 'application/json' -InFile $body
    $tok = $null
    "build started: $($r.metadata.build.id) (gcloud builds log $($r.metadata.build.id) --region $Region --project $Control)"
    return
  }
  # Scheduler SA = the baker SA itself (needs to impersonate itself as the build SA).
  G iam service-accounts add-iam-policy-binding $sa --project $Control --member "serviceAccount:$sa" --role roles/iam.serviceAccountUser | Out-Null
  G projects add-iam-policy-binding $Control --member "serviceAccount:$sa" --role roles/cloudbuild.builds.editor --condition None | Out-Null
  $job = 'devcloud-image-rebake'; $uri = "https://cloudbuild.googleapis.com/v1/projects/$Control/locations/$Region/builds"
  $exists = & gcloud scheduler jobs describe $job --project $Control --location $Region --format='value(name)' 2>$null
  $verb = if ($exists) { 'update' } else { 'create' }
  $hdr = if ($exists) { '--update-headers' } else { '--headers' }
  G scheduler jobs $verb http $job --project $Control --location $Region --schedule $Cron --time-zone 'Etc/UTC' --uri $uri --http-method POST `
    --message-body-from-file $body $hdr 'Content-Type=application/json' --oauth-service-account-email $sa `
    --oauth-token-scope 'https://www.googleapis.com/auth/cloud-platform' --attempt-deadline 60s | Out-Null
  "scheduler $verb $job ($Cron UTC) -> Cloud Build rebake of all devcloud-ci-* families"
}
