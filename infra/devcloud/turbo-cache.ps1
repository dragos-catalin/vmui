<#
  devcloud DC-031: self-hosted Turborepo remote cache (ducktors/turborepo-remote-cache) on Cloud Run,
  native GCS storage, bearer token in Secret Manager. Idempotent: re-run to converge.

  pwsh -NoProfile -File infra/devcloud/turbo-cache.ps1            # provision / update
  pwsh -NoProfile -File infra/devcloud/turbo-cache.ps1 -Verify    # PUT+GET an artifact through the real auth path

  Clients: TURBO_API=<url>  TURBO_TOKEN=<secret devcloud-turbo-token>  TURBO_TEAM=dragos
  (or `turbo login --manual`); see docs/devcloud/turbo-cache.md.
#>
param([switch]$Verify, [string]$Project = 'dragos-devcloud', [string]$Region = 'europe-central2', [string]$Image = 'docker.io/ducktors/turborepo-remote-cache:2.14.3')
$ErrorActionPreference = 'Stop'
$svc = 'turbo-cache'; $bucket = "$Project-turbo-cache"; $sa = "turbo-cache@$Project.iam.gserviceaccount.com"; $secret = 'devcloud-turbo-token'
function G { $o = & gcloud @args 2>&1; if ($LASTEXITCODE) { throw "gcloud $($args -join ' ') failed: $o" }; $o }

if (-not $Verify) {
  # Bucket: uniform access, no public, lifecycle deletes artifacts untouched for 30 days.
  $b = & gcloud storage buckets describe "gs://$bucket" --project $Project --format='value(name)' 2>$null
  if (-not $b) { G storage buckets create "gs://$bucket" --project $Project --location $Region --uniform-bucket-level-access --public-access-prevention | Out-Null; "bucket created" }
  $lc = Join-Path $env:TEMP 'turbo-lc.json'
  '{"rule":[{"action":{"type":"Delete"},"condition":{"daysSinceCustomTime":30}},{"action":{"type":"Delete"},"condition":{"age":45}}]}' | Set-Content $lc -Encoding ascii
  G storage buckets update "gs://$bucket" --lifecycle-file $lc | Out-Null

  $s = & gcloud iam service-accounts describe $sa --project $Project --format='value(email)' 2>$null
  if (-not $s) { G iam service-accounts create 'turbo-cache' --project $Project --display-name 'turbo remote cache' | Out-Null; "sa created" }
  G storage buckets add-iam-policy-binding "gs://$bucket" --member "serviceAccount:$sa" --role roles/storage.objectAdmin | Out-Null

  $sec = & gcloud secrets describe $secret --project $Project --format='value(name)' 2>$null
  if (-not $sec) {
    $tok = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
    $tf = Join-Path $env:TEMP 'turbo-tok.txt'; [IO.File]::WriteAllText($tf, $tok)
    try { G secrets create $secret --project $Project --replication-policy automatic --data-file $tf | Out-Null } finally { Remove-Item $tf -Force }
    "secret created"
  }
  G secrets add-iam-policy-binding $secret --project $Project --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor | Out-Null

  G run deploy $svc --project $Project --region $Region --image $Image --service-account $sa `
    --port 3000 --allow-unauthenticated --ingress all --use-http2 `
    --cpu 2 --memory 2Gi --concurrency 200 --min-instances 0 --max-instances 4 --timeout 300 `
    --cpu-boost --execution-environment gen2 `
    --set-env-vars "STORAGE_PROVIDER=google-cloud-storage,STORAGE_PATH=$bucket,LOG_LEVEL=info,BODY_LIMIT=1073741824,HTTP2=true" `
    --set-secrets "TURBO_TOKEN=${secret}:latest" `
    --labels 'app=devcloud,component=turbo-cache' --quiet | Out-Null
  $url = G run services describe $svc --project $Project --region $Region --format='value(status.url)'
  "deployed $svc -> $url"
}

# --- verify through the real auth path: 401 without token, PUT + GET with token ---
$url = (G run services describe $svc --project $Project --region $Region --format='value(status.url)').Trim()
$tok = (G secrets versions access latest --secret $secret --project $Project).Trim()
$hash = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N').Substring(0, 8)
$noAuth = curl.exe -s -o NUL -w '%{http_code}' "$url/v8/artifacts/${hash}?team=dragos"
$body = Join-Path $env:TEMP 'turbo-probe.bin'; [IO.File]::WriteAllBytes($body, [Text.Encoding]::UTF8.GetBytes("probe $hash"))
$hdr = Join-Path $env:TEMP 'turbo-h.txt'; [IO.File]::WriteAllText($hdr, "Authorization: Bearer $tok")
$put = curl.exe -s -o NUL -w '%{http_code}' -X PUT -H "@$hdr" -H 'Content-Type: application/octet-stream' --data-binary "@$body" "$url/v8/artifacts/${hash}?team=dragos"
$got = curl.exe -s -H "@$hdr" "$url/v8/artifacts/${hash}?team=dragos"
Remove-Item $hdr, $body -Force
$ok = ($noAuth -in '400', '401') -and ($put -match '^20') -and ($got -eq "probe $hash")
"verify: noauth=$noAuth put=$put get=$(if ($got -eq "probe $hash") { 'match' } else { 'MISMATCH' }) -> $(if ($ok) { 'OK' } else { 'FAIL' })"
$rev = (G run services describe $svc --project $Project --region $Region --format='value(status.latestReadyRevisionName)').Trim()
"revision: $rev"
if (-not $ok) { exit 1 }
