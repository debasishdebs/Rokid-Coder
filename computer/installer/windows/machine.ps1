<#
  machine.ps1 -Apply -Mode mirrored|nat -StatePath <file> -RunId <id>
  machine.ps1 -Revert (-RunId <id> | -All) -StatePath <file>

  The ONLY elevated code (Start-Process -Verb RunAs -Wait) [FR 13]. It changes
  machine scope only: the host firewall rules, the Hyper-V firewall rules and
  the port-proxy entry, each recorded in %ProgramData%\RokidCoder\machine-state.json
  (name, ids, run id). It reads and writes no user profile, registry hive or WSL
  distro, so an administrator elevating it from another account binds nobody.
#>
param(
  [switch]$Apply,
  [switch]$Revert,
  [ValidateSet('mirrored', 'nat')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$StatePath,
  [string]$RunId,
  [switch]$All
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Module RokidCoder)) { Import-Module (Join-Path $PSScriptRoot 'lib\RokidCoder.psm1') }

$principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [Console]::Error.WriteLine('machine.ps1 changes the firewall and must run elevated')
  exit 2
}
try {
  if ($Apply -eq $Revert) { throw 'Give exactly one of -Apply or -Revert' }
  if ($Apply) {
    if (-not $Mode -or -not $RunId) { throw '-Apply needs -Mode and -RunId' }
    Invoke-MachineApply -Mode $Mode -StatePath $StatePath -RunId $RunId
  } else {
    Invoke-MachineRevert -StatePath $StatePath -RunId $RunId -All:$All
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
