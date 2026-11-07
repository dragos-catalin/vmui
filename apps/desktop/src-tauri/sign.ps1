# Signs one file for the Microsoft Store / signed NSIS build (tauri.store.conf.json signCommand).
# Tauri calls it for the app exe and the installer. The certificate is the owner's (P9-02):
#   VATRA_SIGN_THUMBPRINT  SHA-1 thumbprint of a code-signing cert in CurrentUser\My (or a token/HSM-backed one)
#   VATRA_SIGN_TIMESTAMP   RFC 3161 timestamp URL (default DigiCert)
# Without a thumbprint it fails loudly: a Store build must never ship unsigned by accident.
param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'

$thumb = $env:VATRA_SIGN_THUMBPRINT
if (-not $thumb) { throw 'VATRA_SIGN_THUMBPRINT is not set: no code-signing certificate configured (owner-only, P9-02)' }
$ts = if ($env:VATRA_SIGN_TIMESTAMP) { $env:VATRA_SIGN_TIMESTAMP } else { 'http://timestamp.digicert.com' }

$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $signtool) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $signtool = Get-ChildItem -Path $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) { throw 'signtool.exe not found (install the Windows SDK signing tools)' }

& $signtool sign /sha1 $thumb /fd sha256 /tr $ts /td sha256 /d 'Vatra' $File
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed ($LASTEXITCODE) for $File" }
& $signtool verify /pa $File
if ($LASTEXITCODE -ne 0) { throw "signtool verify failed ($LASTEXITCODE) for $File" }
