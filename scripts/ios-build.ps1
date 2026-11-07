<#
.SYNOPSIS
  Test / build the Vatra iPhone + watch app (apps/ios) on the devcloud macOS VM vmui-mac.

.DESCRIPTION
  Ships the COMMITTED apps/ios tree plus docs/api/fixtures at -Ref (git archive; -WorkingTree ships the
  current files instead, for iterating before a commit) to the guest over Tailscale SSH and runs
  apps/ios/scripts/build.sh there. Holds one SSH session open for the whole run so the host idle timer
  does not suspend the VM mid-build (devcloud-mac.md). The VM itself has a server-side max-run-duration.

.EXAMPLE
  pwsh -NoProfile -File scripts/ios-build.ps1 -Mode test
  pwsh -NoProfile -File scripts/ios-build.ps1 -Mode build -Ref origin/main
#>
[CmdletBinding()]
param(
  [ValidateSet('test', 'build', 'all')] [string]$Mode = 'all',
  [string]$Ref = 'HEAD',
  [switch]$WorkingTree,
  [string]$GuestHost = '100.106.244.19',
  [int]$GuestPort = 10022,
  [string]$GuestUser = 'dragos',
  [string]$Key = (Join-Path $HOME '.ssh\id_ed25519_macvm')
)
$ErrorActionPreference = 'Stop'
$repo = (git rev-parse --show-toplevel).Trim()
$tag = if ($WorkingTree) { 'wt-' + (Get-Date -Format 'yyyyMMddHHmmss') } else { (git -C $repo rev-parse --short=12 "$Ref^{commit}").Trim() }
$tmp = Join-Path $repo ".copilot-tmp\ios-build\$tag"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', '-i', $Key, '-p', "$GuestPort")
$target = "$GuestUser" + [char]64 + "$GuestHost"

$st = (gcloud compute instances describe vmui-mac --zone europe-central2-a --project dragos-devcloud --format='value(status)' 2>$null)
if ($st -eq 'SUSPENDED') { gcloud compute instances resume vmui-mac --zone europe-central2-a --project dragos-devcloud --quiet *> $null }
elseif ($st -ne 'RUNNING') { & pwsh -NoProfile -File (Join-Path $repo 'infra\devcloud\mac\mac-gce.ps1') -Start }
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  & ssh @ssh $target 'true' 2>$null
  $ok = $LASTEXITCODE -eq 0
  if (-not $ok) { Start-Sleep -Seconds 10 }
}
if (-not $ok) { throw "guest ssh not reachable at ${GuestHost}:$GuestPort" }
$hold = Start-Process ssh -ArgumentList ($ssh + @($target, 'sleep 7200')) -WindowStyle Hidden -PassThru

try {
  $tar = Join-Path $tmp 'src.tar'
  if ($WorkingTree) {
    & tar -cf $tar -C $repo --exclude 'apps/ios/build' --exclude '*.xcodeproj' apps/ios docs/api/fixtures
  } else {
    git -C $repo archive --format=tar -o $tar $tag apps/ios docs/api/fixtures
  }
  if ($LASTEXITCODE -ne 0) { throw 'archive failed' }
  $remote = "vatra-ios/$tag"
  # guest login shell is zsh (a glob with no match is an error): clean with find
  & ssh @ssh $target "mkdir -p ~/vatra-ios && find ~/vatra-ios -mindepth 1 -maxdepth 1 -name 'wt-*' -exec rm -rf {} + ; rm -rf ~/$remote && mkdir -p ~/$remote"
  if ($LASTEXITCODE -ne 0) { throw 'guest prepare failed' }
  & scp -q -o BatchMode=yes -i $Key -P $GuestPort $tar "${target}:$remote/src.tar"
  if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
  & ssh @ssh $target "cd ~/$remote && tar -xf src.tar && rm src.tar && chmod +x apps/ios/scripts/*.sh"
  $log = Join-Path $tmp "$Mode.log"
  $build = if ($WorkingTree) { '1' } else { (git -C $repo rev-list --count $tag).Trim() }
  & ssh @ssh $target "cd ~/$remote/apps/ios && BUILD_NUMBER=$build ./scripts/build.sh $Mode" *>&1 | Tee-Object -FilePath $log
  $rc = $LASTEXITCODE
} finally {
  if ($hold -and -not $hold.HasExited) { Stop-Process -Id $hold.Id -Force -ErrorAction SilentlyContinue }
}
Write-Host "ios-build $Mode @ $tag -> rc=$rc (log $log)"
exit $rc
