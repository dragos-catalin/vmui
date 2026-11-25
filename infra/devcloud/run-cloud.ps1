<#
.SYNOPSIS
  Runs one command on the devcloud pool instead of this workstation.

.DESCRIPTION
  Heavy work in this repo - a full `pnpm test`, a Rust or Gradle build - competes with the
  editor for a machine that is already busy, and the numbers it produces are not reproducible
  while it waits for CPU. This wrapper hands the command to a warm cloud workspace through
  agentq, so the same command runs on the same image every time and the workstation stays
  responsive:

    pwsh -NoProfile -File infra/devcloud/run-cloud.ps1 -Command 'pnpm test'
    pwsh -NoProfile -File infra/devcloud/run-cloud.ps1 -Command 'pnpm typecheck' -Resource verify
    pwsh -NoProfile -File infra/devcloud/run-cloud.ps1 -Command 'pnpm test' -DryRun

  `-Command` travels as ONE argv item, so the caller must quote it. It runs from the root of
  the bundle agentq uploads, which is this working tree at HEAD.

  `-Command` is tokenised here and each token reaches agentq as its own argv item, because a
  single token containing spaces is quoted by the lane and arrives on Linux as one word.
  Measured 2026-11-25 on `ws-codai` (64 vCPU, warm):

    -- 'pnpm typecheck'   (one token)  ->  $ bash -lc 'pnpm typecheck'
                                           bash: line 1: pnpm typecheck: command not found
                                           [devcloud] exit 127, total 44,6 s
    -- node --version     (two tokens) ->  v24.21.0
                                           [devcloud] exit 0, total 3,9 s

  The Windows workspace (`ws-caelia`) still accepts one token with spaces, which is why a gate
  written as `-File tool/verify.ps1 -Quick` works there; separate tokens work on both.

  The exit code is the remote one: agentq prints `[devcloud] exit <n>`, that number is parsed
  and returned, and the whole output is teed to `.copilot-tmp/run-cloud/<stamp>.log`.

.PARAMETER Command
  The command line to run on the pool, as one string. Single or double quotes inside it are
  honoured: `-Command 'node -e "console.log(1)"'` keeps `console.log(1)` as one token, and an
  unbalanced quote is refused rather than guessed at.

.PARAMETER Resource
  agentq resource the submission queues on. Default `build`. A LAND GATE must pass something
  else, e.g. `-Resource verify`: the gate runs under `run-build`'s ticket for `build:vmui`, so a
  nested submission on the same resource waits for a ticket its own parent holds and the land
  deadlocks until the timeout. `verify:vmui` is a different resource with the same cap, so the
  pool work is still serialised, just not against itself.

.PARAMETER Workspace
  agentq cloud workspace name. Default `codai`.

.PARAMETER TimeoutMin
  Wall-clock cap given to agentq. Default 60. The first upload of a fresh tree, plus the queue,
  usually dominates the run itself.

.PARAMETER Repo
  Working tree to bundle. Default: this script's own tree, so inside a lease that is the slot
  the command was issued from.

.PARAMETER Purpose
  Recorded on the agentq ticket. Defaults to the command.

.PARAMETER DryRun
  Print the exact `agentq run` invocation and exit 0 without queueing anything.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string]$Resource = 'build',
    [string]$Workspace = 'codai',
    [int]$TimeoutMin = 60,
    [string]$Repo,
    [string]$Purpose,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Split a command line into argv tokens. Whitespace separates; quotes (single or double) group
# and are removed; everything else is literal. An unbalanced quote is an error, never a guess.
function Split-Argv {
  param([string]$Line)
  $tokens = New-Object System.Collections.Generic.List[string]
  $sb = New-Object System.Text.StringBuilder
  $quote = $null
  $open = $false
  foreach ($ch in $Line.ToCharArray()) {
    if ($quote) {
      if ($ch -eq $quote) { $quote = $null } else { [void]$sb.Append($ch) }
      continue
    }
    if ($ch -eq [char]39 -or $ch -eq [char]34) { $quote = $ch; $open = $true; continue }
    if ([char]::IsWhiteSpace($ch)) {
      if ($open -or $sb.Length -gt 0) { $tokens.Add($sb.ToString()); [void]$sb.Clear(); $open = $false }
      continue
    }
    [void]$sb.Append($ch)
    $open = $true
  }
  if ($quote) { throw "unbalanced $quote in -Command: $Line" }
  if ($open -or $sb.Length -gt 0) { $tokens.Add($sb.ToString()) }
  return ,$tokens.ToArray()
}

$tokens = Split-Argv -Line $Command
if ($tokens.Count -eq 0) { throw "-Command is empty" }

# infra/devcloud/run-cloud.ps1 -> the repo root is two levels up.
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Repo) { $Repo = $repoRoot }
if (-not $Purpose) { $Purpose = "run on the pool: $Command" }

$agentq = Join-Path $HOME '.copilot/bin/agentq.ps1'
$argv = @(
    '-NoProfile', '-File', $agentq,
    'run', '-Resource', $Resource, '-Where', 'cloud', '-Ws', $Workspace,
    '-Repo', $Repo, '-Purpose', $Purpose, '-TimeoutMin', "$TimeoutMin",
  '--'
) + $tokens

if ($DryRun) {
    'agentq ' + ($argv[3..($argv.Count - 1)] -join ' ')
  "  remote argv:    $($tokens.Count) token(s): $($tokens -join ' | ')"
    "  repo:           $Repo"
    exit 0
}

$logDir = Join-Path $repoRoot '.copilot-tmp/run-cloud'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
"=== on the pool: $Command"
"=== log: $log"

& pwsh @argv 2>&1 | Tee-Object -FilePath $log
$agentqExit = $LASTEXITCODE

# Parse the trailer rather than trusting $LASTEXITCODE: agentq exits 3 for "someone else holds
# the resource", which is a queueing problem, not a result of the command.
$remote = $null
$m = Select-String -Path $log -Pattern '\[devcloud\] exit (\d+)' | Select-Object -Last 1
if ($m) { $remote = [int]$m.Matches[0].Groups[1].Value }

if ($null -eq $remote) {
    "RUN-CLOUD: no '[devcloud] exit' line in the log - agentq did not run the command (exit $agentqExit)."
    exit $agentqExit
}
if ($remote -ne 0) {
    "RUN-CLOUD: FAILED (remote exit $remote) - see $log"
    exit $remote
}
'RUN-CLOUD: PASS (remote exit 0)'
exit 0
