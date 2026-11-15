<#
  uninstall.ps1 [-Purge] [-KeepMirrored yes|no]   (Apps & Features runs it through the NSIS uninstaller)

  1. rokid-setup uninstall [--purge --yes] in the committed binding's distro (the
     registered task's binding, confirmed by that distro's install.json): stops agentd
     and removes the plugins, wrappers, PATH block and bundles; state stays unless purged.
  2. Unregister-ScheduledTask \RokidCoder\agentd.
  3. The elevated machine.ps1 -Revert -All: every rule and proxy entry recorded
     in machine-state.json, and nothing it did not create.
  4. .wslconfig: only if networkingMode still holds what setup set, ask
     "Keep mirrored networking? [Y/n]"; on n, put the earlier value back.
  5. %LOCALAPPDATA%\Programs\RokidCoder's generations and every binding-*.json.
#>
param(
  [switch]$Purge,
  [ValidateSet('', 'yes', 'no')][string]$KeepMirrored = ''
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Module RokidCoder)) { Import-Module (Join-Path $PSScriptRoot 'lib\RokidCoder.psm1') }

$paths = Get-RokidPaths
$problems = New-Object System.Collections.Generic.List[string]

# 1: in the distro of the COMMITTED binding (the one install.json names), never a failed Repair's newer one
$committed = Resolve-CommittedBinding -Paths $paths
if ($committed) {
  $binding = $committed.Binding
  $argv = @('uninstall') + $(if ($Purge) { @('--purge', '--yes') } else { @() })
  $run = Invoke-WslExec -Distro $binding.distroName -User $binding.linuxUser -Path "$($binding.linuxHome)/.rokid-coder/bin/rokid-setup" -Arguments $argv
  $run.Output | ForEach-Object { Write-Output $_ }
  if ($run.ExitCode -ne 0) { $problems.Add("rokid-setup uninstall exited $($run.ExitCode)") }
}

# 2
Unregister-ScheduledTask -TaskPath '\RokidCoder\' -TaskName 'agentd' -Confirm:$false -ErrorAction SilentlyContinue

# 3
if (@((Read-MachineState -StatePath $paths.MachineState).objects).Count -gt 0) {
  $code = Invoke-MachineHelper -Action Revert -All
  if ($code -ne 0) { $problems.Add("the firewall and port proxy could not be removed (machine.ps1 exited $code)") }
}

# 4
$ask = {
  param($question)
  if ($KeepMirrored) { return $(if ($KeepMirrored -eq 'no') { 'n' } else { 'y' }) }
  Read-Host $question
}
Restore-WslConfigChange -Ask $ask | Out-Null

# 5
Get-ChildItem -LiteralPath $paths.InstallRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '-\d{14}$' } | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $paths.DataRoot -Filter 'binding-*.json' -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item -LiteralPath $paths.Journal -Recurse -Force -ErrorAction SilentlyContinue

foreach ($problem in $problems) { Write-Warning $problem }
if ($problems.Count -gt 0) { exit 1 }
exit 0
