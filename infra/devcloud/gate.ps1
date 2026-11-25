<#
.SYNOPSIS
  The vmui land gate: `pnpm typecheck`, run on the devcloud pool instead of this workstation.

.DESCRIPTION
  agentq calls this as `landGate.vmui`. The gate runs while the machine is already busy (a land
  gate is one of several things happening at once), so the work goes to the warm workspace:

    infra/devcloud/gate.ps1                         # pnpm typecheck on the pool
    pwsh -NoProfile -File infra/devcloud/gate.ps1 -TimeoutMin 45

  IMPORTANT: the submission is made on the `verify` resource, not `build`. A land gate already
  runs inside `run-build`'s ticket for `build:vmui`, so a nested submission on that same resource
  would wait for a ticket its own parent holds - the land would deadlock until the timeout.
  `verify` has the same cap, so the pool work is still serialised, just not against itself.

  Exit code is the remote one (0 = pass), so agentq reads this gate exactly like a local command.

.PARAMETER Workspace
  agentq cloud workspace name. Default `codai` (the Linux workspace, 64 vCPU).

.PARAMETER TimeoutMin
  Wall-clock cap for the submission. Default 30; the delta upload plus the queue is most of it.

.PARAMETER DryRun
  Show what would be submitted, without submitting.
#>
[CmdletBinding()]
param(
    [string]$Workspace = 'codai',
    [int]$TimeoutMin = 30,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$runner = Join-Path $PSScriptRoot 'run-cloud.ps1'
if (-not (Test-Path $runner)) { throw "run-cloud.ps1 not found next to $PSCommandPath" }

$args = @(
    '-NoProfile', '-File', $runner,
    '-Command', 'pnpm typecheck',
    '-Resource', 'verify',
    '-Workspace', $Workspace,
    '-TimeoutMin', "$TimeoutMin"
)
if ($DryRun) { $args += '-DryRun' }

& pwsh @args
exit $LASTEXITCODE
