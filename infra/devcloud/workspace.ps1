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
#>
param(
  [string]$Ws = 'codai', [string]$Project = 'codai-training', [string]$Zone = 'europe-west4-a',
  [string]$CtlProject = 'dragos-devcloud',
  [string]$Machine = 'c4d-highcpu-64', [int]$BootGb = 300, [int]$Iops = 24000, [int]$ThroughputMb = 1000, [int]$IdleMin = 15,
  [string]$AgentDir = 'E:\gh\agentq\cloud', [switch]$Status, [switch]$Delete, [switch]$UpdateAgent
)
$ErrorActionPreference = 'Stop'
$name = "ws-$Ws"; $bucket = "$CtlProject-devcloud-jobs"; $sa = "devcloud-ws@$Project.iam.gserviceaccount.com"; $region = $Zone -replace '-[a-z]$', ''
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
if (-not $s) { G iam service-accounts create 'devcloud-ws' --project $Project --display-name 'devcloud warm workspaces' | Out-Null; Start-Sleep 5; "sa $sa" }
G storage buckets add-iam-policy-binding "gs://$bucket" --member "serviceAccount:$sa" --role roles/storage.objectAdmin | Out-Null
G secrets add-iam-policy-binding devcloud-turbo-token --project $CtlProject --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor | Out-Null
# suspend itself: custom role with only instances.suspend/get, bound on the VM itself (not the project)
$role = "projects/$Project/roles/devcloudSelfSuspend"
$r = & gcloud iam roles describe devcloudSelfSuspend --project $Project --format='value(name)' 2>$null
if (-not $r) { G iam roles create devcloudSelfSuspend --project $Project --title 'devcloud self suspend' --permissions 'compute.instances.suspend,compute.instances.get' --stage GA | Out-Null }

$turboApi = (G run services describe turbo-cache --project $CtlProject --region europe-central2 --format='value(status.url)').Trim()
$mdFile = Join-Path $env:TEMP 'dc-md'
New-Item -ItemType Directory -Force $mdFile | Out-Null
foreach ($f in 'runner-agent.mjs', 'workspace-startup.sh') {
  $t = [IO.File]::ReadAllText((Join-Path $AgentDir $f)) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $mdFile $f), $t, [Text.UTF8Encoding]::new($false))
}
$meta = "devcloud-bucket=$bucket,devcloud-ws=$Ws,devcloud-idle-min=$IdleMin,devcloud-turbo-api=$turboApi,devcloud-secret-project=$CtlProject,node-version=24.21.0,pnpm-version=12.9.1"
$metaFiles = "startup-script=$mdFile\workspace-startup.sh,runner-agent=$mdFile\runner-agent.mjs"

$exists = & gcloud compute instances describe $name --zone $Zone --project $Project --format='value(status)' 2>$null
if (-not $exists) {
  G compute instances create $name --project $Project --zone $Zone --machine-type $Machine `
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud `
    --boot-disk-type hyperdisk-balanced --boot-disk-size "${BootGb}GB" --boot-disk-auto-delete `
    --boot-disk-provisioned-iops $Iops --boot-disk-provisioned-throughput $ThroughputMb `
    --service-account $sa --scopes cloud-platform `
    --metadata $meta --metadata-from-file $metaFiles `
    --labels "app=devcloud,ws=$Ws" --shielded-secure-boot --shielded-vtpm `
    --reservation-affinity none | Out-Null
  "created $name ($Machine, $Zone)"
} else {
  G compute instances add-metadata $name --zone $Zone --project $Project --metadata $meta --metadata-from-file $metaFiles | Out-Null
  "metadata updated on $name ($exists)"
  if ($UpdateAgent -and $exists -eq 'RUNNING') { G compute ssh $name --zone $Zone --project $Project --command 'sudo google_metadata_script_runner startup' | Out-Null; 'agent restarted' }
}
G compute instances add-iam-policy-binding $name --zone $Zone --project $Project --member "serviceAccount:$sa" --role $role | Out-Null
"self-suspend role bound on $name"
