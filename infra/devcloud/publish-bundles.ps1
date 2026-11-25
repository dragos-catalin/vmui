<#
  devcloud: publish-bundles.ps1 - put every frontiers repo (plus wdw-cosmology) where a workspace VM can
  obtain it without GitHub credentials.

  WHY: a devcloud workspace VM has NO GitHub credentials (probed on ws-frontiers 2026-11-25: `gh` missing,
  `git clone https://github.com/...` -> "could not read Username"), so a private sibling arrives only as a
  git bundle travelling through the jobs bucket the runner already reads. This is the generalisation of
  frontier-kit/scripts/cloud-bootstrap.ps1, which publishes the single sibling every frontier repo needs
  ([tool.uv.sources] ../frontier-kit) as gs://<bucket>/bootstrap/frontier-kit.bundle. That script is left
  untouched and still produces frontier-kit.bundle; this one produces the same bundle AND a bundle for
  every other repo, so a future gate that needs a different sibling finds it already published.

  Conventions mirrored from frontier-kit/scripts/cloud-bootstrap.ps1:
    git bundle create <tmp> --all ; a <name>.commit stamp carrying the sha ; no secret in the output.

  Uploads are BATCHED into one `gcloud storage cp` (a per-file call costs ~18 s of gcloud startup, so 30
  sequential calls take ~10 min and get killed; one call plus an only-on-failure per-file retry takes ~20 s).

  Run it (seconds, idempotent) after any commit the cloud must see:
      pwsh -NoProfile -File infra/devcloud/publish-bundles.ps1
      pwsh -NoProfile -File infra/devcloud/publish-bundles.ps1 -Include ramsey-sat,sphere-codes
      pwsh -NoProfile -File infra/devcloud/publish-bundles.ps1 -Skip frontiers-index -DryRun
#>
[CmdletBinding()]
param(
  # Root whose direct children (with a .git) form the default repo set.
  [string]$Root = 'E:\gh\frontiers',
  # Extra repo directories outside -Root, always candidates (default: the cosmology repo).
  [string[]]$Extra = @('E:\gh\wdw-cosmology'),
  # Restrict to these directory leaf names (empty = all candidates).
  [string[]]$Include = @(),
  # Drop these directory leaf names from the candidate set.
  [string[]]$Skip = @(),
  [string]$Bucket = 'gs://dragos-devcloud-devcloud-jobs',
  # Create the bundle and print the line, but do not upload.
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

# `-Include a,b` may reach us as one string ("a,b") when the script is launched through `pwsh -File`,
# so split on commas (and trim) whichever way the shell tokenised the list.
$Include = @($Include | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$Skip    = @($Skip    | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

function Get-CandidateRepos {
  $dirs = [System.Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $Root) {
    Get-ChildItem -LiteralPath $Root -Directory -ErrorAction Stop | ForEach-Object {
      if (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) { $dirs.Add($_.FullName) }
    }
  } else {
    Write-Warning "publish-bundles: root not found: $Root"
  }
  foreach ($e in $Extra) {
    if (Test-Path -LiteralPath (Join-Path $e '.git')) { $dirs.Add((Resolve-Path -LiteralPath $e).Path) }
  }
  $dirs | Sort-Object -Unique
}

# One `gcloud storage cp` for the whole set; only if that fails, retry per file to attribute the failure.
function Send-ToBucket {
  param([string[]]$Paths, [string]$DestPrefix)
  $bad = [System.Collections.Generic.List[string]]::new()
  if ($Paths.Count -eq 0) { return $bad }
  $batch = (& gcloud storage cp --quiet @Paths $DestPrefix 2>&1)
  if ($LASTEXITCODE -eq 0) { return $bad }
  foreach ($p in $Paths) {
    $one = (& gcloud storage cp --quiet $p $DestPrefix 2>&1)
    if ($LASTEXITCODE -ne 0) { $bad.Add($p) }
  }
  return $bad
}

$candidates = @(Get-CandidateRepos)
if ($Include.Count -gt 0) { $candidates = @($candidates | Where-Object { $Include -contains (Split-Path $_ -Leaf) }) }
if ($Skip.Count -gt 0) { $candidates = @($candidates | Where-Object { $Skip -notcontains (Split-Path $_ -Leaf) }) }

if ($candidates.Count -eq 0) {
  Write-Warning 'publish-bundles: no repositories selected'
  exit 0
}

# Per-run scratch dir: a second instance of this script (or a -DryRun beside a real run) must not
# delete the bundle out from under this one, which fixed temp names did.
$tmpDir = Join-Path ([IO.Path]::GetTempPath()) "publish-bundles-$PID"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$records = @()
$i = 0
foreach ($repo in $candidates) {
  $i++
  $name = Split-Path $repo -Leaf
  Write-Host ('publish-bundles: [{0}/{1}] bundling {2}' -f $i, $candidates.Count, $name)
  $rec = [pscustomobject]@{ Name = $name; Ok = $false; Reason = ''; Bundle = (Join-Path $tmpDir "$name.bundle")
                            Stamp = (Join-Path $tmpDir "$name.commit"); Objects = 0; Bytes = 0; Sha = '' }
  $records += $rec
  try {
    # Capture first, then read $LASTEXITCODE: piping a native command into Select-Object -First 1 closes
    # the pipe early and can leave a nonzero native exit code behind.
    $shaOut = (& git -C $repo rev-parse HEAD 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "git rev-parse failed: $shaOut" }
    $sha = [string]($shaOut | Select-Object -First 1)
    $sha = $sha.Trim()
    $objOut = (& git -C $repo rev-list --objects --all 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "git rev-list failed: $objOut" }
    $objects = ($objOut | Measure-Object).Count

    Remove-Item -LiteralPath $rec.Bundle -Force -ErrorAction SilentlyContinue
    $bundleLog = (& git -C $repo bundle create $rec.Bundle --all 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "git bundle create failed: $bundleLog" }
    if (-not (Test-Path -LiteralPath $rec.Bundle)) { throw 'git bundle create produced no file' }

    $rec.Sha = $sha
    $rec.Objects = $objects
    $rec.Bytes = (Get-Item -LiteralPath $rec.Bundle).Length
    $rec.Ok = $true
  } catch {
    $rec.Reason = $_.Exception.Message
  }
}

if (-not $DryRun) {
  $okRecs = @($records | Where-Object { $_.Ok })
  if ($okRecs.Count -gt 0) {
    # The sha stamp mirrors cloud-bootstrap.ps1; write them all, then upload everything in one call.
    foreach ($r in $okRecs) { Set-Content -NoNewline -LiteralPath $r.Stamp -Value $r.Sha }
    $all = @($okRecs | ForEach-Object { $_.Bundle }) + @($okRecs | ForEach-Object { $_.Stamp })
    $bad = Send-ToBucket -Paths $all -DestPrefix "$Bucket/bootstrap/"
    foreach ($r in $okRecs) {
      if ($bad -contains $r.Bundle) { $r.Ok = $false; $r.Reason = 'upload failed' }
      elseif ($bad -contains $r.Stamp) { $r.Ok = $false; $r.Reason = 'upload failed (stamp)' }
    }
  }
}

foreach ($r in $records) {
  $target = "$Bucket/bootstrap/$($r.Name).bundle"
  if (-not $r.Ok) {
    'FAILED {0}: {1}' -f $r.Name, $r.Reason
  } elseif ($DryRun) {
    '{0}: {1} objects, {2} bytes -> {3} (dry-run, not uploaded)' -f $r.Name, $r.Objects, $r.Bytes, $target
  } else {
    '{0}: {1} objects, {2} bytes -> {3} (at {4})' -f $r.Name, $r.Objects, $r.Bytes, $target, $r.Sha.Substring(0, 7)
  }
}

Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

$failed = @($records | Where-Object { -not $_.Ok }).Count
if ($failed -gt 0) {
  "publish-bundles: $failed of $($candidates.Count) repo(s) FAILED"
  exit 1
}
"publish-bundles: $($records.Count) bundle(s) $(if ($DryRun) { 'prepared (dry-run)' } else { 'published to ' + $Bucket + '/bootstrap/' })"
