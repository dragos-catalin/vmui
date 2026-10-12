<#
  devcloud F3 (DC-040): register the GitHub App "devcloud-runners" from a manifest and store its
  credentials in Secret Manager. The owner clicks "Create GitHub App" and then "Install" (only those
  two clicks); everything else is scripted.

  pwsh -NoProfile -File infra/devcloud/github-app.ps1 -WebhookUrl https://<ci-controller>/webhook
  pwsh -NoProfile -File infra/devcloud/github-app.ps1 -Status        # app + installation + secrets present?

  Flow: a loopback page on 127.0.0.1:<port> POSTs the manifest to
  github.com/organizations/<org>/settings/apps/new; GitHub redirects back with ?code=, which is
  exchanged at POST /app-manifests/{code}/conversions for id + pem + webhook_secret. Those go
  straight into Secret Manager (devcloud-runners-app-id/-app-key/-webhook-secret), never to disk,
  stdout or the log. The `state` nonce rejects a foreign redirect.
  Permissions: organization_self_hosted_runners=write (JIT config), actions=read (job metadata).
  Event: workflow_job. Private app (installable only on the owner org).
#>
param([string]$WebhookUrl, [string]$Org = 'codai-ro', [string]$Project = 'dragos-devcloud', [string]$Name = 'devcloud-runners',
  [int]$Port = 47613, [int]$TimeoutMin = 15, [switch]$Status)
$ErrorActionPreference = 'Stop'
$secrets = @{ id = 'devcloud-runners-app-id'; pem = 'devcloud-runners-app-key'; hook = 'devcloud-runners-webhook-secret' }
function Set-Secret([string]$n, [string]$v) {
  if (-not (& gcloud secrets describe $n --project $Project --format='value(name)' 2>$null)) {
    & gcloud secrets create $n --project $Project --replication-policy automatic --labels owner=devcloud 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw "secret create $n failed" }
  }
  $tmp = [IO.Path]::GetTempFileName()
  try { [IO.File]::WriteAllText($tmp, $v, [Text.UTF8Encoding]::new($false)); & gcloud secrets versions add $n --project $Project --data-file $tmp 2>&1 | Out-Null; if ($LASTEXITCODE) { throw "secret add $n failed" } }
  finally { Remove-Item $tmp -Force -EA SilentlyContinue }
}

if ($Status) {
  foreach ($k in $secrets.Keys) { $v = & gcloud secrets versions list $secrets[$k] --project $Project --filter state=enabled --format='value(name)' 2>$null; "{0,-34} {1}" -f $secrets[$k], $(if ($v) { "versions: $(@($v).Count)" } else { 'MISSING' }) }
  $id = (& gcloud secrets versions access latest --secret $secrets.id --project $Project 2>$null) -join ''
  if ($id) { "app id: $id"; $inst = gh api "orgs/$Org/installations" --jq ".installations[] | select(.app_id==$id) | `"installation \(.id) repos=\(.repository_selection) events=\(.events|join(`",`"))`"" 2>&1; if ($inst) { $inst } else { "NOT INSTALLED on $Org (open https://github.com/organizations/$Org/settings/installations)" } }
  return
}
if (-not $WebhookUrl) { throw '-WebhookUrl https://<ci-controller>/webhook is required (deploy ci-controller first)' }

$state = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()
$redirect = "http://127.0.0.1:$Port/callback"
$manifest = [ordered]@{
  name = $Name; url = 'https://github.com/codai-ro'; description = 'devcloud ephemeral JIT runners: one GCE VM per workflow job (ci-controller, DC-041)'
  public = $false; redirect_url = $redirect
  hook_attributes = [ordered]@{ url = $WebhookUrl; active = $true }
  default_permissions = [ordered]@{ organization_self_hosted_runners = 'write'; actions = 'read'; metadata = 'read' }
  default_events = @('workflow_job')
} | ConvertTo-Json -Depth 4 -Compress
$enc = [Net.WebUtility]::HtmlEncode($manifest)
$page = "<!doctype html><meta charset=utf-8><title>$Name</title><body style='font:16px system-ui;margin:3em'><h2>Register GitHub App <code>$Name</code> on <code>$Org</code></h2><p>Webhook: <code>$WebhookUrl</code><br>Permissions: self-hosted runners (org) write, actions read. Event: workflow_job.</p><form method=post action='https://github.com/organizations/$Org/settings/apps/new?state=$state'><input type=hidden name=manifest value='$enc'><button style='font-size:18px;padding:.6em 1.2em'>Continue to GitHub</button></form>"

$l = [Net.HttpListener]::new(); $l.Prefixes.Add("http://127.0.0.1:$Port/"); $l.Start()
"Open in your browser: http://127.0.0.1:$Port/  -> click 'Continue to GitHub' -> 'Create GitHub App for $Org'"
Start-Process "http://127.0.0.1:$Port/"
$deadline = (Get-Date).AddMinutes($TimeoutMin); $code = $null
try {
  while (-not $code -and (Get-Date) -lt $deadline) {
    $t = $l.GetContextAsync(); while (-not $t.Wait(1000)) { if ((Get-Date) -gt $deadline) { break } }
    if (-not $t.IsCompleted) { break }
    $ctx = $t.Result; $q = $ctx.Request.QueryString
    $msg = if ($ctx.Request.Url.AbsolutePath -eq '/callback') {
      if ($q['state'] -ne $state) { 'state mismatch - ignored' } elseif (-not $q['code']) { 'no code' } else { $code = $q['code']; 'App created. Back in the terminal; next GitHub opens the install page.' }
    } else { $null }
    $out = [Text.Encoding]::UTF8.GetBytes($(if ($msg) { "<!doctype html><meta charset=utf-8><body style='font:16px system-ui;margin:3em'>$msg" } else { $page }))
    $ctx.Response.ContentType = 'text/html; charset=utf-8'; $ctx.Response.OutputStream.Write($out, 0, $out.Length); $ctx.Response.Close()
  }
} finally { $l.Stop() }
if (-not $code) { throw "no callback within $TimeoutMin min" }

# Exchange the one-time code (valid 1 h). Response holds the private key: keep it in memory only.
$r = Invoke-RestMethod -Method Post -Uri "https://api.github.com/app-manifests/$code/conversions" -Headers @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
Set-Secret $secrets.id ([string]$r.id)
Set-Secret $secrets.pem $r.pem
Set-Secret $secrets.hook $r.webhook_secret
"app '$($r.slug)' id=$($r.id) owner=$($r.owner.login): id/key/webhook secret stored in Secret Manager ($Project)"
$r = $null
"Now install it on $Org (select the codai-cc repo, or all repos): https://github.com/apps/$Name/installations/new"
Start-Process "https://github.com/apps/$Name/installations/new"
