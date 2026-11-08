<#
.SYNOPSIS
  Build + deploy the Vatra Cloud Cloud Run services (vatra-push, vatra-acme, vatra-demo) in dragos-devcloud.
.DESCRIPTION
  Run through deploy-clean.ps1 (clean worktree at a pushed commit). Images are built by Cloud Build;
  secrets come from Secret Manager (names in cloud/README.md). The relay VM is installed separately
  (cloud/relay/install.sh). Every service carries labels app=vatra-cloud,component=<name>.
.EXAMPLE
  pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\deploy-clean.ps1" -Command 'pwsh -NoProfile -File cloud/deploy.ps1 -Service push,acme'
#>
[CmdletBinding()]
param(
  [string[]]$Service = @('push', 'acme'),
  [string]$Project = 'dragos-devcloud',
  [string]$Region = 'europe-central2',
  [string]$RelayAddr = '34.158.236.161:8443',
  [string]$RelayPin = 'vPdpD1kjdaSNPeYX7TJ9fXq4WOpYi_9B6NBZ6oHR7JM',
  # beta allow-list for remote access (ACME + relay tokens), comma list of hub ids; 'none' = nobody, '*' = everyone.
  # 7562iws7anbxe2kd = homepi (owner's hub, first beta hub, 2026-11-08)
  [string]$AllowHubs = '7562iws7anbxe2kd'
)
$ErrorActionPreference = 'Stop'
$Service = @($Service | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$root = Split-Path -Parent $PSScriptRoot
$repo = "$Region-docker.pkg.dev/$Project/vatra"
$sha = (git -C $root rev-parse --short=12 HEAD).Trim()

if (-not (gcloud artifacts repositories list --project $Project --location $Region --filter='name~vatra$' --format='value(name)')) {
  gcloud artifacts repositories create vatra --repository-format=docker --location $Region --project $Project '--labels=app=vatra-cloud' | Out-Null
}

$sa = "vatra-cloud-run@$Project.iam.gserviceaccount.com"
if (-not (gcloud iam service-accounts list --project $Project --filter="email=$sa" --format='value(email)')) {
  gcloud iam service-accounts create vatra-cloud-run --project $Project --display-name='Vatra Cloud Run services' | Out-Null
}

function Grant([string]$secret) {
  gcloud secrets add-iam-policy-binding $secret --project $Project "--member=serviceAccount:$sa" --role=roles/secretmanager.secretAccessor --condition=None 2>&1 | Out-Null
}

function Build([string]$name, [string]$context, [string]$dockerfile) {
  $img = "$repo/${name}:$sha"
  $cfg = Join-Path ([IO.Path]::GetTempPath()) "cb-$name-$sha.yaml"
  @"
steps:
- name: gcr.io/cloud-builders/docker
  args: ['build', '-f', '$dockerfile', '-t', '$img', '.']
  env: ['DOCKER_BUILDKIT=1']
images: ['$img']
tags: ['vatra-cloud', '$name']
options:
  logging: CLOUD_LOGGING_ONLY
  machineType: E2_HIGHCPU_8
"@ | Set-Content -Encoding ascii $cfg
  gcloud builds submit $context --config $cfg --project $Project --region $Region | Out-Host
  if ($LASTEXITCODE) { throw "build $name failed" }
  Remove-Item $cfg
  return $img
}

function SecretEnv([hashtable]$map) { ($map.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value):latest" }) -join ',' }

if ($Service -contains 'push') {
  $img = Build 'vatra-push' (Join-Path $root 'cloud') 'Dockerfile.push'
  $secrets = @{ VATRA_PUSH_HANDLE_KEY = 'vatra-push-handle-key'; VATRA_CLOUD_SIGNING_KEY = 'vatra-cloud-signing-key' }
  # APNs / FCM are optional: present secrets are wired, absent ones leave the platform 503 not_configured
  $optional = @{ APNS_KEY = 'apns-auth-key-p8'; APNS_KEY_ID = 'apns-key-id'; APNS_TEAM_ID = 'apple-team-id'; FCM_SERVICE_ACCOUNT_JSON = 'vatra-fcm-service-account' }
  foreach ($k in $optional.Keys) {
    if (gcloud secrets list --project $Project "--filter=name~$($optional[$k])$" --format='value(name)') { $secrets[$k] = $optional[$k] }
  }
  $secrets.Values | ForEach-Object { Grant $_ }
  $envs = "VATRA_CLOUD_DOMAIN=vatra.dragoscatalin.ro,VATRA_CLOUD_RELAY=$RelayAddr,VATRA_CLOUD_RELAY_PIN=$RelayPin,APNS_TOPIC=ro.vatra.app"
  gcloud run deploy vatra-push --image $img --project $Project --region $Region --service-account $sa `
    --allow-unauthenticated --min-instances 1 --max-instances 1 --cpu 1 --memory 256Mi --concurrency 200 `
    "--set-env-vars=^@^$($envs -replace ',', '@')@VATRA_CLOUD_ALLOW_HUBS=$AllowHubs" "--set-secrets=$(SecretEnv $secrets)" `
    '--labels=app=vatra-cloud,component=push' | Out-Host
  if ($LASTEXITCODE) { throw 'deploy push failed' }
}

if ($Service -contains 'acme') {
  $img = Build 'vatra-acme' (Join-Path $root 'cloud') 'Dockerfile.acme'
  $secrets = @{}
  if (gcloud secrets list --project $Project '--filter=name~vatra-acme-dns-token$' --format='value(name)') { $secrets['BRIVIO_ACME_TOKEN'] = 'vatra-acme-dns-token'; Grant 'vatra-acme-dns-token' }
  $args2 = @()
  if ($secrets.Count) { $args2 += "--set-secrets=$(SecretEnv $secrets)" }
  gcloud run deploy vatra-acme --image $img --project $Project --region $Region --service-account $sa `
    --allow-unauthenticated --min-instances 0 --max-instances 1 --cpu 1 --memory 128Mi `
    "--set-env-vars=^@^VATRA_CLOUD_DOMAIN=vatra.dragoscatalin.ro@VATRA_CLOUD_ALLOW_HUBS=$AllowHubs" @args2 `
    '--labels=app=vatra-cloud,component=acme' | Out-Host
  if ($LASTEXITCODE) { throw 'deploy acme failed' }
}

if ($Service -contains 'demo') {
  $img = Build 'vatra-demo' $root 'Dockerfile'
  'vatra-demo-review-password', 'vatra-demo-invite' | ForEach-Object { Grant $_ }
  gcloud run deploy vatra-demo --image $img --project $Project --region $Region --service-account $sa `
    --allow-unauthenticated --min-instances 0 --max-instances 1 --cpu 1 --memory 1Gi --port 3737 `
    '--set-env-vars=^@^VATRA_DEMO=1@VMUI_DB_PATH=/tmp/vatra/vmui.db@VATRA_MASTER_KEY_FILE=/tmp/vatra/vatra-master.key' `
    '--set-secrets=VATRA_DEMO_REVIEW_PASSWORD=vatra-demo-review-password:latest,VATRA_DEMO_INVITE=vatra-demo-invite:latest' `
    '--labels=app=vatra-cloud,component=demo' | Out-Host
  if ($LASTEXITCODE) { throw 'deploy demo failed' }
}
"DEPLOYED $($Service -join ',') @ $sha"
