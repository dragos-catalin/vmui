<#
  devcloud DC-032: enable the self-hosted turbo remote cache for every build on THIS machine.
  Writes ~/.codai/turbo-remote.json {api, team} and ~/.codai/turbo-remote.key (token, DPAPI CurrentUser).
  run-build.ps1 reads them and exports TURBO_API/TURBO_TEAM/TURBO_TOKEN only for repos with turbo.json,
  unless the caller already set TURBO_TOKEN or RUN_BUILD_NO_REMOTE_CACHE=1.

  pwsh -NoProfile -File infra/devcloud/turbo-client-setup.ps1 [-Remove]
#>
param([switch]$Remove, [string]$Project = 'dragos-devcloud', [string]$Region = 'europe-central2', [string]$Team = 'dragos')
$ErrorActionPreference = 'Stop'
$dir = Join-Path $HOME '.codai'; New-Item -ItemType Directory -Force $dir | Out-Null
$cfg = Join-Path $dir 'turbo-remote.json'; $key = Join-Path $dir 'turbo-remote.key'
if ($Remove) { Remove-Item $cfg, $key -Force -ErrorAction SilentlyContinue; 'removed'; exit 0 }
$api = (& gcloud run services describe turbo-cache --project $Project --region $Region --format='value(status.url)').Trim()
$tok = (& gcloud secrets versions access latest --secret devcloud-turbo-token --project $Project).Trim()
if (-not $api -or $tok.Length -lt 32) { throw 'could not read turbo-cache url/token' }
@{ api = $api; team = $Team; project = $Project; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content $cfg -Encoding utf8
$enc = ConvertFrom-SecureString (ConvertTo-SecureString $tok -AsPlainText -Force)
[IO.File]::WriteAllText($key, $enc)
"configured $api (team $Team); token DPAPI-encrypted in $key (length $($tok.Length))"
