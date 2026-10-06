<#
.SYNOPSIS
  lego `--dns exec` hook -> Brivio ACME DNS-01 endpoint (DOMAINS_DNS_PLATFORM DD-62).
  lego calls: brivio-acme-hook.cmd present|cleanup <fqdn.> <value>

    Token: .private/publish/brivio-acme-pc.token (brv_dns_..., scoped to ONE zone
    and ONLY _acme-challenge* TXT records; override with BRIVIO_ACME_TOKEN_FILE).
    Never printed.
#>
param([string]$Action, [string]$Fqdn, [string]$Value)
$ErrorActionPreference = 'Stop'
if ($Action -notin 'present', 'cleanup') { exit 0 }
$file = if ($env:BRIVIO_ACME_TOKEN_FILE) { $env:BRIVIO_ACME_TOKEN_FILE } else { Join-Path (Split-Path $PSScriptRoot -Parent) '.private\publish\brivio-acme-pc.token' }
if (-not (Test-Path $file)) { [Console]::Error.WriteLine("missing $file"); exit 1 }
$token = (Get-Content $file -Raw).Trim()
$url = if ($env:BRIVIO_ACME_URL) { $env:BRIVIO_ACME_URL } else { 'https://brivio.ro/api/dns/acme' }
$body = @{ fqdn = $Fqdn; value = $Value; action = $Action } | ConvertTo-Json -Compress
try {
    Invoke-RestMethod -Method Post -Uri $url -TimeoutSec 30 -ContentType 'application/json' -Body $body `
                -Headers @{ Authorization = "Bearer $token" } | Out-Null
    Write-Host "brivio acme $Action $Fqdn ok"
}
catch {
    $code = $_.Exception.Response.StatusCode.value__
    [Console]::Error.WriteLine("brivio acme $Action $Fqdn -> HTTP $code $($_.ErrorDetails.Message)")
    exit 1
}
