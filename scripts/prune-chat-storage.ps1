#Requires -Version 5.1
<#
.SYNOPSIS
  Archive stale VS Code chat *editing* state so windows stop freezing on open.

.DESCRIPTION
  VS Code stores, per workspace, two things under User\workspaceStorage\<id>\:
    chatSessions\*.jsonl      the conversations. NEVER touched by this script.
    chatEditingSessions\<id>\ pending Keep/Undo diff state for edits already
                              applied to the working tree.
  On window open, every entry in every restored editing session becomes a
  working copy (2 text models each). Measured on dragos-dev 2026-09-12: 513
  working copies, 6418 unacknowledged messages on the ext-host socket, the
  socket timed out every 20 s and the extension host exited 6 times in 13 min
  ("Initializing apps/web/tsconfig.json" freeze).

  This moves editing-session dirs older than -MaxAgeDays, or holding more than
  -MaxEntries pending files, to %LOCALAPPDATA%\vmui-archive\chatEditingSessions\
  keeping the workspace id and dir name, so a plain Move-Item restores them.
  Nothing is deleted.

  While VS Code is running (the normal state on a 40 h dev session), only
  sessions whose newest file is older than -IdleHours are touched: the live
  session is written continuously, so it is never selected. Recurrence seen
  2026-09-13: the same workspace re-grew to 4 sessions / 1572 entries / 1.27 GB
  in 40 h with only the logon task in place.

.PARAMETER Register
  Register a scheduled task (current user) that runs at logon (+90 s) and then
  every -RepeatMinutes, with the same thresholds.

.EXAMPLE
  pwsh -File scripts\prune-chat-storage.ps1 -WhatIf
  pwsh -File scripts\prune-chat-storage.ps1
  pwsh -File scripts\prune-chat-storage.ps1 -Register
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [int]$MaxAgeDays = 2,
  [int]$MaxEntries = 100,
  [double]$IdleHours = 2,
  [int]$RepeatMinutes = 120,
  [string[]]$Edition = @("Code - Insiders", "Code"),
  [switch]$Register,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if ($Register) {
  $pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $pwshExe) { $pwshExe = (Get-Command powershell).Source }
  # wscript + hidden-run.vbs: under an Interactive token a console exe flashes
  # a window for a few hundred ms on every run (-WindowStyle Hidden and the
  # task's Hidden flag do not prevent it). S4U would avoid the console but
  # registering an S4U task needs elevation on this host.
  $vbs = Join-Path $PSScriptRoot "hidden-run.vbs"
  $inner = ("`"{0}`" -NoProfile -ExecutionPolicy Bypass -File `"{1}`" -MaxAgeDays {2} -MaxEntries {3} -IdleHours {4}" -f $pwshExe, $PSCommandPath, $MaxAgeDays, $MaxEntries, $IdleHours)
  $action = if (Test-Path $vbs) {
    New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`" $inner"
  } else {
    New-ScheduledTaskAction -Execute $pwshExe -Argument ($inner -replace '^"[^"]+"\s*', '')
  }
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $logon.Delay = "PT90S"
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes)
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable -Hidden
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  Register-ScheduledTask -TaskName "VmuiPruneChatStorage" -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Registered task VmuiPruneChatStorage (logon +90s, every $RepeatMinutes min, hidden via wscript): $pwshExe -File $PSCommandPath"
  return
}

$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $Edition -contains $_.ProcessName })
$live = $running.Count -gt 0 -and -not $Force
$idleCutoff = (Get-Date).AddHours(-$IdleHours)
if ($live) { Write-Host ("VS Code is running ({0} processes) - only sessions idle for more than {1} h are eligible." -f $running.Count, $IdleHours) }

$archiveRoot = Join-Path $env:LOCALAPPDATA "vmui-archive\chatEditingSessions"
$cutoff = (Get-Date).AddDays(-$MaxAgeDays)
$moved = 0; $movedBytes = 0L; $kept = 0; $skippedLive = 0

foreach ($ed in $Edition) {
  $wsRoot = Join-Path $env:APPDATA "$ed\User\workspaceStorage"
  if (-not (Test-Path $wsRoot)) { continue }
  foreach ($ws in Get-ChildItem $wsRoot -Directory) {
    $ce = Join-Path $ws.FullName "chatEditingSessions"
    if (-not (Test-Path $ce)) { continue }
    foreach ($sess in Get-ChildItem $ce -Directory) {
      $stateFile = Join-Path $sess.FullName "state.json"
      $entries = 0
      if (Test-Path $stateFile) {
        try {
          $st = Get-Content $stateFile -Raw | ConvertFrom-Json
          if ($st.recentSnapshot) { $entries = @($st.recentSnapshot.entries).Count }
        } catch { $entries = -1 }
      }
      $files = @(Get-ChildItem $sess.FullName -Recurse -File)
      $newest = $sess.LastWriteTime
      foreach ($f in $files) { if ($f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime } }
      $old = $newest -lt $cutoff
      $big = $entries -gt $MaxEntries
      if (-not ($old -or $big)) { $kept++; continue }
      if ($live -and $newest -gt $idleCutoff) { $skippedLive++; continue }

      $size = ($files | Measure-Object Length -Sum).Sum
      $dest = Join-Path $archiveRoot ("{0}\{1}\{2}" -f $ed, $ws.Name, $sess.Name)
      $reason = @(); if ($old) { $reason += "age" }; if ($big) { $reason += "entries=$entries" }
      if ($PSCmdlet.ShouldProcess($sess.FullName, "archive to $dest [$($reason -join ',')]")) {
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Move-Item $sess.FullName $dest
        $moved++; $movedBytes += $size
      }
    }
  }
}

Write-Host ("archived {0} editing sessions ({1} MB) to {2}; kept {3}; deferred (active) {4}" -f $moved, [int]($movedBytes / 1MB), $archiveRoot, $kept, $skippedLive)
