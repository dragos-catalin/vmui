# devcloud DC-051: provision the Windows CI runner image (family devcloud-ci-win-desktop) on a throwaway bake VM
# booted from windows-cloud/windows-2025 (Server 2025 Datacenter). Metadata key windows-startup-script-ps1: the
# GCE agent runs this as SYSTEM under Windows PowerShell 5.1 and copies stdout to serial port 1, where bake.mjs
# reads `::step <name>`, then `::image-setup done` (or `::image-setup failed <step>`). After `done` the script
# runs GCESysprep, which generalises the disk and powers the VM off; bake.mjs images the disk.
#   git, node 24 (+ runner tool cache), pnpm 12 (native win32 binary, not the npm shim), pwsh 7,
#   rustup + Rust (metadata rust-toolchain, default 1.98.1) msvc with rustfmt + clippy,
#   VS 2022 Build Tools (VCTools workload + Windows 11 SDK), CMake + NASM (build scripts: opusic-sys bundled libopus,
#   aws-lc-sys), WebView2 runtime, Google Chrome, gh, ripgrep, 7-Zip,
#   actions runner win-x64 pre-extracted in C:\actions-runner, git core.autocrlf=false + core.longpaths=true,
#   Win32 long paths, Defender exclusions for the runner + work dir + cargo/rustup/pnpm caches.  # Metadata `android-sdk` (bake --android <api>): JDK 21 + Android cmdline-tools/platform/build-tools + accepted
  # licences, so a Flutter app builds its APK here (DC-071 caelia) instead of on the workstation.# NSIS/WiX/mise are not baked: the codai desktop job builds `tauri build --debug --no-bundle`, and the Tauri
# bundler downloads its own NSIS/WiX into its cache when a job does bundle.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$T0 = Get-Date
$script:STEP = 'init'
function Say([string]$m) { Write-Output $m }
function Step([string]$n) { $script:STEP = $n; Say "::step $n +$([int]((Get-Date) - $T0).TotalSeconds)s" }
function MetaAttr([string]$k, [string]$d = '') {
  try { (Invoke-RestMethod -Headers @{ 'Metadata-Flavor' = 'Google' } -Uri "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$k" -TimeoutSec 10).ToString() } catch { $d }
}
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function AddPath([string]$dir) {
  $p = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($p -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', "$p;$dir", 'Machine') }
  RefreshPath
}
function Get-File([string]$url, [string]$out) {
  for ($i = 1; $i -le 4; $i++) {
    & curl.exe -fsSL --retry 3 -o $out $url
    if ($LASTEXITCODE -eq 0 -and (Test-Path $out) -and (Get-Item $out).Length -gt 0) { return }
    Start-Sleep -Seconds (5 * $i)
  }
  throw "download failed: $url"
}
function Latest([string]$repo, [string]$pattern) {
  $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'devcloud-bake' } -TimeoutSec 30
  $a = $r.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $a) { throw "no asset /$pattern/ in $repo $($r.tag_name)" }
  $a.browser_download_url
}
function LatestOrNull([string]$repo, [string]$pattern) {
  try { Latest $repo $pattern } catch { '' }
}
function Run([string]$exe, [string[]]$argv, [int[]]$ok = @(0)) {
  $p = Start-Process -FilePath $exe -ArgumentList @($argv | Where-Object { $_ }) -Wait -PassThru -NoNewWindow
  if ($ok -notcontains $p.ExitCode) { throw "$exe exit $($p.ExitCode)" }
}
function Msi([string]$path, [string]$extra = '') {
  Run 'msiexec.exe' @('/i', "`"$path`"", '/qn', '/norestart', $extra) @(0, 3010)
}

$RUNNER_VER = MetaAttr 'runner-version' '2.338.0'
$PNPM_VER = MetaAttr 'pnpm-version' '12.9.1'
$RUST_VER = MetaAttr 'rust-toolchain' '1.98.1'
$TC = MetaAttr 'toolchain' 'win-desktop'
$FLUTTER_VER = MetaAttr 'flutter-version' ''
# API level (e.g. 35) that bake --android requested, or '' when the image carries no Android toolchain.
$ANDROID_API = MetaAttr 'android-sdk' ''
$TMP = 'C:\devcloud\tmp'
New-Item -ItemType Directory -Force $TMP, 'C:\tools\bin' | Out-Null
Say "::image-setup start toolchain=$TC $(Get-Date -Format o)"
try {
  Step 'system'
  New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force | Out-Null
  # Defender: exclusions instead of disabling (a job still gets scanned downloads, not every compiled file).
  try {
    Add-MpPreference -ExclusionPath 'C:\actions-runner', 'C:\actions-runner\_work', 'C:\cargo', 'C:\rustup', 'C:\pnpm-store', $TMP
    Add-MpPreference -ExclusionProcess 'cargo.exe', 'rustc.exe', 'link.exe', 'cl.exe', 'node.exe', 'pnpm.exe'
    Say "::defender exclusions set"
  } catch { Say "::warn defender: $($_.Exception.Message)" }
  AddPath 'C:\tools\bin'

  Step 'git'
  $u = Latest 'git-for-windows/git' '^Git-[0-9.]+-64-bit\.exe$'
  Get-File $u "$TMP\git.exe"
  Run "$TMP\git.exe" @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/COMPONENTS=gitlfs', '/o:PathOption=Cmd', '/o:CRLFOption=CRLFCommitAsIs')
  RefreshPath
  & git config --system core.autocrlf false
  & git config --system core.longpaths true
  & git --version

  Step 'node'
  $sums = (& curl.exe -fsSL 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') -join "`n"
  if ($sums -notmatch '(node-v(24\.[0-9]+\.[0-9]+)-x64\.msi)') { throw 'node 24 msi not found' }
  $nodeMsi = $Matches[1]; $NODE_VER = $Matches[2]
  Get-File "https://nodejs.org/dist/latest-v24.x/$nodeMsi" "$TMP\node.msi"
  Msi "$TMP\node.msi"
  RefreshPath
  & node -v
  # actions/setup-node looks in RUNNER_TOOL_CACHE (<runner>\_work\_tool) first: seed it so it is a no-op.
  $tool = "C:\actions-runner\_work\_tool\node\$NODE_VER\x64"
  New-Item -ItemType Directory -Force $tool | Out-Null
  Copy-Item 'C:\Program Files\nodejs\*' $tool -Recurse -Force
  New-Item -ItemType File -Force "C:\actions-runner\_work\_tool\node\$NODE_VER\x64.complete" | Out-Null

  # pnpm 12 = native binary (Rust rewrite): the release zip, not the npm shim.
  Step 'pnpm'
  Get-File "https://github.com/pnpm/pnpm/releases/download/v$PNPM_VER/pnpm-win32-x64.zip" "$TMP\pnpm.zip"
  Expand-Archive "$TMP\pnpm.zip" -DestinationPath 'C:\pnpm' -Force
  $pn = Get-ChildItem 'C:\pnpm' -Recurse -Filter 'pnpm.exe' | Select-Object -First 1
  if (-not $pn) { throw "pnpm.exe not in zip: $((Get-ChildItem C:\pnpm -Recurse).Name -join ',')" }
  AddPath $pn.DirectoryName
  [Environment]::SetEnvironmentVariable('PNPM_HOME', $pn.DirectoryName, 'Machine')
  & pnpm --version
  if ($LASTEXITCODE) { throw 'pnpm --version failed' }

  Step 'pwsh'
  # 7.7.0 dropped the -win-x64.msi asset (only the zip is published), which broke every Windows
  # bake with "no asset /^PowerShell-7\.[0-9.]+-win-x64\.msi$/". Prefer the MSI when it exists,
  # otherwise unzip into the same directory the MSI installs to and put it on PATH by hand.
  $pwshMsi = LatestOrNull 'PowerShell/PowerShell' '^PowerShell-7\.[0-9.]+-win-x64\.msi$'
  if ($pwshMsi) {
    Get-File $pwshMsi "$TMP\pwsh.msi"
    Msi "$TMP\pwsh.msi" 'ADD_PATH=1 ENABLE_PSREMOTING=0 REGISTER_MANIFEST=1 USE_MU=0 ENABLE_MU=0'
  } else {
    Get-File (Latest 'PowerShell/PowerShell' '^PowerShell-7\.[0-9.]+-win-x64\.zip$') "$TMP\pwsh.zip"
    Expand-Archive "$TMP\pwsh.zip" -DestinationPath 'C:\Program Files\PowerShell\7' -Force
    AddPath 'C:\Program Files\PowerShell\7'
  }
  RefreshPath
  & pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'

  Step 'gh'
  Get-File (Latest 'cli/cli' '^gh_[0-9.]+_windows_amd64\.msi$') "$TMP\gh.msi"
  Msi "$TMP\gh.msi"
  RefreshPath

  Step 'ripgrep'
  Get-File (Latest 'BurntSushi/ripgrep' '^ripgrep-[0-9.]+-x86_64-pc-windows-msvc\.zip$') "$TMP\rg.zip"
  Expand-Archive "$TMP\rg.zip" -DestinationPath "$TMP\rg" -Force
  Copy-Item (Get-ChildItem "$TMP\rg" -Recurse -Filter rg.exe | Select-Object -First 1).FullName 'C:\tools\bin\rg.exe' -Force

  Step '7zip'
  Get-File (Latest 'ip7z/7zip' '^7z[0-9]+-x64\.msi$') "$TMP\7z.msi"
  Msi "$TMP\7z.msi"
  AddPath 'C:\Program Files\7-Zip'

  # codai desktop: opusic-sys builds bundled libopus with cmake ("failed to execute command: program not found",
  # codai run 38927840211); aws-lc-sys (reqwest rustls) uses cmake/NASM when its prebuilt objects do not apply.
  Step 'cmake'
  Get-File (Latest 'Kitware/CMake' '^cmake-[0-9.]+-windows-x86_64\.msi$') "$TMP\cmake.msi"
  Msi "$TMP\cmake.msi" 'ADD_CMAKE_TO_PATH=System'
  RefreshPath
  & cmake --version

  Step 'nasm'
  Get-File 'https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/win64/nasm-2.16.03-win64.zip' "$TMP\nasm.zip"
  Expand-Archive "$TMP\nasm.zip" -DestinationPath "$TMP\nasm" -Force
  Copy-Item (Get-ChildItem "$TMP\nasm" -Recurse -Filter nasm.exe | Select-Object -First 1).FullName 'C:\tools\bin\nasm.exe' -Force
  & nasm -v

  Step 'chrome'
  Get-File 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' "$TMP\chrome.msi"
  Msi "$TMP\chrome.msi"

  Step 'webview2'
  Get-File 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' "$TMP\wv2.exe"
  Run "$TMP\wv2.exe" @('/silent', '/install') @(0, -2147219416)

  # Flutter is present only on toolchains that declare it (metadata flutter-version, e.g. win-flutter): the
  # pinned stable ZIP extracts to C:\flutter (the archive's top-level folder), and precache pulls the Windows
  # desktop engine so a job's `flutter build windows` works offline-ish. win-desktop has no key -> skipped.
  if ($FLUTTER_VER) {
    Step 'flutter'
    Get-File "https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_$FLUTTER_VER-stable.zip" "$TMP\flutter.zip"
    Expand-Archive "$TMP\flutter.zip" -DestinationPath 'C:\' -Force
    if (-not (Test-Path 'C:\flutter\bin\flutter.bat')) { throw "flutter.bat missing after extract of $FLUTTER_VER" }
    AddPath 'C:\flutter\bin'
    [Environment]::SetEnvironmentVariable('FLUTTER_ROOT', 'C:\flutter', 'Machine')
    # The runner service runs as LocalSystem and every CI job as user `dev`: without this, git refuses to read
    # C:\flutter ("detected dubious ownership") and Flutter's own engine version probe dies with
    # "Unable to determine engine version", so no job on the image can build anything.
    $gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($gitExe) { & $gitExe config --system --add safe.directory C:/flutter }
    & flutter config --no-analytics
    if ($LASTEXITCODE) { throw 'flutter config failed' }
    & flutter --version
    if ($LASTEXITCODE) { throw 'flutter --version failed' }
    & flutter precache --windows
    if ($LASTEXITCODE) { throw 'flutter precache --windows failed' }
    Remove-Item "$TMP\flutter.zip" -Force
  }

  # JDK 21 + the Android SDK, only when bake --android named an API level. A Flutter app's release APK is built
  # on this image (DC-071 caelia), so JAVA_HOME/ANDROID_HOME must be machine-wide and the SDK licences accepted
  # non-interactively: gradle fails on an unaccepted licence long before it fails on anything interesting.
  if ($ANDROID_API) {
    Step 'android'
    $sdkRoot = 'C:\Android\sdk'
    New-Item -ItemType Directory -Force $sdkRoot | Out-Null
    # JDK 21 from the Adoptium API as a ZIP: the `aka.ms` Microsoft MSI redirect resolved to a file msiexec
    # refused (exit 1619, "installation package could not be opened") on the first attempt, and a ZIP needs no
    # installer at all. The URL was verified to return a real archive (200, magic 'PK', 196 MB) before this.
    Get-File 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' "$TMP\jdk21.zip"
    if (-not (Test-Path 'C:\Java')) { New-Item -ItemType Directory -Force 'C:\Java' | Out-Null }
    Expand-Archive "$TMP\jdk21.zip" -DestinationPath 'C:\Java' -Force
    $jh = (Get-ChildItem 'C:\Java' -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } | Select-Object -First 1).FullName
    if ($jh) { [Environment]::SetEnvironmentVariable('JAVA_HOME', $jh, 'Machine') }
    if (-not $jh -or -not (Test-Path (Join-Path $jh 'bin\java.exe'))) { throw "JDK 21 not found after install (JAVA_HOME='$jh')" }
    AddPath (Join-Path $jh 'bin')
    Get-File 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' "$TMP\cmdtools.zip"
    Expand-Archive "$TMP\cmdtools.zip" -DestinationPath "$sdkRoot\cmdline-tools" -Force
    if (Test-Path "$sdkRoot\cmdline-tools\latest") { Remove-Item "$sdkRoot\cmdline-tools\latest" -Recurse -Force }
    Move-Item "$sdkRoot\cmdline-tools\cmdline-tools" "$sdkRoot\cmdline-tools\latest"
    $sm = "$sdkRoot\cmdline-tools\latest\bin\sdkmanager.bat"
    if (-not (Test-Path $sm)) { throw "sdkmanager missing at $sm" }
    [Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdkRoot, 'Machine')
    [Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdkRoot, 'Machine')
    $env:ANDROID_HOME = $sdkRoot; $env:ANDROID_SDK_ROOT = $sdkRoot
    # $ANDROID_API may name several levels ("35 36"): Flutter 3.47 defaults compileSdk/targetSdk to 36,
    # and a plugin pinned to an older platform fails the build unless that platform is present too.
    # sdkmanager is a .bat, so it MUST go through the call operator: Start-Process on a .bat reports success
    # without installing anything (bake #2 shipped an image whose C:\Android\sdk held only cmdline-tools while
    # the log still said "::android ready", and the first job on it answered "Unable to locate Android SDK").
    $pkgs = @('platform-tools')
    foreach ($api in ($ANDROID_API -split '\s+')) { $pkgs += @("platforms;android-$api", "build-tools;$api.0.0") }
    # Gradle pulls these itself on a fresh VM even though the project asks for 35/36: the Android Gradle
    # plugin resolves its own compileSdk and the externalNativeBuild/cmake variant from the SDK, so the
    # first `flutter build apk` on a cold runner spent minutes downloading them (observed 2026-11-25:
    # "Android SDK Platform 34" + "CMake 3.22.1" installed by Gradle during a debug build). Baking them
    # removes that from EVERY job instead of only the first one on a warm VM.
    $gradleExtras = @('platforms;android-34', 'build-tools;34.0.0', 'cmake;3.22.1')
    $pkgs += $gradleExtras
    $licOut = 1..40 | ForEach-Object { 'y' } | & $sm "--sdk_root=$sdkRoot" --licenses 2>&1
    if ($LASTEXITCODE) { throw "sdkmanager --licenses exit $LASTEXITCODE`n$($licOut | Select-Object -Last 5 | Out-String)" }
    # sdkmanager asks 'Accept? (y/N)' once per licence; feed a wall of y (harmless when nothing is left to accept).
    $smOut = 1..40 | ForEach-Object { 'y' } | & $sm "--sdk_root=$sdkRoot" @pkgs 2>&1
    if ($LASTEXITCODE) { throw "sdkmanager exit $LASTEXITCODE for $($pkgs -join ', ')`n$($smOut | Select-Object -Last 6 | Out-String)" }
    # Assert the artifacts instead of trusting the exit code: the whole point of this block is a toolchain the
    # worker can actually build with, and only the files on disk decide that.
    $need = @('platform-tools\adb.exe', 'cmdline-tools\latest\bin\sdkmanager.bat')
    foreach ($api in ($ANDROID_API -split '\s+')) { $need += @("platforms\android-$api\android.jar", "build-tools\$api.0.0\aapt2.exe") }
    $need += @('platforms\android-34\android.jar', 'build-tools\34.0.0\aapt2.exe', 'cmake\3.22.1\bin\cmake.exe')
    foreach ($rel in $need) { if (-not (Test-Path (Join-Path $sdkRoot $rel))) { throw "android: missing $rel under $sdkRoot" } }
    AddPath "$sdkRoot\cmdline-tools\latest\bin"
    AddPath "$sdkRoot\platform-tools"
    if ($FLUTTER_VER) {
      & flutter config --android-sdk $sdkRoot
      & flutter precache --android
    }
    Remove-Item "$TMP\cmdtools.zip" -Force
    Say "::android ready api=$ANDROID_API javaHome=$jh adb=$sdkRoot\platform-tools\adb.exe"
  }

  # VS 2022 Build Tools: MSVC x64 + Windows 11 SDK (what cargo's msvc target and Tauri need). 3010 = reboot wanted,
  # not required before sysprep.
  Step 'vsbuildtools'
  Get-File 'https://aka.ms/vs/17/release/vs_buildtools.exe' "$TMP\vs_buildtools.exe"
  Run "$TMP\vs_buildtools.exe" @('--quiet', '--wait', '--norestart', '--nocache',
    '--add', 'Microsoft.VisualStudio.Workload.VCTools', '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.26100', '--includeRecommended') @(0, 3010)

  Step 'rust'
  [Environment]::SetEnvironmentVariable('CARGO_HOME', 'C:\cargo', 'Machine')
  [Environment]::SetEnvironmentVariable('RUSTUP_HOME', 'C:\rustup', 'Machine')
  $env:CARGO_HOME = 'C:\cargo'; $env:RUSTUP_HOME = 'C:\rustup'
  Get-File 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' "$TMP\rustup-init.exe"
  Run "$TMP\rustup-init.exe" @('-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', "$RUST_VER-x86_64-pc-windows-msvc", '-c', 'rustfmt', '-c', 'clippy')
  AddPath 'C:\cargo\bin'
  & icacls 'C:\cargo' /grant 'BUILTIN\Users:(OI)(CI)M' /T /Q | Out-Null
  & icacls 'C:\rustup' /grant 'BUILTIN\Users:(OI)(CI)M' /T /Q | Out-Null
  & rustc -V

  Step 'runner'
  $R = 'C:\actions-runner'
  Get-File "https://github.com/actions/runner/releases/download/v$RUNNER_VER/actions-runner-win-x64-$RUNNER_VER.zip" "$TMP\runner.zip"
  Expand-Archive "$TMP\runner.zip" -DestinationPath $R -Force
  Set-Content -Path "$R\.env" -Value "DEVCLOUD_RUNNER=1" -Encoding ascii
  & icacls $R /grant 'BUILTIN\Users:(OI)(CI)M' /T /Q | Out-Null

  Step 'verify'
  RefreshPath
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vs = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { throw 'MSVC not found by vswhere' }
  $cl = Get-ChildItem "$vs\VC\Tools\MSVC" -Recurse -Filter cl.exe | Where-Object { $_.FullName -match 'Hostx64\\x64' } | Select-Object -First 1
  if (-not $cl) { throw 'cl.exe (Hostx64\x64) missing' }
  $sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Lib" -Directory -ErrorAction SilentlyContinue | Select-Object -Last 1
  if (-not $sdk) { throw 'Windows 10/11 SDK Lib missing' }
  $wv2 = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv
  if (-not $wv2) { throw 'WebView2 runtime not registered' }
  $chrome = (Get-Item 'C:\Program Files\Google\Chrome\Application\chrome.exe').VersionInfo.ProductVersion
  $v = [ordered]@{
    git = (& git --version); node = (& node -v); pnpm = (& pnpm --version); pwsh = (& pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')
    rustc = (& rustc -V); cargo = (& cargo -V); rustfmt = (& cargo fmt --version); clippy = (& cargo clippy --version)
    cmake = ((& cmake --version) | Select-Object -First 1); nasm = (& nasm -v)
    gh = ((& gh --version) | Select-Object -First 1); rg = ((& rg --version) | Select-Object -First 1); sevenzip = ((& 7z i) | Select-Object -Skip 1 -First 1)
    cl = $cl.FullName; sdk = $sdk.Name; webview2 = $wv2; chrome = $chrome
  }
  if ($FLUTTER_VER) { $v['flutter'] = ((& flutter --version) | Select-Object -First 1) }
  if ($ANDROID_API) { $v['androidApi'] = $ANDROID_API; $v['javaHome'] = $jh }
  foreach ($k in $v.Keys) { Say "::ver $k=$($v[$k])"; if (-not $v[$k]) { throw "no version for $k" } }

  Step 'cleanup'
  Remove-Item $TMP -Recurse -Force -ErrorAction SilentlyContinue
  & cmd /c 'del /q /s %TEMP%\* >nul 2>&1'
  $img = [ordered]@{ toolchain = $TC; os = 'windows-server-2025'; node = $v.node; pnpm = $PNPM_VER; rust = $RUST_VER; runner = $RUNNER_VER; msvc = $cl.Directory.Parent.Parent.Parent.Name; sdk = $sdk.Name; bakedAt = (Get-Date -Format o) }
  if ($FLUTTER_VER) { $img['flutter'] = $FLUTTER_VER }
  if ($ANDROID_API) { $img['android'] = $ANDROID_API }
  New-Item -ItemType Directory -Force 'C:\devcloud' | Out-Null
  Set-Content -Path 'C:\devcloud\image.json' -Value ($img | ConvertTo-Json -Compress) -Encoding ascii
  New-Item -ItemType File -Force 'C:\devcloud\baked' | Out-Null
  Say "::image-setup done toolchain=$TC in $([int]((Get-Date) - $T0).TotalSeconds)s"
} catch {
  Say "::image-setup failed $script:STEP $($_.Exception.Message)"
  & shutdown.exe /s /t 5 /f
  exit 1
}
# Generalise + power off (bake.mjs waits for TERMINATED, then images the disk).
$gs = 'C:\Program Files\Google\Compute Engine\sysprep\gcesysprep.bat'
if (Test-Path $gs) { & cmd /c "`"$gs`"" } else { & GCESysprep }
Say "::sysprep returned $LASTEXITCODE"
