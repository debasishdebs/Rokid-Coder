<#
  uninstall.ps1 [-Purge] [-KeepMirrored yes|no]   (Apps & Features runs it through the NSIS uninstaller)

  1. rokid-setup uninstall [--purge --yes] in the committed binding's distro (the
     registered task's binding, confirmed by that distro's install.json): stops agentd
     and removes the plugins, wrappers, PATH block and bundles; state stays unless purged.
     A distro that is no longer registered has nothing left to remove.
  2. Unregister-ScheduledTask \RokidCoder\agentd.
  3. The elevated machine.ps1 -Revert -All: every rule and proxy entry recorded
     in machine-state.json, and nothing it did not create.
  4. .wslconfig: only if networkingMode still holds what setup set, ask
     "Keep mirrored networking? [Y/n]"; on n, put the earlier value back.
  5. %LOCALAPPDATA%\Programs\RokidCoder's generations and every binding-*.json.

  The first step that fails stops it with exit 1, keeping what the later steps
  remove (the task, the bindings, launchers and journal; installer.nsi keeps the
  uninstaller and its registration on a nonzero exit), so running the uninstaller
  again retries from there.
#>
param(
  [switch]$Purge,
  [ValidateSet('', 'yes', 'no')][string]$KeepMirrored = ''
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Module RokidCoder)) { Import-Module (Join-Path $PSScriptRoot 'lib\RokidCoder.psm1') }

$paths = Get-RokidPaths

function Stop-Uninstall {
  param([Parameter(Mandatory = $true)][string]$Problem)
  Write-Warning $Problem
  Write-Warning 'Nothing after that step was removed: run the uninstaller again to retry.'
  exit 1
}

# 1: in the distro of the COMMITTED binding (the one install.json names), never a failed Repair's newer one
$committed = Resolve-CommittedBinding -Paths $paths
if ($committed) {
  $binding = $committed.Binding
  if (-not (@(Get-LxssDistros) | Where-Object { $_.Name -eq $binding.distroName })) {
    Write-Output "The $($binding.distroName) distro is no longer installed, so nothing of Rokid Coder is left in it."
  } else {
    $argv = @('uninstall') + $(if ($Purge) { @('--purge', '--yes') } else { @() })
    $run = Invoke-WslExec -Distro $binding.distroName -User $binding.linuxUser -Path "$($binding.linuxHome)/.rokid-coder/bin/rokid-setup" -Arguments $argv
    $run.Output | ForEach-Object { Write-Output $_ }
    if ($run.ExitCode -ne 0) { Stop-Uninstall "rokid-setup uninstall in $($binding.distroName) exited $($run.ExitCode)" }
  }
}

# 2
if (Get-ScheduledTask -TaskPath '\RokidCoder\' -TaskName 'agentd' -ErrorAction SilentlyContinue) {
  try { Unregister-ScheduledTask -TaskPath '\RokidCoder\' -TaskName 'agentd' -Confirm:$false -ErrorAction Stop }
  catch { Stop-Uninstall "the \RokidCoder\agentd task could not be removed: $($_.Exception.Message)" }
}

# 3
if (@((Read-MachineState -StatePath $paths.MachineState).objects).Count -gt 0) {
  try { $code = Invoke-MachineHelper -Action Revert -All } catch { $code = "not run ($($_.Exception.Message))" }
  if ("$code" -ne '0') { Stop-Uninstall "the firewall rules and port proxy could not be removed (machine.ps1: $code); an administrator has to approve the prompt" }
}

# 4
$ask = {
  param($question)
  if ($KeepMirrored) { return $(if ($KeepMirrored -eq 'no') { 'n' } else { 'y' }) }
  Read-Host $question
}
Restore-WslConfigChange -Ask $ask | Out-Null

# 5: only now that nothing above can still need them
Get-ChildItem -LiteralPath $paths.InstallRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '-\d{14}$' } | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $paths.DataRoot -Filter 'binding-*.json' -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item -LiteralPath $paths.Journal -Recurse -Force -ErrorAction SilentlyContinue
exit 0
