<#
  devcloud DC-035: warm workspace VM per repo (default codai).
  The VM + its SA + the self-suspend role live in -Project (codai-training: C4D quota is denied in
  dragos-devcloud, 2026-10-12); the control plane stays in -CtlProject (dragos-devcloud): job bucket
  <ctl>-devcloud-jobs, secret devcloud-turbo-token, turbo-cache Cloud Run. Cross-project IAM below.
  c4d-highcpu-64 (AMD Turin, 64 vCPU, 120 GB; C4D has no highcpu-lssd variant, and >208 GB RAM
  cannot be suspended) + Hyperdisk Balanced 300 GB at 24k IOPS / 1000 MB/s. Owner choice 2026-10-12.
  The runner-agent claims jobs from GCS and suspends the VM after -IdleMin idle minutes.

  pwsh -NoProfile -File infra/devcloud/workspace.ps1 -Ws codai               # create or update metadata
  pwsh -NoProfile -File infra/devcloud/workspace.ps1 -Ws codai -Status
  pwsh -NoProfile -File infra/devcloud/workspace.ps1 -Ws codai -UpdateAgent  # push agent + restart it
  pwsh -NoProfile -File infra/devcloud/workspace.ps1 -Ws codai -Delete       # irreversible (asks)

  DC-063 Windows workspace (Windows-only gates: windows crate, Tauri, vitals-win, scripts/verify.ps1):
  pwsh -NoProfile -File infra/devcloud/workspace.ps1 -Ws vitals-win -Os windows
  -> image family devcloud-ci-win-desktop (codai-training, DC-051), c4d-standard-16 (16 vCPU / 62 GB),
  300 GB hyperdisk-balanced, metadata windows-startup-script-ps1 (agentq cloud/workspace-startup.ps1)
  + runner-agent. -UpdateAgent on Windows only rewrites metadata: the idle agent adopts it within ~60 s.

  ws-watch-faces (Gradle/Android gates, 2026-10-19): own service account, so only this VM can read the
  Horae signing keys (accessor on exactly those secrets, in their own project):
  pwsh -NoProfile -File infra/devcloud/workspace.ps1 -Ws watch-faces -Machine c4d-highcpu-32 -BootGb 150 -Iops 6000 -ThroughputMb 400 `
    -Sa devcloud-ws-horae -Toolchains android-jdk21 -CleanKeep 'build,tools/wff-tools/*.jar' `
    -SecretAccess 'horae-watchfaces:horae-keystore-push-jks;horae-watchfaces:horae-keystore-push-properties;...'
#>
param(
  [string]$Ws = 'codai', [string]$Project = 'codai-training', [string]$Zone = 'europe-west4-a',
  [string]$CtlProject = 'dragos-devcloud', [ValidateSet('linux', 'windows')][string]$Os = 'linux',
  [string]$Machine = '', [int]$BootGb = 300, [int]$Iops = 24000, [int]$ThroughputMb = 1000, [int]$IdleMin = 15,
  [string]$AgentDir = 'E:\gh\agentq\cloud', [switch]$Status, [switch]$Delete, [switch]$UpdateAgent,
  # service account id in -Project (default devcloud-ws, shared by codai + vitals-win)
  [string]$Sa = 'devcloud-ws',
  # metadata devcloud-toolchains for workspace-startup.sh (linux): e.g. android-jdk21
  [string]$Toolchains = '',
  # metadata devcloud-clean-keep for runner-agent: extra `git clean -e` patterns kept between jobs
  [string]$CleanKeep = '',
  # 'project:secret;project:secret' -> roles/secretmanager.secretAccessor for -Sa on each secret only
  [string]$SecretAccess = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Machine) { $Machine = if ($Os -eq 'windows') { 'c4d-standard-16' } else { 'c4d-highcpu-64' } }
$name = "ws-$Ws"; $bucket = "$CtlProject-devcloud-jobs"; $sa = "$Sa@$Project.iam.gserviceaccount.com"; $region = $Zone -replace '-[a-z]$', ''
function G { $o = & gcloud @args 2>&1; if ($LASTEXITCODE) { throw "gcloud $($args -join ' ') failed: $o" }; $o }

if ($Status) {
  & gcloud compute instances describe $name --zone $Zone --project $Project --format='table(name,status,machineType.basename(),lastStartTimestamp,lastSuspendedTimestamp)' 2>&1
  & gcloud storage cat "gs://$bucket/ws/$Ws/heartbeat" 2>$null; ''
  exit 0
}
if ($Delete) {
  $ans = Read-Host "Delete VM $name (boot disk data lost)? type the name to confirm"
  if ($ans -ne $name) { 'aborted'; exit 1 }
  G compute instances delete $name --zone $Zone --project $Project --quiet | Out-Null; "deleted $name"; exit 0
}

# --- shared infra (idempotent). Bucket + secret in the control project; SA + role in the VM project.
$b = & gcloud storage buckets describe "gs://$bucket" --project $CtlProject --format='value(name)' 2>$null
if (-not $b) {
  G storage buckets create "gs://$bucket" --project $CtlProject --location $region --uniform-bucket-level-access --public-access-prevention | Out-Null
  $lc = Join-Path $env:TEMP 'dc-lc.json'; '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7,"matchesPrefix":["jobs/"]}}]}' | Set-Content $lc -Encoding ascii
  G storage buckets update "gs://$bucket" --lifecycle-file $lc | Out-Null; "bucket $bucket"
}
$s = & gcloud iam service-accounts describe $sa --project $Project --format='value(email)' 2>$null
# $sa (email) and the -Sa param are the SAME PowerShell variable (names are case-insensitive): take the id from the email.
$saId = ($sa -split '@')[0]
if (-not $s) { G iam service-accounts create $saId --project $Project --display-name "devcloud warm workspace ($saId)" | Out-Null; Start-Sleep 5; "sa $sa" }
G storage buckets add-iam-policy-binding "gs://$bucket" --member "serviceAccount:$sa" --role roles/storage.objectAdmin | Out-Null
G secrets add-iam-policy-binding devcloud-turbo-token --project $CtlProject --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor | Out-Null
foreach ($ps in @($SecretAccess -split ';' | Where-Object { $_ })) {
  $sp, $sn = $ps -split ':', 2
  G secrets add-iam-policy-binding $sn --project $sp --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor | Out-Null
  "secret accessor: $sp/$sn"
}
# suspend itself: custom role with only instances.suspend/get, bound on the VM itself (not the project)
$role = "projects/$Project/roles/devcloudSelfSuspend"
$r = & gcloud iam roles describe devcloudSelfSuspend --project $Project --format='value(name)' 2>$null
if (-not $r) { G iam roles create devcloudSelfSuspend --project $Project --title 'devcloud self suspend' --permissions 'compute.instances.suspend,compute.instances.get' --stage GA | Out-Null }

$turboApi = (G run services describe turbo-cache --project $CtlProject --region europe-central2 --format='value(status.url)').Trim()
$mdFile = Join-Path $env:TEMP 'dc-md'
New-Item -ItemType Directory -Force $mdFile | Out-Null
$startup = if ($Os -eq 'windows') { 'workspace-startup.ps1' } else { 'workspace-startup.sh' }
foreach ($f in 'runner-agent.mjs', $startup) {
  $t = [IO.File]::ReadAllText((Join-Path $AgentDir $f)) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $mdFile $f), $t, [Text.UTF8Encoding]::new($false))
}
$meta = "devcloud-bucket=$bucket,devcloud-ws=$Ws,devcloud-idle-min=$IdleMin,devcloud-turbo-api=$turboApi,devcloud-secret-project=$CtlProject,node-version=24.21.0,pnpm-version=12.9.1"
# values with commas need gcloud's alternate-delimiter syntax: ^@^ makes '@' the pair separator
$meta = '^@^' + ($meta -replace ',', '@') + "@devcloud-toolchains=$Toolchains@devcloud-clean-keep=$CleanKeep"
$startupKey = if ($Os -eq 'windows') { 'windows-startup-script-ps1' } else { 'startup-script' }
$metaFiles = "$startupKey=$mdFile\$startup,runner-agent=$mdFile\runner-agent.mjs"
$img = if ($Os -eq 'windows') { @('--image-family', 'devcloud-ci-win-desktop', '--image-project', $Project) } else { @('--image-family', 'ubuntu-2404-lts-amd64', '--image-project', 'ubuntu-os-cloud') }

$exists = & gcloud compute instances describe $name --zone $Zone --project $Project --format='value(status)' 2>$null
if (-not $exists) {
  G compute instances create $name --project $Project --zone $Zone --machine-type $Machine `
    @img `
    --boot-disk-type hyperdisk-balanced --boot-disk-size "${BootGb}GB" --boot-disk-auto-delete `
    --boot-disk-provisioned-iops $Iops --boot-disk-provisioned-throughput $ThroughputMb `
    --service-account $sa --scopes cloud-platform `
    --metadata $meta --metadata-from-file $metaFiles `
    --labels "app=devcloud,ws=$Ws,os=$Os,reaper=keep" --shielded-secure-boot --shielded-vtpm `
    --reservation-affinity none | Out-Null
  "created $name ($Os, $Machine, $Zone)"
} else {
  G compute instances add-metadata $name --zone $Zone --project $Project --metadata $meta --metadata-from-file $metaFiles | Out-Null
  "metadata updated on $name ($exists)"
  if ($UpdateAgent -and $exists -eq 'RUNNING') {
    if ($Os -eq 'windows') { 'windows: the idle agent adopts the new runner-agent from metadata within ~60 s' }
    else { G compute ssh $name --zone $Zone --project $Project --command 'sudo google_metadata_script_runner startup' | Out-Null; 'agent restarted' }
  }
}
G compute instances add-iam-policy-binding $name --zone $Zone --project $Project --member "serviceAccount:$sa" --role $role | Out-Null
"self-suspend role bound on $name"
