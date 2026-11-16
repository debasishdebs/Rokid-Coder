# Shared by the Pester suite: the module, a throwaway profile, and fakes. Nothing
# here touches the runner's real %LOCALAPPDATA%, %ProgramData% or .wslconfig.
$script:WindowsDir = Split-Path -Parent $PSScriptRoot
$script:ModulePath = Join-Path $script:WindowsDir 'lib\RokidCoder.psm1'
$script:ComputerDir = Split-Path -Parent (Split-Path -Parent $script:WindowsDir)
Import-Module $script:ModulePath -Force
# A non-ASCII Windows user name (Zoe with a diaeresis, Mueller with an umlaut), built from char
# codes because Windows PowerShell reads a BOM-less script as ANSI.
$script:UserName = "Zo$([char]0xEB) M$([char]0xFC)ller"

function Use-TestProfile {
  <# Points LOCALAPPDATA, ProgramData and USERPROFILE into a fresh dir in TestDrive; returns what to restore. #>
  # Fresh per call: Pester keeps one TestDrive for a whole Describe, so its Its would share a profile.
  $saved = @{ LOCALAPPDATA = $env:LOCALAPPDATA; ProgramData = $env:ProgramData; USERPROFILE = $env:USERPROFILE }
  $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
  $env:LOCALAPPDATA = Join-Path $root "Users\$script:UserName\AppData\Local"
  $env:ProgramData = Join-Path $root 'ProgramData'
  $env:USERPROFILE = Join-Path $root "Users\$script:UserName"
  New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA, $env:ProgramData, $env:USERPROFILE | Out-Null
  $saved
}

function Restore-TestProfile {
  param($Saved)
  foreach ($key in $Saved.Keys) { Set-Item -Path "env:$key" -Value $Saved[$key] }
}

function New-TestBinding {
  param([string]$Mode = 'mirrored', [string]$Version = '1.0.0', [string]$LinuxHome = '/home/zoe smith')
  [ordered]@{
    windowsSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'; windowsUser = "LAPTOP\$script:UserName"
    distroName = 'Ubuntu'; distroGuid = '{0b5bd4a5-7a7c-4d66-9c43-6e0c2f6f0f11}'
    linuxUser = 'zoe'; linuxUid = 1000; linuxHome = $LinuxHome
    bundleDir = "$LinuxHome/.local/share/rokid-coder/$Version"; agentdPath = "$LinuxHome/.rokid-coder/bin/agentd"
    wslExe = 'C:\Windows\System32\wsl.exe'; networkMode = $Mode; advertisePort = $(if ($Mode -eq 'nat') { 8794 } else { 8792 })
  }
}

function New-NativeResult { param([int]$ExitCode = 0, [string[]]$Output = @()) [pscustomobject]@{ ExitCode = $ExitCode; Output = $Output } }

function New-FakeWsl {
  <# A wsl.cmd that appends each argv line to wsl-calls.txt: what start-agentd.ps1 really runs. #>
  $dir = Join-Path $TestDrive ("fakewsl-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $cmd = Join-Path $dir 'wsl.cmd'
  Set-Content -LiteralPath $cmd -Value "@echo %*>>`"%~dp0wsl-calls.txt`"`r`n@exit /b 0" -Encoding ASCII
  [pscustomobject]@{ Path = $cmd; Log = (Join-Path $dir 'wsl-calls.txt') }
}

function Get-FakeWslCalls {
  param([Parameter(Mandatory = $true)]$Fake)
  if (Test-Path -LiteralPath $Fake.Log) { @(Get-Content -LiteralPath $Fake.Log) } else { @() }
}

function Get-WslScripts {
  <# wsl.ts's fixed interop scripts, from the built dist: the exact text setup sends to powershell.exe. #>
  $wsl = Join-Path $script:ComputerDir 'dist\setup\platform\wsl.js'
  if (-not (Test-Path -LiteralPath $wsl)) { throw "Build computer first: $wsl is missing" }
  $json = & node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).SCRIPTS))' $wsl
  $json | ConvertFrom-Json
}

function Invoke-WslScript {
  <# Runs one of wsl.ts's scripts the way interop does: powershell.exe -NoProfile -NonInteractive -Command <script>, JSON on stdin. #>
  param([Parameter(Mandatory = $true)][string]$Script, $InputObject)
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $json = $(if ($null -ne $InputObject) { ConvertTo-Json -InputObject $InputObject -Compress } else { '' })
  # Every non-ASCII character escaped, as wsl.ts's asciiJson does: a native pipe carries ASCII only.
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  $out = $json | & $powershell -NoProfile -NonInteractive -Command $Script
  (@($out) -join "`n").Trim()
}
