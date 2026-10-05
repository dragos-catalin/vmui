<#
.SYNOPSIS
  Deploy vmui to homepi: build HERE (55 s on the PC vs 4 min on the Pi), stream
  source + .next over ssh, `pnpm install` on the Pi only when the lockfile
  changed (native better-sqlite3 must be built for arm64), restart systemd.
.EXAMPLE
  pwsh -File scripts\pi-deploy.ps1            # build + sync + restart
  pwsh -File scripts\pi-deploy.ps1 -SkipBuild # reuse the existing .next
#>
param(
  [string] $Pi = 'homepi',
  [string] $Dest = '/srv/homepi/vmui',
  [switch] $SyncOnly,
  [switch] $SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
# deploy-clean runs this from a detached worktree: gitignored runtime files (.private, fonts)
# exist only in the main clone, and its --ignore-scripts install skips the sqlite binding.
$common = (git rev-parse --path-format=absolute --git-common-dir).Replace('/', '\')
$priv = Split-Path $common -Parent

if (-not $SkipBuild -and -not $SyncOnly) {
  if ($priv -ne $root -and -not (Get-ChildItem node_modules\.pnpm -Directory -Filter 'better-sqlite3@*' | Where-Object { Test-Path (Join-Path $_.FullName 'node_modules\better-sqlite3\build\Release\better_sqlite3.node') })) {
    pnpm rebuild better-sqlite3
    if ($LASTEXITCODE -ne 0) { throw "pnpm rebuild better-sqlite3 failed ($LASTEXITCODE)" }
  }
  & pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'pnpm build' -Wait
  if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
}
if (-not (Test-Path '.next\BUILD_ID')) { throw '.next/BUILD_ID missing — run without -SkipBuild' }

# Windows tar + ssh: stream tracked + untracked-but-not-ignored files, then .next.
$list = Join-Path $root '.copilot-tmp\pi\files.txt'
New-Item -ItemType Directory -Force (Split-Path $list) | Out-Null
git ls-files -co --exclude-standard -- . ':!cli' ':!vfio' ':!toolkit' ':!tests' ':!test' ':!*.png' ':!*.jpg' | Set-Content $list -Encoding utf8
$n = (Get-Content $list).Count
Write-Host "syncing $n source files + .next -> ${Pi}:$Dest"
ssh -o BatchMode=yes $Pi "mkdir -p $Dest/.private"
tar -cf - -T $list | ssh -o BatchMode=yes $Pi "tar -xf - -C $Dest"
ssh -o BatchMode=yes $Pi "rm -rf $Dest/.next.new; mkdir -p $Dest/.next.new"
# .next/node_modules holds junctions into the Windows pnpm store (serverExternalPackages);
# tar would follow them and ship half a dependency tree. Recreate them on the Pi.
tar -cf - --exclude=.next/cache --exclude=.next/node_modules .next | ssh -o BatchMode=yes $Pi "tar -xf - -C $Dest/.next.new"
$links = Get-ChildItem .next\node_modules -Recurse -Force | Where-Object { $_.LinkType -eq 'Junction' } | ForEach-Object {
  $rel = $_.FullName.Substring((Join-Path $root '.next\node_modules').Length + 1) -replace '\\', '/'
  $pkg = ($rel -replace '-[0-9a-f]{16}$', '')
  "$rel $pkg"
}
$linkFile = Join-Path $root '.copilot-tmp\pi\next-links.txt'
[IO.File]::WriteAllText($linkFile, (($links -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
scp -q -o BatchMode=yes $linkFile "${Pi}:$Dest/.next.new/.next/next-links.txt"
# runtime-only files that git ignores
foreach ($f in '.env', '.private/credentials.env', '.private/fcm-service-account.json') {
  $p = if (Test-Path $f) { $f } else { Join-Path $priv $f }
  if (Test-Path $p) { scp -q -o BatchMode=yes $p "${Pi}:$Dest/$f" }
}
if (Test-Path (Join-Path $priv 'turzx\fonts')) { tar -cf - -C $priv turzx/fonts | ssh -o BatchMode=yes $Pi "tar -xf - -C $Dest" }
# Home Assistant packages (rest_command/scripts that call vmui on the Pi)
if (Test-Path 'pi\ha-packages') { tar -cf - -C pi ha-packages | ssh -o BatchMode=yes $Pi "tar -xf - -C /tmp && sudo cp /tmp/ha-packages/*.yaml /srv/homepi/ha/packages/ && rm -rf /tmp/ha-packages" }
# /api/desktop/pi restarts units with sudo -n; visudo -c refuses a broken file instead of locking us out
if (Test-Path 'pi\sudoers-vmui') { ((Get-Content -Raw 'pi\sudoers-vmui') -replace "`r`n", "`n") | ssh -o BatchMode=yes $Pi 'cat > /tmp/sudoers-vmui && sudo visudo -cf /tmp/sudoers-vmui >/dev/null && sudo install -m 440 -o root -g root /tmp/sudoers-vmui /etc/sudoers.d/vmui; rm -f /tmp/sudoers-vmui' }
# mDNS advert (_vmui._tcp) so the apps autodiscover the Pi on the LAN
if (Test-Path 'pi\avahi-vmui.service') { ((Get-Content -Raw 'pi\avahi-vmui.service') -replace "`r`n", "`n") | ssh -o BatchMode=yes $Pi 'cat > /tmp/avahi-vmui.service && sudo install -m 644 /tmp/avahi-vmui.service /etc/avahi/services/vmui.service; rm -f /tmp/avahi-vmui.service' }
# custom-component fixes that a HAOS restore would undo (see docs: HyperHDR async_timeout)
if (Test-Path 'pi\ha-patches') { tar -cf - -C pi ha-patches | ssh -o BatchMode=yes $Pi 'tar -xf - -C /tmp; D=/srv/homepi/ha/custom_components/hyperhdr_integration; if [ -d "$D" ]; then sudo cp /tmp/ha-patches/hyperhdr_integration-coordinator.py "$D/coordinator.py"; sudo cp /tmp/ha-patches/hyperhdr_integration-config_flow.py "$D/config_flow.py"; fi; rm -rf /tmp/ha-patches' }
$espTok = ((Get-Content (Join-Path $priv '.private\credentials.env') | Where-Object { $_ -match '^ESP_DISPLAY_TOKEN=' }) -replace '^ESP_DISPLAY_TOKEN=', '').Trim('"')
if ($espTok) {
  # keep the shared token in HA secrets.yaml (never in an entity state or the package file)
  "http://127.0.0.1:3737/api/pc/wake?k=$espTok&by=ha" | ssh -o BatchMode=yes $Pi 'read -r U; F=/srv/homepi/ha/secrets.yaml; sudo touch $F; sudo sed -i "/^vmui_pc_wake_url:/d" $F; echo "vmui_pc_wake_url: \"$U\"" | sudo tee -a $F >/dev/null'
}
if ($SyncOnly) { return }

$lock = (Get-FileHash pnpm-lock.yaml -Algorithm SHA256).Hash
$remote = @"
set -e; cd $Dest
if [ "`$(cat .lock.sha 2>/dev/null)" != "$lock" ]; then pnpm install --frozen-lockfile 2>&1 | tail -2; echo $lock > .lock.sha; fi
rm -rf .next.prev; [ -d .next ] && mv .next .next.prev; mv .next.new/.next .next; rmdir .next.new
mkdir -p .next/node_modules
while read -r rel pkg; do [ -n "`$rel" ] || continue; mkdir -p ".next/node_modules/`$(dirname "`$rel")"; ln -sfn "`$(realpath "node_modules/`$pkg")" ".next/node_modules/`$rel"; done < .next/next-links.txt
for u in vmui turzx desk-button hub-cast; do sudo install -m 644 pi/`$u.service /etc/systemd/system/`$u.service; done
sudo systemctl daemon-reload; sudo systemctl enable vmui turzx desk-button hub-cast >/dev/null 2>&1
sudo systemctl restart vmui; sleep 4; sudo systemctl restart turzx desk-button hub-cast
for u in vmui turzx desk-button hub-cast; do printf '%s %s\n' `$u "`$(systemctl is-active `$u)"; done
curl -s -o /dev/null -w 'http %{http_code}\n' http://127.0.0.1:3737/ || true
"@ -replace "`r`n", "`n"
ssh -o BatchMode=yes $Pi $remote

