<#
  The installer's per-user steps, unelevated, as the session user [FR 13]:

  user-setup.ps1 -CheckSession
  user-setup.ps1 -ApplyMachine -Mode <mode> -RunId <id>     (the one UAC prompt: machine.ps1 -Apply)
  user-setup.ps1 -RevertMachine -RunId <id>                 (a failed or cancelled install: only this run's objects)
  user-setup.ps1 -ApplyWslConfig -Mode <mode>               (the consented .wslconfig change, then wsl --shutdown)
  user-setup.ps1 -Install -Mode <mode> -Distro <name> -Version <v> -Archive <tar.gz> -Sha256File <file>

  Exit codes: 0 ok; 1 failed; 3 (-ApplyWslConfig) mirrored was set but WSL runs NAT.
#>
param(
  [switch]$CheckSession,
  [switch]$ApplyMachine,
  [switch]$RevertMachine,
  [switch]$ApplyWslConfig,
  [switch]$Install,
  [ValidateSet('mirrored', 'nat')][string]$Mode,
  [string]$RunId,
  [string]$Distro,
  [string]$Version,
  [string]$Archive,
  [string]$Sha256File
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Module RokidCoder)) { Import-Module (Join-Path $PSScriptRoot 'lib\RokidCoder.psm1') }

try {
  if ($CheckSession) {
    Assert-SessionUser
    exit 0
  }
  if ($ApplyMachine) {
    Assert-SessionUser
    exit (Invoke-MachineHelper -Action Apply -Mode $Mode -RunId $RunId)
  }
  if ($RevertMachine) {
    # Nothing recorded for this run (its Apply was refused, or undid itself): no elevation is asked for.
    if (-not (@((Read-MachineState -StatePath (Get-RokidPaths).MachineState).objects) | Where-Object { $_.runId -eq $RunId })) { exit 0 }
    exit (Invoke-MachineHelper -Action Revert -RunId $RunId)
  }
  if ($ApplyWslConfig) {
    Assert-SessionUser
    $selected = Select-Distro -Distros @(Get-LxssDistros) -Requested $Distro
    if ($Mode -eq 'mirrored') {
      Set-WslConfigValue -Key 'networkingMode' -Value 'mirrored'
    } else {
      Set-WslConfigValue -Key 'localhostForwarding' -Value 'true'
    }
    # The page that asked for consent said so: this closes every running distro.
    Invoke-Native -FilePath (Get-WslExe) -ArgumentList @('--shutdown') | Out-Null
    if ($Mode -eq 'mirrored' -and $selected -and (Get-EffectiveNetworkingMode -Distro $selected.Name) -ne 'mirrored') {
      Write-Output 'WSL did not switch to mirrored networking; continuing in NAT mode.'
      exit 3
    }
    exit 0
  }
  if ($Install) {
    $selected = Select-Distro -Distros @(Get-LxssDistros) -Requested $Distro
    if (-not $selected) { throw "No WSL distro named '$Distro'" }
    $sha256 = ((Get-Content -LiteralPath $Sha256File -Raw) -split '\s+')[0]
    $result = Invoke-UserInstall -Version $Version -Mode $Mode -Distro $selected -Archive $Archive -Sha256 $sha256
    if ($result.ExitCode -eq 0 -and $Mode -eq 'nat') {
      Write-Output "Automatic discovery doesn't work in this network mode - scan the QR code on your phone, or use Tailscale."
      Write-Output "If this computer's IP address changes, the phone shows 'pair again' until the next sign-in; Tailscale gives it an address that stays."
    }
    exit $result.ExitCode
  }
  throw 'Nothing to do: give -CheckSession, -ApplyMachine, -RevertMachine, -ApplyWslConfig or -Install'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
