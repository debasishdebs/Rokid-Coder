<#
  preflight.ps1 -Mode mirrored|nat [-Distro <name>] [-RetireLegacy] [-Json | -Text]
  preflight.ps1 -Recommend

  Every requirement for the chosen network mode, each {id, ok, detail, fix,
  optional, action} (U37, section 13.1). Exit 0 only when every non-optional item
  passes. -Recommend prints which modes this WSL allows, so the installer can
  offer mirrored only when it can work [6b-R1].
#>
param(
  [ValidateSet('mirrored', 'nat')][string]$Mode = 'nat',
  [string]$Distro,
  [switch]$RetireLegacy,
  [switch]$Json,
  [switch]$Text,
  [switch]$Recommend,
  # The text, UTF-16LE, for the installer page: NSIS strings stop at 1024 characters, its file reads do not.
  [string]$OutFile
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Module RokidCoder)) { Import-Module (Join-Path $PSScriptRoot 'lib\RokidCoder.psm1') }

if ($Recommend) {
  $requirements = Get-WslRequirements
  $wsl = Get-WslVersionInfo
  $mirrored = Select-NetworkMode -WslVersion $wsl.Version -MirroredMin $requirements.mirroredMin -ConsentMirrored $true
  ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ mirroredAvailable = ($mirrored -eq 'mirrored'); wslVersion = "$($wsl.Version)"; source = $wsl.Source })
  exit 0
}

$result = Invoke-Preflight -Mode $Mode -DistroName $Distro -RetireLegacy:$RetireLegacy
if ($Json) { ConvertTo-Json -InputObject $result -Depth 4 }
elseif ($OutFile) { Write-Utf16File -Path $OutFile -Content ((Format-PreflightText -Result $result) + "`r`n") }
else { Format-PreflightText -Result $result }
if (Test-PreflightPassed -Result $result) { exit 0 }
exit 1
