# devcloud JIT runner VM, Windows (DC-051). One VM = one JIT runner = exactly one job, then power off.
# Metadata key windows-startup-script-ps1; the GCE agent runs it as SYSTEM and copies stdout to the
# serial console (COM1), where the controller reads the markers:
#   ::runner-online <s>s  seconds since boot when the runner listens (job record bootSec)
#   ::runner-exit         just before `shutdown /s`
# The controller deletes the VM on the `completed` webhook; a TERMINATED or over-age gha-* VM is deleted by
# the janitor; max-run-duration (DELETE) is the backstop. The VM has NO service account.
# The runner runs as a local admin user `runner` (fresh random password per boot) through a scheduled task,
# not as SYSTEM. On a devcloud-ci-win-desktop image (C:\devcloud\baked) it starts at once; on stock
# Windows Server 2025 it downloads the runner first.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Say([string]$m) { Write-Output $m }
function Md([string]$k, [string]$d = '') {
  try { (Invoke-RestMethod -Headers @{ 'Metadata-Flavor' = 'Google' } -Uri "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$k" -TimeoutSec 10).ToString() } catch { $d }
}
function Uptime { [int]((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds }
$t0 = Get-Date
$R = 'C:\actions-runner'
$task = 'devcloud-runner'
try {
  $idleMin = [int](Md 'idle-minutes' '20')
  $ver = Md 'runner-version' '2.338.0'
  if (Test-Path 'C:\devcloud\baked') {
    Say "::image $(Get-Content C:\devcloud\image.json -Raw -ErrorAction SilentlyContinue)"
  } else {
    Say "::bootstrap start $(Get-Date -Format o)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Force $R | Out-Null
    $zip = Join-Path $env:TEMP 'actions-runner.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$ver/actions-runner-win-x64-$ver.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $R -Force
    Remove-Item $zip -Force
    Set-Content -Path "$R\.env" -Value "DEVCLOUD_RUNNER=1" -Encoding ascii
    Say "::bootstrap done $([int]((Get-Date) - $t0).TotalSeconds)s"
  }
  Remove-Item "$R\.exit", "$R\runner.log" -Force -ErrorAction SilentlyContinue

  # Local admin user for the job (hosted Windows runners are admin too); new random password every boot.
  $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $pw = -join (1..24 | ForEach-Object { $chars | Get-Random }) + 'a1A!'
  $sec = ConvertTo-SecureString $pw -AsPlainText -Force
  if (Get-LocalUser -Name runner -ErrorAction SilentlyContinue) { Set-LocalUser -Name runner -Password $sec }
  else { New-LocalUser -Name runner -Password $sec -PasswordNeverExpires -AccountNeverExpires -Description 'devcloud CI runner' | Out-Null }
  if (-not (Get-LocalGroupMember -Group Administrators -Member runner -ErrorAction SilentlyContinue)) { Add-LocalGroupMember -Group Administrators -Member runner }

  # The JIT config goes through a file the wrapper deletes on read (not a task argument).
  Set-Content -Path "$R\.jit" -Value (Md 'jit-config') -Encoding ascii -NoNewline
  $wrapper = @'
$R = 'C:\actions-runner'
$j = (Get-Content "$R\.jit" -Raw).Trim()
Remove-Item "$R\.jit" -Force
Set-Location $R
& cmd.exe /c "run.cmd --jitconfig $j > `"$R\runner.log`" 2>&1"
Set-Content -Path "$R\.exit" -Value $LASTEXITCODE -Encoding ascii
'@
  Set-Content -Path "$R\devcloud-run.ps1" -Value $wrapper -Encoding ascii
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $R\devcloud-run.ps1" -WorkingDirectory $R
  $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $task -Action $act -Settings $set -User runner -Password $pw -RunLevel Highest | Out-Null
  $pw = $null; $sec = $null
  Start-ScheduledTask -TaskName $task
  Say "::runner-started $(Uptime)s"

  # Online = "Listening for Jobs" in the log; assigned = a Worker_ diag log; idle watchdog like Linux.
  $online = $false; $assigned = $false
  $deadline = (Get-Date).AddMinutes($idleMin)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not $online -and (Test-Path "$R\runner.log") -and (Select-String -Path "$R\runner.log" -Pattern 'Listening for Jobs' -SimpleMatch -Quiet)) {
      $online = $true; Say "::runner-online $(Uptime)s"
    }
    if (Get-ChildItem "$R\_diag" -Filter 'Worker_*.log' -ErrorAction SilentlyContinue) {
      if (-not $online) { $online = $true; Say "::runner-online $(Uptime)s" }
      $assigned = $true; Say "::job-assigned $(Get-Date -Format o)"; break
    }
    if (Test-Path "$R\.exit") { break }
  }
  if (-not $assigned -and -not (Test-Path "$R\.exit")) {
    Say "::idle no job within $idleMin min"
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  } else {
    while (-not (Test-Path "$R\.exit")) {
      Start-Sleep -Seconds 10
      if ((Get-ScheduledTask -TaskName $task).State -ne 'Running') { Start-Sleep -Seconds 5; break }
    }
    Say "::runner-done rc=$(Get-Content "$R\.exit" -ErrorAction SilentlyContinue)"
  }
} catch {
  Say "::runner-error $($_.Exception.Message)"
} finally {
  Say "::runner-exit $(Get-Date -Format o) after $([int]((Get-Date) - $t0).TotalSeconds)s"
  & shutdown.exe /s /t 0 /f
}
