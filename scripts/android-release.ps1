<#
.SYNOPSIS
  Build the signed Android APK of apps/desktop and publish it on the Pi so the
  app can self-update (GET /api/desktop/apk?meta=1 → versionCode compare).
.EXAMPLE
  pwsh -File scripts\android-release.ps1              # build + publish
  pwsh -File scripts\android-release.ps1 -Install     # ...and adb install on the connected phone
  pwsh -File scripts\android-release.ps1 -SkipBuild   # publish the last build
  pwsh -File scripts\android-release.ps1 -NoPublish   # build + verify only
#>
param(
  [string] $Pi = 'homepi',
  [string] $Dest = '/srv/homepi/vmui',
  [switch] $SkipBuild,
  [switch] $Install,
  [switch] $NoPublish,
  [string] $Serial = $env:ANDROID_SERIAL
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location "$root\apps\desktop"

function Get-JdkMajor([string] $JdkHome) {
  $rel = Join-Path $JdkHome 'release'
  if (-not (Test-Path $rel)) { return 0 }
  $line = Get-Content $rel | Where-Object { $_ -match '^JAVA_VERSION=' } | Select-Object -First 1
  if ($line -match '"(\d+)') { return [int]$Matches[1] }
  return 0
}
function Resolve-Jdk21 {
  $candidates = @($env:VMUI_JAVA_HOME, $env:JAVA_HOME)
  foreach ($key in 'HKLM:\SOFTWARE\Microsoft\JDK', 'HKLM:\SOFTWARE\Eclipse Adoptium\JDK') {
    Get-ChildItem $key -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like '21*' } | ForEach-Object {
      $candidates += @(Get-ChildItem $_.PSPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.GetValue('Path') })
    }
  }
  foreach ($c in $candidates) {
    if ($c -and (Get-JdkMajor $c.TrimEnd('\')) -eq 21) { return $c.TrimEnd('\') }
  }
  throw 'JDK 21 not found: install Microsoft OpenJDK 21 (winget install Microsoft.OpenJDK.21) or set VMUI_JAVA_HOME'
}
if (-not $SkipBuild) {
  $env:JAVA_HOME = Resolve-Jdk21
  "JAVA_HOME=$env:JAVA_HOME"
  pnpm exec tauri android build --apk --target aarch64 2>&1 | Where-Object { $_ -match 'error|\.apk$|What went wrong' }
  if ($LASTEXITCODE -ne 0) { throw "android build failed ($LASTEXITCODE)" }
}
$apk = "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
if (-not (Test-Path $apk)) { throw "apk missing: $apk" }
$props = Get-Content 'src-tauri\gen\android\app\tauri.properties'
$versionName = ($props | Where-Object { $_ -match 'versionName=' }) -replace '.*=', ''
$versionCode = [int](($props | Where-Object { $_ -match 'versionCode=' }) -replace '.*=', '')
$sha = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $apk).Length
$meta = @{ version = $versionName; versionCode = $versionCode; sha256 = $sha; size = $size; builtAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
$metaFile = "$root\.copilot-tmp\pi\vmui.apk.json"
New-Item -ItemType Directory -Force (Split-Path $metaFile) | Out-Null
[IO.File]::WriteAllText($metaFile, $meta, [Text.UTF8Encoding]::new($false))
"apk $versionName ($versionCode) $([Math]::Round($size/1MB,1)) MB sha256 $($sha.Substring(0,12))"

if ($NoPublish) { return }

ssh -o BatchMode=yes $Pi "mkdir -p $Dest/public-apk"
scp -q -o BatchMode=yes $apk "${Pi}:$Dest/public-apk/vmui.apk"
scp -q -o BatchMode=yes $metaFile "${Pi}:$Dest/public-apk/vmui.apk.json"
$tok = ((Get-Content "$root\.private\credentials.env" | Where-Object { $_ -match '^ESP_DISPLAY_TOKEN=' }) -replace '^ESP_DISPLAY_TOKEN=', '').Trim('"')
$live = curl.exe -s "http://192.168.100.232:3737/api/desktop/apk?meta=1&k=$tok"
"published: $live"

if ($Install) {
  $s = if ($Serial) { @('-s', $Serial) } else { @() }
  adb @s install -r $apk | Select-Object -Last 1
}
