<#
  Put a GitHub credential on the devcloud workspaces: Secret Manager -> /home/dev/.config/gh/hosts.yml,
  installed by workspace-startup.sh on the next boot / -UpdateAgent. The token is never printed, never
  passed as an argument (it would land in the shell history and in this transcript) and never written to
  a file that outlives the call.

  pwsh -NoProfile -File infra/devcloud/set-github-token.ps1 -Status
  pwsh -NoProfile -File infra/devcloud/set-github-token.ps1 -FromGhCli        # reuse `gh auth token`
  pwsh -NoProfile -File infra/devcloud/set-github-token.ps1 -TokenFile C:\path\to\pat.txt

  -FromGhCli copies YOUR login token: broad scopes, tied to your identity, and it outlives the VM. Prefer
  -TokenFile with a fine-grained PAT (contents:read on the repos the jobs touch) or a GitHub App
  installation token. Revoke by destroying the secret version:
    gcloud secrets versions destroy latest --secret devcloud-github-token --project dragos-devcloud
  Then, so the VMs stop advertising the old value:
    gcloud compute ssh <vm> --command 'sudo rm -f /opt/devcloud/.gh-token-v1 && sudo google_metadata_script_runner startup'
  The workspace SA also needs secretAccessor - the provisioner grants it:
    ... -SecretAccess 'dragos-devcloud:devcloud-github-token'
#>
param(
  [string]$Secret = 'devcloud-github-token',
  [string]$Project = 'dragos-devcloud',
  [string]$TokenFile,
  [switch]$FromGhCli,
  [switch]$Status
)
$ErrorActionPreference = 'Stop'

if ($Status) {
  $d = & gcloud secrets describe $Secret --project $Project --format='value(name)' 2>$null
  if (-not $d) { "secret ${Project}/${Secret}: MISSING (no credential on the workspaces)"; exit 0 }
  $vers = @(& gcloud secrets versions list $Secret --project $Project --format='value(name,state)' 2>$null)
  "secret ${Project}/${Secret}: $($vers.Count) version(s)"
  $vers | ForEach-Object { "  $_" }
  "consumers: workspace VMs whose toolchains include 'gh' AND whose SA was granted secretAccessor"
  'gcloud secrets add-iam-policy-binding ' + $Secret + " --project $Project --format='value(bindings.members)'" | Write-Host
  & gcloud secrets get-iam-policy $Secret --project $Project --format='value(bindings[].members[])' 2>$null | ForEach-Object { "  accessor $_" }
  exit 0
}

$tmp = [IO.Path]::GetTempFileName()
try {
  if ($TokenFile) {
    if (-not (Test-Path $TokenFile)) { throw "no such file: $TokenFile" }
    Copy-Item $TokenFile $tmp -Force
  } elseif ($FromGhCli) {
    $t = (& gh auth token) -join ''
    if (-not $t) { throw 'gh auth token returned nothing - run `gh auth login` first' }
    [IO.File]::WriteAllText($tmp, $t, [Text.UTF8Encoding]::new($false))
  } else {
    throw 'give -FromGhCli or -TokenFile <path> (a token in argv would end up in the transcript)'
  }
  $len = (Get-Item $tmp).Length
  if ($len -lt 20) { throw "the token looks too short ($len bytes)" }

  $exists = & gcloud secrets describe $Secret --project $Project --format='value(name)' 2>$null
  if (-not $exists) {
    & gcloud secrets create $Secret --project $Project --replication-policy automatic --labels owner=devcloud 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw "secret create $Secret failed" }
    "created secret $Project/$Secret"
  }
  & gcloud secrets versions add $Secret --project $Project --data-file $tmp 2>&1 | Out-Null
  if ($LASTEXITCODE) { throw "secret add failed" }
  "stored a $len-byte token in $Project/$Secret (value never printed)"
  "grant the workspace SA access: workspace.ps1 ... -SecretAccess '$Project`:$Secret'"
  "then make the VMs adopt it: workspace.ps1 -Ws <ws> -Toolchains '...,gh' -UpdateAgent (needs a boot for a fresh VM)"
} finally {
  Remove-Item $tmp -Force -EA SilentlyContinue
}
