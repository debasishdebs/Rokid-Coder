<#
  The Windows half of Rokid Coder's installer (6b T8): preflight, the per-user
  staging into WSL, and the machine-scope firewall/port-proxy plan. Windows
  PowerShell 5.1. Every native call goes through Invoke-Native, so the Pester
  suite can mock wsl.exe, schtasks.exe and netsh.exe in one place.

  Rules this module keeps:
  - Every WSL call is `wsl.exe -d <distro> [-u <user>] --exec <absolute path> <argv...>`:
    no shell, no ~, arguments never joined into a `bash -c` string.
  - Staging writes only NEW, versioned files and never overwrites [6b-R10, 6b-R21].
  - Only the machine plan (machine.ps1, elevated) touches firewall and port proxy,
    and it reads or writes no user profile, registry hive or distro.
#>
Set-StrictMode -Version 2.0

$script:WslVmCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$script:TaskPath = '\RokidCoder\'
$script:TaskName = 'agentd'
$script:FirewallGroup = 'Rokid Coder'
$script:NatPort = 8794
$script:WssPort = 8792
$script:HttpPort = 8791
$script:DiscoveryPort = 8793
$script:Tailnet = '100.64.0.0/10'
# Whether New-NetFirewallHyperVRule takes the LocalSubnet keyword in -RemoteAddresses. Until the
# metadata test and gate W3 show it does, the Hyper-V rules carry the concrete Private/Domain prefixes.
$script:HyperVTakesLocalSubnet = $false
$script:RelayImages = @('wslrelay.exe', 'wslhost.exe', 'vmmem', 'vmmemwsl', 'vmwp.exe')
# `getconf GNU_LIBC_VERSION` prints "glibc 2.35": two components, rarely three. wsl-requirements.json's floor is the bare "2.35".
$script:GlibcPattern = '^\s*(?:glibc\s+)?(\d+)\.(\d+)(?:\.(\d+))?\s*$'
$script:Root = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------- the native boundary

function Invoke-Native {
  <# Runs an executable with argv (no shell). Returns its exit code and stdout lines. #>
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @()
  )
  $previous = [Console]::OutputEncoding
  # Windows PowerShell turns a native command's stderr into errors: never terminating ones here.
  $ErrorActionPreference = 'Continue'
  try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $env:WSL_UTF8 = '1'
    $output = @(& $FilePath @ArgumentList 2>$null)
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($output | ForEach-Object { "$_" }) }
  } finally {
    [Console]::OutputEncoding = $previous
  }
}

function Get-WslExe { Join-Path $env:SystemRoot 'System32\wsl.exe' }

function Invoke-WslExec {
  <# wsl.exe -d <distro> [-u <user>] --exec <absolute path> <args>: the only way this module runs anything in WSL. #>
  param(
    [Parameter(Mandatory = $true)][string]$Distro,
    [string]$User,
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$Arguments = @()
  )
  if (-not $Path.StartsWith('/') -or $Path.Contains('~')) { throw "A WSL call needs an absolute Linux path, not '$Path'" }
  $argv = @('-d', $Distro)
  if ($User) { $argv += @('-u', $User) }
  $argv += @('--exec', $Path) + $Arguments
  Invoke-Native -FilePath (Get-WslExe) -ArgumentList $argv
}

function ConvertTo-CommandLine {
  <# One Windows command line from argv, quoted the way CommandLineToArgvW splits it back. #>
  param([string[]]$Arguments)
  $quoted = foreach ($arg in $Arguments) {
    if ($arg -ne '' -and $arg -notmatch '[\s"]') { $arg; continue }
    $out = '"'
    $slashes = 0
    foreach ($c in $arg.ToCharArray()) {
      if ($c -eq '\') { $slashes++; continue }
      if ($c -eq '"') { $out += ('\' * (2 * $slashes + 1)) + '"' } else { $out += ('\' * $slashes) + $c }
      $slashes = 0
    }
    $out + ('\' * (2 * $slashes)) + '"'
  }
  $quoted -join ' '
}

# ---------------------------------------------------------------- paths and records

function Get-RokidPaths {
  param([string]$LocalAppData = $env:LOCALAPPDATA, [string]$ProgramData = $env:ProgramData)
  [pscustomobject]@{
    InstallRoot  = Join-Path $LocalAppData 'Programs\RokidCoder'
    DataRoot     = Join-Path $LocalAppData 'RokidCoder'
    Journal      = Join-Path $LocalAppData 'RokidCoder\journal'
    WslConfigLog = Join-Path $LocalAppData 'RokidCoder\wslconfig-change.json'
    MachineState = Join-Path $ProgramData 'RokidCoder\machine-state.json'
  }
}

function Get-WslRequirements {
  param([string]$Path = (Join-Path $script:Root 'wsl-requirements.json'))
  Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-Utf8File {
  <# UTF-8 without a BOM: node's JSON.parse refuses a BOM. #>
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding $false))
}

function Write-Utf16File {
  <# UTF-16LE with a BOM, as schtasks /XML expects for encoding="UTF-16". #>
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UnicodeEncoding $false, $true))
}

# ---------------------------------------------------------------- versions, distros

function ConvertTo-WslVersion {
  param([string]$Text)
  if ($Text -match '(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?') {
    return [version]('{0}.{1}.{2}.{3}' -f $Matches[1], $Matches[2], $Matches[3], $(if ($Matches[4]) { $Matches[4] } else { 0 }))
  }
  $null
}

function ConvertTo-GlibcVersion {
  <# "glibc 2.39" (getconf's own output) or "2.35" as major.minor.patch, the patch 0 when absent; $null for anything else. #>
  param([string]$Text)
  if ("$Text" -match $script:GlibcPattern) {
    return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $(if ($Matches[3]) { $Matches[3] } else { 0 }))
  }
  $null
}

function Get-FileProductVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  (Get-Item -LiteralPath $Path).VersionInfo.ProductVersion
}

function Get-WslExePaths {
  $store = Join-Path $env:ProgramFiles 'WSL\wsl.exe'
  $inbox = Join-Path $env:SystemRoot 'System32\wsl.exe'
  [pscustomobject]@{
    Store = $(if (Test-Path -LiteralPath $store) { $store } else { $null })
    Inbox = $(if (Test-Path -LiteralPath $inbox) { $inbox } else { $null })
  }
}

function Get-WslVersionInfo {
  <#
    The Store/MSI WSL's file ProductVersion, never localized console text. Only
    when that cannot be read, `wsl.exe --version` (WSL_UTF8=1) is parsed for the
    first version-shaped token. The inbox WSL alone has no version.
  #>
  $paths = Get-WslExePaths
  if (-not $paths.Store) {
    return [pscustomobject]@{ Version = $null; Source = $(if ($paths.Inbox) { 'inbox' } else { 'none' }) }
  }
  $version = ConvertTo-WslVersion (Get-FileProductVersion -Path $paths.Store)
  if ($version) { return [pscustomobject]@{ Version = $version; Source = 'file' } }
  $run = Invoke-Native -FilePath $paths.Store -ArgumentList @('--version')
  [pscustomobject]@{ Version = $(if ($run.ExitCode -eq 0 -and $run.Output.Count -gt 0) { ConvertTo-WslVersion $run.Output[0] } else { $null }); Source = 'console' }
}

function Select-NetworkMode {
  <# Chosen FIRST [6b-R1]: mirrored only with a new enough WSL AND the user's consent to the .wslconfig change. #>
  param([version]$WslVersion, [Parameter(Mandatory = $true)][string]$MirroredMin, [bool]$ConsentMirrored)
  if ($WslVersion -and $WslVersion -ge (ConvertTo-WslVersion $MirroredMin) -and $ConsentMirrored) { 'mirrored' } else { 'nat' }
}

function Get-LxssDistros {
  <# THIS user's distros, from HKCU\...\Lxss: never parsed from localized `wsl -l` output. #>
  param([string]$Root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss')
  if (-not (Test-Path -LiteralPath $Root)) { return @() }
  $default = Get-PropertyValue (Get-ItemProperty -LiteralPath $Root -ErrorAction SilentlyContinue) 'DefaultDistribution'
  @(Get-ChildItem -LiteralPath $Root | ForEach-Object {
      $p = Get-ItemProperty -LiteralPath $_.PSPath
      [pscustomobject]@{
        Guid    = $_.PSChildName
        Name    = [string](Get-PropertyValue $p 'DistributionName')
        Version = [int](Get-PropertyValue $p 'Version')
        Default = ($_.PSChildName -eq $default)
      }
    })
}

function Get-PropertyValue {
  <# A property that may be absent (a registry value, a JSON field), without StrictMode throwing. #>
  param($Object, [Parameter(Mandatory = $true)][string]$Name)
  if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name } else { $null }
}

function Select-Distro {
  <# The requested distro; else the default when it is Ubuntu; else nothing (the installer asks). #>
  param([object[]]$Distros, [string]$Requested)
  if ($Requested) { return $Distros | Where-Object { $_.Name -eq $Requested } | Select-Object -First 1 }
  $Distros | Where-Object { $_.Default -and $_.Name -like 'Ubuntu*' } | Select-Object -First 1
}

function Get-DistroFacts {
  <# glibc, the default Linux user, uid and home, and free space in that home: each one --exec call. #>
  param([Parameter(Mandatory = $true)][string]$Distro)
  $glibc = Invoke-WslExec -Distro $Distro -Path '/usr/bin/getconf' -Arguments @('GNU_LIBC_VERSION')
  $user = Invoke-WslExec -Distro $Distro -Path '/usr/bin/id' -Arguments @('-un')
  $uid = Invoke-WslExec -Distro $Distro -Path '/usr/bin/id' -Arguments @('-u')
  $name = $(if ($user.ExitCode -eq 0) { "$($user.Output[0])".Trim() } else { '' })
  $linuxHome = ''
  $freeMB = $null
  if ($name) {
    $entry = Invoke-WslExec -Distro $Distro -User $name -Path '/usr/bin/getent' -Arguments @('passwd', $name)
    if ($entry.ExitCode -eq 0) { $linuxHome = ("$($entry.Output[0])" -split ':')[5] }
    if ($linuxHome) {
      $df = Invoke-WslExec -Distro $Distro -User $name -Path '/usr/bin/df' -Arguments @('-Pk', $linuxHome)
      if ($df.ExitCode -eq 0 -and $df.Output.Count -ge 2) { $freeMB = [math]::Floor([double](($df.Output[1] -split '\s+')[3]) / 1024) }
    }
  }
  [pscustomobject]@{
    Glibc  = $(if ($glibc.ExitCode -eq 0 -and $glibc.Output.Count -gt 0) { ConvertTo-GlibcVersion "$($glibc.Output[0])" } else { $null })
    User   = $name
    Uid    = $(if ($uid.ExitCode -eq 0) { [int]"$($uid.Output[0])".Trim() } else { $null })
    Home   = $linuxHome
    FreeMB = $freeMB
  }
}

# ---------------------------------------------------------------- .wslconfig

function Get-WslConfigPath { Join-Path $env:USERPROFILE '.wslconfig' }

function Get-WslConfigValue {
  param([string]$Path = (Get-WslConfigPath), [string]$Section = 'wsl2', [Parameter(Mandatory = $true)][string]$Key)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $current = ''
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*\[([^\]]+)\]\s*$') { $current = $Matches[1].Trim(); continue }
    if ($current -ieq $Section -and $line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*?)\s*$") { return $Matches[1] }
  }
  $null
}

function Set-WslConfigValue {
  <#
    Sets one key, with consent already given, keeping every other line as it was.
    The first change backs the file up as .wslconfig.rokid-backup, and each change
    is recorded (key, value, previous) so uninstall can tell whether it is still ours.
  #>
  param(
    [string]$Path = (Get-WslConfigPath),
    [string]$Section = 'wsl2',
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$Value,
    [string]$LogPath = (Get-RokidPaths).WslConfigLog
  )
  $previous = Get-WslConfigValue -Path $Path -Section $Section -Key $Key
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath $Path) {
    $backup = "$Path.rokid-backup"
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $Path -Destination $backup }
    foreach ($line in Get-Content -LiteralPath $Path) { $lines.Add($line) }
  }
  $current = ''
  $sectionAt = -1
  $done = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*\[([^\]]+)\]\s*$') { $current = $Matches[1].Trim(); if ($current -ieq $Section) { $sectionAt = $i }; continue }
    if ($current -ieq $Section -and $lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") { $lines[$i] = "$Key=$Value"; $done = $true; break }
  }
  if (-not $done) {
    if ($sectionAt -ge 0) { $lines.Insert($sectionAt + 1, "$Key=$Value") } else { $lines.Add("[$Section]"); $lines.Add("$Key=$Value") }
  }
  Write-Utf8File -Path $Path -Content (($lines -join "`r`n") + "`r`n")
  $log = @()
  if (Test-Path -LiteralPath $LogPath) { $log = @(Get-Content -LiteralPath $LogPath -Raw -Encoding UTF8 | ConvertFrom-Json) }
  if (-not ($log | Where-Object { $_.section -ieq $Section -and $_.key -ieq $Key })) {
    $log += [pscustomobject]@{ section = $Section; key = $Key; value = $Value; previous = $previous }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
  Write-Utf8File -Path $LogPath -Content (ConvertTo-Json -InputObject @($log) -Depth 3)
}

function Remove-WslConfigValue {
  param([string]$Path = (Get-WslConfigPath), [string]$Section = 'wsl2', [Parameter(Mandatory = $true)][string]$Key)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $current = ''
  $kept = foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*\[([^\]]+)\]\s*$') { $current = $Matches[1].Trim() }
    elseif ($current -ieq $Section -and $line -match "^\s*$([regex]::Escape($Key))\s*=") { continue }
    $line
  }
  Write-Utf8File -Path $Path -Content ((@($kept) -join "`r`n") + "`r`n")
}

function Restore-WslConfigChange {
  <#
    Uninstall step 4: only when networkingMode still holds the value setup set,
    and only when the person answers n to "Keep mirrored networking?", the
    earlier value is put back. No other key is touched.
  #>
  param(
    [string]$Path = (Get-WslConfigPath),
    [string]$LogPath = (Get-RokidPaths).WslConfigLog,
    [Parameter(Mandatory = $true)][scriptblock]$Ask
  )
  if (-not (Test-Path -LiteralPath $LogPath)) { return 'unchanged' }
  $change = @(Get-Content -LiteralPath $LogPath -Raw -Encoding UTF8 | ConvertFrom-Json) | Where-Object { $_.key -ieq 'networkingMode' } | Select-Object -First 1
  if (-not $change) { return 'unchanged' }
  if ((Get-WslConfigValue -Path $Path -Section $change.section -Key 'networkingMode') -ne $change.value) { return 'not-ours' }
  $answer = & $Ask 'Keep mirrored networking? [Y/n]'
  if ("$answer".Trim() -notmatch '^(n|no)$') { return 'kept' }
  if ($null -eq $change.previous) { Remove-WslConfigValue -Path $Path -Section $change.section -Key 'networkingMode' }
  else { Set-WslConfigValue -Path $Path -Section $change.section -Key 'networkingMode' -Value $change.previous -LogPath "$LogPath.restore" }
  'restored'
}

function Get-EffectiveNetworkingMode {
  <#
    What WSL actually runs, after the change and a restart: `wslinfo --networking-mode`.
    Mirrored can fall back to NAT silently, so it is checked, never assumed. Without
    wslinfo, mirrored means the distro's non-loopback IPv4 set equals the host's.
  #>
  param([Parameter(Mandatory = $true)][string]$Distro)
  $info = Invoke-WslExec -Distro $Distro -Path '/usr/bin/wslinfo' -Arguments @('--networking-mode')
  if ($info.ExitCode -eq 0 -and $info.Output.Count -gt 0) { return "$($info.Output[0])".Trim().ToLowerInvariant() }
  $inside = Invoke-WslExec -Distro $Distro -Path '/usr/bin/hostname' -Arguments @('-I')
  $distroIps = @(("$($inside.Output -join ' ')" -split '\s+') | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notlike '127.*' } | Sort-Object -Unique)
  $hostIps = @(Get-HostIPv4 | Sort-Object -Unique)
  if ($distroIps.Count -gt 0 -and -not (Compare-Object $distroIps $hostIps)) { 'mirrored' } else { 'nat' }
}

function Get-HostIPv4 {
  @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notlike 'vEthernet (WSL*' } | ForEach-Object { $_.IPAddress })
}

# ---------------------------------------------------------------- the machine plan (machine.ps1 only)

function ConvertTo-NetworkPrefix {
  param([Parameter(Mandatory = $true)][string]$Address, [Parameter(Mandatory = $true)][int]$PrefixLength)
  $bytes = ([Net.IPAddress]::Parse($Address)).GetAddressBytes()
  [Array]::Reverse($bytes)
  $value = [BitConverter]::ToUInt32($bytes, 0)
  $mask = $(if ($PrefixLength -eq 0) { [uint32]0 } else { [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $PrefixLength)) })
  $network = [BitConverter]::GetBytes([uint32]($value -band $mask))
  [Array]::Reverse($network)
  "$(([Net.IPAddress]$network).ToString())/$PrefixLength"
}

function Get-HostPrivatePrefixes {
  <# The IPv4 prefixes of the Private and Domain networks: the Hyper-V rules' scope, recomputed by every Repair. #>
  $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -in @('Private', 'DomainAuthenticated') })
  @(foreach ($p in $profiles) {
      Get-NetIPAddress -InterfaceIndex $p.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '169.254.*' } |
        ForEach-Object { ConvertTo-NetworkPrefix -Address $_.IPAddress -PrefixLength $_.PrefixLength }
    }) | Sort-Object -Unique
}

function Get-HyperVScope {
  if ($script:HyperVTakesLocalSubnet) { return @('LocalSubnet', $script:Tailnet) }
  @(Get-HostPrivatePrefixes) + @($script:Tailnet)
}

function Get-MachinePlan {
  <#
    Every machine-scope object for a mode, complete, with the mandatory -Name AND
    -DisplayName [6b-R7]. Data, not actions: machine.ps1 applies it, and the
    metadata test binds each entry against the real cmdlet.
  #>
  param([Parameter(Mandatory = $true)][ValidateSet('mirrored', 'nat')][string]$Mode, [string[]]$HyperVScope)
  $hostScope = @('LocalSubnet', $script:Tailnet)
  if ($Mode -eq 'mirrored') {
    if (-not $HyperVScope) { $HyperVScope = Get-HyperVScope }
    return @(
      [pscustomobject]@{ Kind = 'hyperv'; Name = 'RokidCoder-wss'; Cmdlet = 'New-NetFirewallHyperVRule'; Parameters = @{
          Name = 'RokidCoder-wss'; DisplayName = 'Rokid Coder (WSL) wss'; Direction = 'Inbound'; Action = 'Allow'; VMCreatorId = $script:WslVmCreatorId
          Protocol = 'TCP'; LocalPorts = @("$script:WssPort"); RemoteAddresses = $HyperVScope; Profiles = @('Private', 'Domain') } }
      [pscustomobject]@{ Kind = 'hyperv'; Name = 'RokidCoder-discovery'; Cmdlet = 'New-NetFirewallHyperVRule'; Parameters = @{
          Name = 'RokidCoder-discovery'; DisplayName = 'Rokid Coder (WSL) discovery replies'; Direction = 'Inbound'; Action = 'Allow'; VMCreatorId = $script:WslVmCreatorId
          Protocol = 'UDP'; RemotePorts = @("$script:DiscoveryPort"); RemoteAddresses = $HyperVScope; Profiles = @('Private', 'Domain') } }
      [pscustomobject]@{ Kind = 'firewall'; Name = 'RokidCoder-wss-host'; Cmdlet = 'New-NetFirewallRule'; Parameters = @{
          Name = 'RokidCoder-wss-host'; DisplayName = 'Rokid Coder wss'; Group = $script:FirewallGroup; Direction = 'Inbound'; Action = 'Allow'
          Protocol = 'TCP'; LocalPort = @("$script:WssPort"); RemoteAddress = $hostScope; Profile = @('Private', 'Domain') } }
      [pscustomobject]@{ Kind = 'firewall'; Name = 'RokidCoder-discovery-host'; Cmdlet = 'New-NetFirewallRule'; Parameters = @{
          Name = 'RokidCoder-discovery-host'; DisplayName = 'Rokid Coder discovery replies'; Group = $script:FirewallGroup; Direction = 'Inbound'; Action = 'Allow'
          Protocol = 'UDP'; RemotePort = @("$script:DiscoveryPort"); RemoteAddress = $hostScope; Profile = @('Private', 'Domain') } }
    )
  }
  @(
    [pscustomobject]@{ Kind = 'portproxy'; Name = "v4tov4 0.0.0.0:$script:NatPort"; Cmdlet = 'netsh.exe'; Parameters = @{
        ListenAddress = '0.0.0.0'; ListenPort = $script:NatPort; ConnectAddress = '127.0.0.1'; ConnectPort = $script:WssPort } }
    [pscustomobject]@{ Kind = 'firewall'; Name = 'RokidCoder-proxy'; Cmdlet = 'New-NetFirewallRule'; Parameters = @{
        Name = 'RokidCoder-proxy'; DisplayName = 'Rokid Coder proxy'; Group = $script:FirewallGroup; Direction = 'Inbound'; Action = 'Allow'
        Protocol = 'TCP'; LocalPort = @("$script:NatPort"); RemoteAddress = $hostScope; Profile = @('Private', 'Domain') } }
  )
}

function Get-Netsh { Join-Path $env:SystemRoot 'System32\netsh.exe' }

function Get-PortProxyEntries {
  <# The v4tov4 table, as numbers only: netsh's headers are localized, its rows are not. #>
  $run = Invoke-Native -FilePath (Get-Netsh) -ArgumentList @('interface', 'portproxy', 'show', 'v4tov4')
  @(foreach ($line in $run.Output) {
      if ($line -match '^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$') {
        [pscustomobject]@{ ListenAddress = $Matches[1]; ListenPort = [int]$Matches[2]; ConnectAddress = $Matches[3]; ConnectPort = [int]$Matches[4] }
      }
    })
}

function Test-PlanItemPresent {
  param([Parameter(Mandatory = $true)]$Item)
  switch ($Item.Kind) {
    'firewall' { [bool](Get-NetFirewallRule -Name $Item.Name -ErrorAction SilentlyContinue) }
    'hyperv' { [bool](Get-NetFirewallHyperVRule -Name $Item.Name -ErrorAction SilentlyContinue) }
    'portproxy' {
      $p = $Item.Parameters
      [bool](Get-PortProxyEntries | Where-Object { $_.ListenAddress -eq $p.ListenAddress -and $_.ListenPort -eq $p.ListenPort -and $_.ConnectAddress -eq $p.ConnectAddress -and $_.ConnectPort -eq $p.ConnectPort })
    }
  }
}

function Get-ParameterValue {
  <# One cmdlet parameter from a plan (a hashtable) or a recorded object (JSON): $null when absent. #>
  param($Parameters, [Parameter(Mandatory = $true)][string]$Name)
  if ($Parameters -is [Collections.IDictionary]) { if ($Parameters.Contains($Name)) { return $Parameters[$Name] } return $null }
  Get-PropertyValue $Parameters $Name
}

function ConvertTo-Hashtable {
  <# A recorded object's parameters, back into something New-NetFirewallRule @p can splat. #>
  param($Object)
  if ($Object -is [Collections.IDictionary]) { return $Object }
  $table = @{}
  if ($null -ne $Object) { foreach ($property in $Object.PSObject.Properties) { $table[$property.Name] = $property.Value } }
  $table
}

function ConvertTo-FilterValue {
  <#
    One filter as a comparable string: the sorted, lowercased set, 'any' when empty.
    -Address puts each IPv4 in its network/length form, whether Windows shows it as
    a mask (100.64.0.0/255.192.0.0), a length or a bare host; keywords stay as words.
    -Flags reads a profile set as names or as CIM's number (Domain 1, Private 2, Public 4).
  #>
  param($Values, [switch]$Address, [switch]$Flags)
  $list = @(foreach ($value in @($Values)) {
      foreach ($part in $(if ($Flags) { "$value" -split '\s*,\s*' } else { @("$value") })) {
        $text = $part.Trim()
        if ($text -eq '') { continue }
        if ($Flags -and $text -match '^\d+$') {
          $bits = [int]$text
          if ($bits -eq 0) { 'any' } else { foreach ($flag in @(@(1, 'domain'), @(2, 'private'), @(4, 'public'))) { if ($bits -band $flag[0]) { $flag[1] } } }
          continue
        }
        if ($Address -and $text -match '^(\d{1,3}(?:\.\d{1,3}){3})(?:/(\d{1,3}(?:\.\d{1,3}){3}|\d{1,2}))?$') {
          $length = 32
          if ($Matches[2] -and $Matches[2].Contains('.')) {
            $length = 0
            foreach ($byte in ([Net.IPAddress]::Parse($Matches[2])).GetAddressBytes()) { $length += ([Convert]::ToString($byte, 2) -replace '0', '').Length }
          } elseif ($Matches[2]) { $length = [int]$Matches[2] }
          ConvertTo-NetworkPrefix -Address $Matches[1] -PrefixLength $length
        } else { $text.ToLowerInvariant() }
      }
    })
  if ($list.Count -eq 0) { return 'any' }
  (@($list | Sort-Object -Unique) -join ',')
}

function ConvertTo-ProtocolValue {
  param($Value)
  switch ("$Value".Trim().ToLowerInvariant()) { '6' { 'tcp' } '17' { 'udp' } '' { 'any' } default { $_ } }
}

function Get-FirewallRuleFilter {
  <# A host rule's port and address filters, as Windows enforces them. #>
  param([Parameter(Mandatory = $true)]$Rule)
  [pscustomobject]@{ Port = ($Rule | Get-NetFirewallPortFilter); Address = ($Rule | Get-NetFirewallAddressFilter) }
}

function Get-ExpectedRuleFilter {
  <# What a plan rule must look like once Windows enforces it, in Get-EffectiveRuleFilter's terms. #>
  param([Parameter(Mandatory = $true)]$Item)
  $p = $Item.Parameters
  $filter = [ordered]@{
    Enabled   = 'true'
    Direction = ConvertTo-FilterValue (Get-ParameterValue $p 'Direction')
    Action    = ConvertTo-FilterValue (Get-ParameterValue $p 'Action')
    Protocol  = ConvertTo-ProtocolValue (Get-ParameterValue $p 'Protocol')
  }
  if ($Item.Kind -eq 'hyperv') {
    $filter.LocalPorts = ConvertTo-FilterValue (Get-ParameterValue $p 'LocalPorts')
    $filter.RemotePorts = ConvertTo-FilterValue (Get-ParameterValue $p 'RemotePorts')
    $filter.RemoteAddresses = ConvertTo-FilterValue (Get-ParameterValue $p 'RemoteAddresses') -Address
    $filter.VMCreatorId = ConvertTo-FilterValue (Get-ParameterValue $p 'VMCreatorId')
    $filter.Profiles = ConvertTo-FilterValue (Get-ParameterValue $p 'Profiles') -Flags
  } else {
    $filter.LocalPorts = ConvertTo-FilterValue (Get-ParameterValue $p 'LocalPort')
    $filter.RemotePorts = ConvertTo-FilterValue (Get-ParameterValue $p 'RemotePort')
    $filter.RemoteAddresses = ConvertTo-FilterValue (Get-ParameterValue $p 'RemoteAddress') -Address
    $filter.Profile = ConvertTo-FilterValue (Get-ParameterValue $p 'Profile') -Flags
  }
  $filter
}

function Get-EffectiveRuleFilter {
  <# The rule of the plan item's name as Windows enforces it (enabled, direction, protocol, ports, scope); $null when there is none. #>
  param([Parameter(Mandatory = $true)]$Item)
  if ($Item.Kind -eq 'hyperv') {
    $rule = Get-NetFirewallHyperVRule -Name $Item.Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rule) { return $null }
    return [ordered]@{
      Enabled         = ConvertTo-FilterValue (Get-PropertyValue $rule 'Enabled')
      Direction       = ConvertTo-FilterValue (Get-PropertyValue $rule 'Direction')
      Action          = ConvertTo-FilterValue (Get-PropertyValue $rule 'Action')
      Protocol        = ConvertTo-ProtocolValue (Get-PropertyValue $rule 'Protocol')
      LocalPorts      = ConvertTo-FilterValue (Get-PropertyValue $rule 'LocalPorts')
      RemotePorts     = ConvertTo-FilterValue (Get-PropertyValue $rule 'RemotePorts')
      RemoteAddresses = ConvertTo-FilterValue (Get-PropertyValue $rule 'RemoteAddresses') -Address
      VMCreatorId     = ConvertTo-FilterValue (Get-PropertyValue $rule 'VMCreatorId')
      Profiles        = ConvertTo-FilterValue (Get-PropertyValue $rule 'Profiles') -Flags
    }
  }
  $rule = Get-NetFirewallRule -Name $Item.Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $rule) { return $null }
  $filters = Get-FirewallRuleFilter -Rule $rule
  [ordered]@{
    Enabled         = ConvertTo-FilterValue (Get-PropertyValue $rule 'Enabled')
    Direction       = ConvertTo-FilterValue (Get-PropertyValue $rule 'Direction')
    Action          = ConvertTo-FilterValue (Get-PropertyValue $rule 'Action')
    Protocol        = ConvertTo-ProtocolValue (Get-PropertyValue $filters.Port 'Protocol')
    LocalPorts      = ConvertTo-FilterValue (Get-PropertyValue $filters.Port 'LocalPort')
    RemotePorts     = ConvertTo-FilterValue (Get-PropertyValue $filters.Port 'RemotePort')
    RemoteAddresses = ConvertTo-FilterValue (Get-PropertyValue $filters.Address 'RemoteAddress') -Address
    Profile         = ConvertTo-FilterValue (Get-PropertyValue $rule 'Profile') -Flags
  }
}

function Get-PlanItemDrift {
  <#
    How the machine differs from one plan item: @('absent'), the names of the filters
    that differ (a rule disabled, of the wrong direction, protocol, port or scope, or
    a Hyper-V scope from before the host's networks changed), or nothing when it matches.
  #>
  param([Parameter(Mandatory = $true)]$Item)
  if ($Item.Kind -eq 'portproxy') { if (Test-PlanItemPresent -Item $Item) { return } return 'absent' }
  $actual = Get-EffectiveRuleFilter -Item $Item
  if (-not $actual) { return 'absent' }
  $expected = Get-ExpectedRuleFilter -Item $Item
  foreach ($key in $expected.Keys) { if ($expected[$key] -ne $actual[$key]) { $key } }
}

function Test-MachineRuleSet {
  <# Preflight's firewall_rules: does the machine enforce the mode's whole set? Returns each missing or changed one. #>
  param([Parameter(Mandatory = $true)][ValidateSet('mirrored', 'nat')][string]$Mode)
  @(foreach ($item in Get-MachinePlan -Mode $Mode) {
      $drift = @(Get-PlanItemDrift -Item $item)
      if ($drift.Count -eq 0) { continue }
      if ($drift -contains 'absent') { $item.Name } else { "$($item.Name) ($($drift -join ', ') changed)" }
    })
}

function Read-MachineState {
  param([Parameter(Mandatory = $true)][string]$StatePath)
  if (-not (Test-Path -LiteralPath $StatePath)) { return [pscustomobject]@{ schema = 1; objects = @() } }
  $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  [pscustomobject]@{ schema = 1; objects = @($state.objects) }
}

function Write-MachineState {
  param([Parameter(Mandatory = $true)][string]$StatePath, [Parameter(Mandatory = $true)]$State)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StatePath) | Out-Null
  Write-Utf8File -Path $StatePath -Content (ConvertTo-Json -InputObject $State -Depth 8)
}

function New-PlanObject {
  <# Creates one firewall rule, Hyper-V rule or port proxy from its parameters; returns its ids. #>
  param([Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)]$Parameters)
  $p = ConvertTo-Hashtable $Parameters
  switch ($Kind) {
    'firewall' { $created = New-NetFirewallRule @p; @([string]$created.Name) }
    'hyperv' { $created = New-NetFirewallHyperVRule @p; @([string]$created.Name) }
    'portproxy' {
      $run = Invoke-Native -FilePath (Get-Netsh) -ArgumentList @('interface', 'portproxy', 'add', 'v4tov4', "listenaddress=$($p.ListenAddress)", "listenport=$($p.ListenPort)", "connectaddress=$($p.ConnectAddress)", "connectport=$($p.ConnectPort)")
      if ($run.ExitCode -ne 0) { throw "netsh portproxy add failed ($($run.ExitCode))" }
      @("$($p.ListenAddress):$($p.ListenPort)->$($p.ConnectAddress):$($p.ConnectPort)")
    }
  }
}

function Remove-PlanObject {
  <# Removes one recorded object by its name (a port proxy by its exact entry), and nothing else. #>
  param([Parameter(Mandatory = $true)]$Object)
  switch ($Object.kind) {
    'firewall' { Remove-NetFirewallRule -Name $Object.name -ErrorAction SilentlyContinue }
    'hyperv' { Remove-NetFirewallHyperVRule -Name $Object.name -ErrorAction SilentlyContinue }
    'portproxy' {
      $p = $Object.parameters
      $present = Get-PortProxyEntries | Where-Object { $_.ListenAddress -eq $p.ListenAddress -and $_.ListenPort -eq [int]$p.ListenPort -and $_.ConnectAddress -eq $p.ConnectAddress -and $_.ConnectPort -eq [int]$p.ConnectPort }
      if ($present) { Invoke-Native -FilePath (Get-Netsh) -ArgumentList @('interface', 'portproxy', 'delete', 'v4tov4', "listenaddress=$($p.ListenAddress)", "listenport=$($p.ListenPort)") | Out-Null }
    }
  }
}

function Undo-MachineObject {
  <#
    Takes one recorded object back out: removes it and, when it replaced an earlier
    run's rule, re-creates that rule from its recorded parameters and records it
    again. Returns the state without (or with the restored) entry.
  #>
  param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)]$Object)
  Remove-PlanObject -Object $Object
  $others = @(@($State.objects) | Where-Object { -not ($_.kind -eq $Object.kind -and $_.name -eq $Object.name) })
  $previous = Get-PropertyValue $Object 'previous'
  if ($previous) {
    $previous.ids = @(New-PlanObject -Kind $previous.kind -Parameters $previous.parameters)
    $others += $previous
  }
  $State.objects = $others
  $State
}

function Assert-MachineStatePath {
  param([Parameter(Mandatory = $true)][string]$StatePath)
  $root = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'RokidCoder'))
  if (-not [IO.Path]::GetFullPath($StatePath).StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "The machine state belongs under $root, not $StatePath"
  }
}

function Invoke-MachineApply {
  <#
    Reconciles the machine with the mode's plan, recording each change in
    machine-state.json with this run's id before making it:
    - a missing object is created;
    - a product-owned rule (one machine-state.json records) that Windows enforces
      differently (disabled, another direction, protocol, port or scope, or the
      Hyper-V scope of networks the host has left) is replaced, its earlier record
      kept as `previous`, so reverting this run re-creates it exactly;
    - a same-named rule nobody recorded that differs is never touched: Apply stops.
    A failure part-way undoes this call's changes, newest first, before it is
    rethrown, so a partial Apply leaves the machine as the call found it.
  #>
  param(
    [Parameter(Mandatory = $true)][ValidateSet('mirrored', 'nat')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$RunId
  )
  Assert-MachineStatePath -StatePath $StatePath
  $state = Read-MachineState -StatePath $StatePath
  # Every item is checked before anything changes.
  $work = @(foreach ($item in Get-MachinePlan -Mode $Mode) {
      $drift = @(Get-PlanItemDrift -Item $item)
      if ($drift.Count -eq 0) { continue }
      $owned = @($state.objects) | Where-Object { $_.kind -eq $item.Kind -and $_.name -eq $item.Name } | Select-Object -First 1
      $replace = $drift -notcontains 'absent'
      if ($replace -and -not $owned) {
        throw "A firewall rule named $($item.Name) exists that Rokid Coder did not create, and it differs from what Rokid Coder needs ($($drift -join ', ')). Remove it, then apply again."
      }
      [pscustomobject]@{ Item = $item; Owned = $owned; Replace = $replace }
    })
  $done = New-Object System.Collections.Generic.List[object]
  try {
    foreach ($step in $work) {
      $item = $step.Item
      $previous = $null
      if ($step.Replace) {
        $previous = [pscustomobject]@{ kind = $step.Owned.kind; name = $step.Owned.name; ids = @($step.Owned.ids); runId = $step.Owned.runId; mode = $step.Owned.mode; parameters = $step.Owned.parameters }
      }
      $entry = [pscustomobject]@{ kind = $item.Kind; name = $item.Name; ids = @(); runId = $RunId; mode = $Mode; parameters = $item.Parameters; previous = $previous }
      $state.objects = @(@($state.objects) | Where-Object { -not ($_.kind -eq $item.Kind -and $_.name -eq $item.Name) }) + $entry
      Write-MachineState -StatePath $StatePath -State $state
      $done.Add($entry)
      if ($step.Replace) { Remove-PlanObject -Object $step.Owned }
      $entry.ids = @(New-PlanObject -Kind $item.Kind -Parameters $item.Parameters)
      Write-MachineState -StatePath $StatePath -State $state
    }
  } catch {
    $failure = $_
    $leftover = @()
    for ($i = $done.Count - 1; $i -ge 0; $i--) {
      try { $state = Undo-MachineObject -State $state -Object $done[$i] } catch { $leftover += "$($done[$i].name): $($_.Exception.Message)" }
      Write-MachineState -StatePath $StatePath -State $state
    }
    if ($leftover.Count -gt 0) { throw "$($failure.Exception.Message); and this run's changes could not all be undone ($($leftover -join '; ')): they stay recorded for -Revert -RunId $RunId" }
    throw $failure
  }
}

function Invoke-MachineRevert {
  <#
    Removes what machine-state.json records, and nothing it does not: one run's
    objects, each replaced rule re-created as the earlier run recorded it; or -All,
    every recorded object.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [string]$RunId,
    [switch]$All
  )
  Assert-MachineStatePath -StatePath $StatePath
  if (-not $All -and -not $RunId) { throw 'Revert needs -RunId or -All' }
  $state = Read-MachineState -StatePath $StatePath
  if ($All) {
    foreach ($object in @($state.objects)) { Remove-PlanObject -Object $object }
    $state.objects = @()
  } else {
    foreach ($object in @(@($state.objects) | Where-Object { $_.runId -eq $RunId })) {
      $state = Undo-MachineObject -State $state -Object $object
      Write-MachineState -StatePath $StatePath -State $state
    }
  }
  Write-MachineState -StatePath $StatePath -State $state
}

function Invoke-MachineHelper {
  <# The ONE elevation: machine.ps1 through UAC, waited for. Returns its exit code. #>
  param(
    [Parameter(Mandatory = $true)][ValidateSet('Apply', 'Revert')][string]$Action,
    [string]$Mode,
    [string]$RunId,
    [switch]$All,
    [string]$Script = (Join-Path $script:Root 'machine.ps1')
  )
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script, "-$Action", '-StatePath', (Get-RokidPaths).MachineState)
  if ($Mode) { $argv += @('-Mode', $Mode) }
  if ($RunId) { $argv += @('-RunId', $RunId) }
  if ($All) { $argv += '-All' }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  (Start-Process -FilePath $powershell -ArgumentList (ConvertTo-CommandLine $argv) -Verb RunAs -Wait -PassThru).ExitCode
}

# ---------------------------------------------------------------- who is installing

function Get-ProcessUserSid { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

function Get-SessionOwnerSid {
  <# The owner of this session's explorer.exe: the person at the screen. #>
  $session = (Get-Process -Id $PID).SessionId
  $explorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe' AND SessionId=$session" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $explorer) { return $null }
  (Invoke-CimMethod -InputObject $explorer -MethodName GetOwnerSid).Sid
}

function Test-SessionUser {
  <# The installer binds the user it runs as; a different account than the session's would bind the wrong one. #>
  $owner = Get-SessionOwnerSid
  -not $owner -or $owner -eq (Get-ProcessUserSid)
}

function Assert-SessionUser {
  if (-not (Test-SessionUser)) { throw 'Run the installer from your own Windows account, not as another user' }
}

# ---------------------------------------------------------------- ports

function Get-HostListeners {
  param([int[]]$Ports)
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $Ports -contains [int]$_.LocalPort } | ForEach-Object {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$_.OwningProcess)" -ErrorAction SilentlyContinue
      [pscustomobject]@{ Side = 'host'; Port = [int]$_.LocalPort; Pid = [int]$_.OwningProcess; Name = [string]$(if ($p) { $p.Name } else { '' }); Path = [string]$(if ($p) { $p.ExecutablePath } else { '' }); CommandLine = [string]$(if ($p) { $p.CommandLine } else { '' }) }
    })
}

function Get-DistroListeners {
  <# `ss -Hltnp` in the distro, then each pid's exe link: who listens on the ports inside WSL. #>
  param([Parameter(Mandatory = $true)][string]$Distro, [Parameter(Mandatory = $true)][string]$User, [int[]]$Ports)
  $ss = Invoke-WslExec -Distro $Distro -User $User -Path '/usr/bin/ss' -Arguments @('-Hltnp')
  @(foreach ($line in $ss.Output) {
      if ($line -notmatch ':(\d+)\s') { continue }
      $port = [int]$Matches[1]
      if ($Ports -notcontains $port) { continue }
      $procId = $(if ($line -match 'pid=(\d+)') { [int]$Matches[1] } else { 0 })
      $exe = ''
      if ($procId) { $link = Invoke-WslExec -Distro $Distro -User $User -Path '/usr/bin/readlink' -Arguments @("/proc/$procId/exe"); if ($link.ExitCode -eq 0) { $exe = "$($link.Output[0])".Trim() } }
      [pscustomobject]@{ Side = 'wsl'; Port = $port; Pid = $procId; Name = ''; Path = $exe; CommandLine = '' }
    })
}

function Test-LegacyDaemon {
  param($Owner)
  $Owner.Side -eq 'host' -and $Owner.Name -ieq 'node.exe' -and $Owner.CommandLine -match '\\dist\\cli\.js"?\s+run(\s|$)'
}

function Get-PortOwnerClass {
  <#
    current: our recorded install (a node under the bundles root in WSL; the port proxy we recorded);
    legacy: 0.8.0's node.exe running ...\dist\cli.js run; relay: WSL's own forwarder; other: anyone else.
  #>
  param([Parameter(Mandatory = $true)]$Owner, [Parameter(Mandatory = $true)][string]$BundleRoot, [bool]$ProxyRecorded)
  if ($Owner.Side -eq 'wsl') { if ($Owner.Path -and $Owner.Path.StartsWith($BundleRoot)) { return 'current' } return 'other' }
  if ($script:RelayImages -contains $Owner.Name.ToLowerInvariant()) { return 'relay' }
  if (Test-LegacyDaemon -Owner $Owner) { return 'legacy' }
  if ($Owner.Port -eq $script:NatPort -and $Owner.Name -ieq 'svchost.exe' -and $ProxyRecorded) { return 'current' }
  'other'
}

# ---------------------------------------------------------------- preflight

function New-PreflightItem {
  param([string]$Id, [bool]$Ok, [string]$Detail, [string]$Fix = '', [bool]$Optional = $false, [string]$Action = '')
  [pscustomobject]@{ id = $Id; ok = $Ok; detail = $Detail; fix = $Fix; optional = $Optional; action = $Action }
}

function Get-WindowsBuild { [Environment]::OSVersion.Version.Build }

function Get-FreeSpaceMB {
  param([Parameter(Mandatory = $true)][string]$Path)
  $drive = (Get-Item -LiteralPath $Path).PSDrive
  [math]::Floor($drive.Free / 1MB)
}

function Invoke-Preflight {
  <#
    Every item that applies to the chosen mode, each {id, ok, detail, fix, optional, action}.
    The mode is chosen first; switching it runs this again.
  #>
  param(
    [Parameter(Mandatory = $true)][ValidateSet('mirrored', 'nat')][string]$Mode,
    [string]$DistroName,
    [switch]$RetireLegacy,
    $Requirements = (Get-WslRequirements)
  )
  $items = New-Object System.Collections.Generic.List[object]
  $build = Get-WindowsBuild
  $items.Add((New-PreflightItem 'windows_version' ($build -ge $Requirements.windowsMinBuild) "Windows build $build" 'Update to Windows 11 22H2 or later'))
  $paths = Get-WslExePaths
  $installed = [bool]($paths.Store -or $paths.Inbox)
  $items.Add((New-PreflightItem 'wsl_installed' $installed $(if ($paths.Store) { $paths.Store } elseif ($paths.Inbox) { $paths.Inbox } else { 'WSL is not installed' }) 'Run: wsl --install'))
  $wsl = Get-WslVersionInfo
  if ($Mode -eq 'mirrored') {
    $ok = [bool]($wsl.Version -and $wsl.Version -ge (ConvertTo-WslVersion $Requirements.mirroredMin))
    $detail = $(if ($wsl.Version) { "WSL $($wsl.Version) ($($wsl.Source))" } elseif ($wsl.Source -eq 'inbox') { 'the WSL built into Windows (no version)' } else { 'no WSL version' })
    $items.Add((New-PreflightItem 'wsl_version' $ok $detail "Run: wsl --update, or choose NAT networking (mirrored needs WSL $($Requirements.mirroredMin))"))
  } else {
    $items.Add((New-PreflightItem 'wsl_version' $installed $(if ($wsl.Version) { "WSL $($wsl.Version)" } else { "WSL ($($wsl.Source))" }) 'Run: wsl --install'))
  }
  $distros = @(Get-LxssDistros)
  $distro = Select-Distro -Distros $distros -Requested $DistroName
  if (-not $distro) {
    $names = ($distros | ForEach-Object { $_.Name }) -join ', '
    $items.Add((New-PreflightItem 'wsl_distro' $false $(if ($names) { "Choose a distro: $names" } else { 'No WSL distro' }) 'Run: wsl --install -d Ubuntu-24.04, or choose one'))
    return [pscustomobject]@{ mode = $Mode; distro = $null; items = @($items) }
  }
  $items.Add((New-PreflightItem 'wsl_distro' ($distro.Version -eq 2) "$($distro.Name) (WSL $($distro.Version))" "Convert it: wsl --set-version $($distro.Name) 2"))
  $facts = Get-DistroFacts -Distro $distro.Name
  $glibcMin = ConvertTo-GlibcVersion $Requirements.glibcMin
  if (-not $glibcMin) { throw "wsl-requirements.json: glibcMin '$($Requirements.glibcMin)' is not a version" }
  $items.Add((New-PreflightItem 'distro_glibc' ([bool]($facts.Glibc -and $facts.Glibc -ge $glibcMin)) $(if ($facts.Glibc) { "glibc $($facts.Glibc.Major).$($facts.Glibc.Minor)" } else { 'glibc not found' }) "Use Ubuntu 22.04 or later (glibc $($Requirements.glibcMin))"))
  $items.Add((New-PreflightItem 'distro_user' ([bool]($facts.User -and $facts.Uid -ne 0)) "default user $($facts.User) (uid $($facts.Uid))" "In the distro: sudo adduser <name>; sudo usermod -aG sudo <name>; then in Windows: $($distro.Name) config --default-user <name>"))
  $public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
  $items.Add((New-PreflightItem 'network_profile' ($public.Count -eq 0) $(if ($public.Count) { "Public: $(($public | ForEach-Object { $_.Name }) -join ', ')" } else { 'Private or Domain' }) 'Settings > Network & internet > (your network) > Private network'))
  if ($Mode -eq 'mirrored') {
    $effective = Get-EffectiveNetworkingMode -Distro $distro.Name
    $items.Add((New-PreflightItem 'wsl_mirrored_networking' ($effective -eq 'mirrored') "WSL runs $effective networking" 'Let the installer set networkingMode=mirrored in .wslconfig (WSL restarts)' -Action 'wslconfig'))
  } else {
    $forwarding = Get-WslConfigValue -Key 'localhostForwarding'
    $items.Add((New-PreflightItem 'wsl_localhost_forwarding' ("$forwarding" -ine 'false') "localhostForwarding=$(if ($null -eq $forwarding) { '(default true)' } else { $forwarding })" 'Let the installer set localhostForwarding=true in .wslconfig (WSL restarts)' -Action 'wslconfig'))
  }
  $missing = @(Test-MachineRuleSet -Mode $Mode)
  $items.Add((New-PreflightItem 'firewall_rules' ($missing.Count -eq 0) $(if ($missing.Count) { "missing or changed: $($missing -join ', ')" } else { 'present' }) 'Apply them (administrator)' -Action 'machine'))
  $ports = @($script:HttpPort, $script:WssPort) + $(if ($Mode -eq 'nat') { @($script:NatPort) } else { @() })
  $bundleRoot = "$($facts.Home)/.local/share/rokid-coder/"
  $proxyRecorded = [bool](@((Read-MachineState -StatePath (Get-RokidPaths).MachineState).objects) | Where-Object { $_.kind -eq 'portproxy' })
  $owners = @(Get-HostListeners -Ports $ports) + $(if ($facts.User) { @(Get-DistroListeners -Distro $distro.Name -User $facts.User -Ports $ports) } else { @() })
  $blocking = @()
  $legacy = @()
  foreach ($owner in $owners) {
    switch (Get-PortOwnerClass -Owner $owner -BundleRoot $bundleRoot -ProxyRecorded $proxyRecorded) {
      'other' { $blocking += $owner }
      'legacy' { $legacy += $owner }
    }
  }
  $portsOk = $blocking.Count -eq 0 -and ($legacy.Count -eq 0 -or $RetireLegacy)
  $portsDetail = $(if ($blocking.Count) { ($blocking | ForEach-Object { "port $($_.Port): pid $($_.Pid) $(if ($_.Name) { $_.Name } else { $_.Path })" }) -join '; ' } elseif ($legacy.Count) { "the old agentd (pid $($legacy[0].Pid)) holds port $($legacy[0].Port)" } else { 'free, or held by this install' })
  $items.Add((New-PreflightItem 'ports' $portsOk $portsDetail $(if ($blocking.Count) { 'Stop that program, then re-check' } else { 'Agree to replace the old agentd' })))
  $hostFree = Get-FreeSpaceMB -Path $env:LOCALAPPDATA
  $diskOk = $hostFree -ge $Requirements.minFreeMB -and $null -ne $facts.FreeMB -and $facts.FreeMB -ge $Requirements.minFreeMB
  $items.Add((New-PreflightItem 'disk_space' $diskOk "$hostFree MB free on Windows, $($facts.FreeMB) MB in $($facts.Home)" "Free $($Requirements.minFreeMB) MB on both"))
  [pscustomobject]@{ mode = $Mode; distro = $distro.Name; items = @($items) }
}

function Test-PreflightPassed {
  param([Parameter(Mandatory = $true)]$Result)
  -not (@($Result.items) | Where-Object { -not $_.ok -and -not $_.optional })
}

function Format-PreflightText {
  param([Parameter(Mandatory = $true)]$Result)
  $lines = foreach ($item in $Result.items) {
    $mark = $(if ($item.ok) { 'OK  ' } elseif ($item.optional) { 'NOTE' } else { 'FIX ' })
    "$mark $($item.id): $($item.detail)"
    if (-not $item.ok) { "       -> $($item.fix)" }
  }
  ($lines -join "`r`n")
}

# ---------------------------------------------------------------- staging [6b-R10, 6b-R21]

function New-Generation {
  param([Parameter(Mandatory = $true)][string]$Version, [datetime]$Now = (Get-Date))
  "$Version-$($Now.ToUniversalTime().ToString('yyyyMMddHHmmss'))"
}

function ConvertTo-XmlText { param([string]$Value) [Security.SecurityElement]::Escape($Value) }

function New-TaskXml {
  <#
    The \RokidCoder\agentd definition in the Task Scheduler schema's own values
    [6b-R17]: the SID as principal and logon trigger, InteractiveToken,
    LeastPrivilege, IgnoreNew, never stopped for battery, no time limit [6b-R22].
    Its action names this generation's launcher and binding, absolute and quoted.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Sid,
    [Parameter(Mandatory = $true)][string]$Distro,
    [Parameter(Mandatory = $true)][string]$Generation,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$Binding,
    [string]$SystemRoot = $env:SystemRoot,
    [string]$Template = (Join-Path $script:Root 'task.xml.template'),
    [string]$Command,
    [string]$Arguments
  )
  foreach ($path in $Launcher, $Binding) {
    if ($path -notmatch '^[A-Za-z]:\\' -or $path.Contains('~')) { throw "The task needs absolute Windows paths, not '$path'" }
  }
  if (-not $Command) { $Command = Join-Path $SystemRoot 'System32\conhost.exe' }
  if (-not $PSBoundParameters.ContainsKey('Arguments')) {
    $powershell = Join-Path $SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $Arguments = "--headless `"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Launcher`" -Binding `"$Binding`""
  }
  $xml = Get-Content -LiteralPath $Template -Raw -Encoding UTF8
  $xml = $xml.Replace('{{SID}}', (ConvertTo-XmlText $Sid))
  $xml = $xml.Replace('{{DISTRO}}', (ConvertTo-XmlText $Distro))
  $xml = $xml.Replace('{{GENERATION}}', (ConvertTo-XmlText $Generation))
  $xml = $xml.Replace('{{COMMAND}}', (ConvertTo-XmlText $Command))
  $xml.Replace('{{ARGUMENTS}}', (ConvertTo-XmlText $Arguments))
}

function Resolve-Binding {
  <# Who and where, resolved once per installer run (Repair re-resolves; logon never does). #>
  param(
    [Parameter(Mandatory = $true)]$Distro,
    [Parameter(Mandatory = $true)][ValidateSet('mirrored', 'nat')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Version
  )
  $user = Invoke-WslExec -Distro $Distro.Name -Path '/usr/bin/id' -Arguments @('-un')
  $uid = Invoke-WslExec -Distro $Distro.Name -Path '/usr/bin/id' -Arguments @('-u')
  if ($user.ExitCode -ne 0 -or $uid.ExitCode -ne 0) { throw "Could not read the default user of $($Distro.Name)" }
  $linuxUser = "$($user.Output[0])".Trim()
  $linuxUid = [int]"$($uid.Output[0])".Trim()
  if ($linuxUid -eq 0) { throw "The default user of $($Distro.Name) is root; add your own user first" }
  $entry = Invoke-WslExec -Distro $Distro.Name -User $linuxUser -Path '/usr/bin/getent' -Arguments @('passwd', $linuxUser)
  $linuxHome = ("$($entry.Output[0])" -split ':')[5]
  if ($entry.ExitCode -ne 0 -or -not $linuxHome -or -not $linuxHome.StartsWith('/')) { throw "Could not read the home of $linuxUser" }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  [ordered]@{
    windowsSid    = Get-ProcessUserSid
    windowsUser   = $identity.Name
    distroName    = $Distro.Name
    distroGuid    = $Distro.Guid
    linuxUser     = $linuxUser
    linuxUid      = $linuxUid
    linuxHome     = $linuxHome
    bundleDir     = "$linuxHome/.local/share/rokid-coder/$Version"
    agentdPath    = "$linuxHome/.rokid-coder/bin/agentd"
    wslExe        = Get-WslExe
    networkMode   = $Mode
    advertisePort = $(if ($Mode -eq 'nat') { $script:NatPort } else { $script:WssPort })
  }
}

function New-StagedGeneration {
  <#
    binding-<gen>.json, <gen>\start-agentd.ps1 and <gen>\task.xml: new files only.
    An existing file of the same name is never overwritten. Nothing is registered here:
    the task is registered only by rokid-setup's journaled step 9.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Generation,
    [Parameter(Mandatory = $true)]$Binding,
    $Paths = (Get-RokidPaths),
    [string]$LauncherSource = (Join-Path $script:Root 'start-agentd.ps1')
  )
  $genDir = Join-Path $Paths.InstallRoot $Generation
  $files = [pscustomobject]@{
    Generation = $Generation
    Binding    = Join-Path $Paths.DataRoot "binding-$Generation.json"
    Launcher   = Join-Path $genDir 'start-agentd.ps1'
    TaskXml    = Join-Path $genDir 'task.xml'
  }
  foreach ($file in $files.Binding, $files.Launcher, $files.TaskXml) {
    if (Test-Path -LiteralPath $file) { throw "$file already exists; a generation is never staged twice" }
  }
  New-Item -ItemType Directory -Force -Path $Paths.DataRoot, $genDir | Out-Null
  Write-Utf8File -Path $files.Binding -Content (ConvertTo-Json -InputObject $Binding -Depth 3)
  Copy-Item -LiteralPath $LauncherSource -Destination $files.Launcher
  $xml = New-TaskXml -Sid $Binding.windowsSid -Distro $Binding.distroName -Generation $Generation -Launcher $files.Launcher -Binding $files.Binding
  Write-Utf16File -Path $files.TaskXml -Content $xml
  $files
}

function Get-GenerationOf {
  param([string]$BindingPath)
  if ($BindingPath -match 'binding-(.+)\.json$') { $Matches[1] } else { $null }
}

function Remove-OldGenerations {
  <# After the commit point only: everything but the committed generation and its previous. #>
  param([Parameter(Mandatory = $true)][string[]]$Keep, $Paths = (Get-RokidPaths))
  foreach ($dir in @(Get-ChildItem -LiteralPath $Paths.InstallRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '-\d{14}$' })) {
    if ($Keep -notcontains $dir.Name) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
  }
  foreach ($file in @(Get-ChildItem -LiteralPath $Paths.DataRoot -Filter 'binding-*.json' -ErrorAction SilentlyContinue)) {
    if ($Keep -notcontains (Get-GenerationOf $file.Name)) { Remove-Item -LiteralPath $file.FullName -Force }
  }
}

# ---------------------------------------------------------------- the bundle and setup inside WSL

function Get-WslPath {
  param([Parameter(Mandatory = $true)]$Binding, [Parameter(Mandatory = $true)][string]$WindowsPath)
  $run = Invoke-WslExec -Distro $Binding.distroName -User $Binding.linuxUser -Path '/usr/bin/wslpath' -Arguments @('-u', $WindowsPath)
  if ($run.ExitCode -ne 0) { throw "wslpath -u failed for $WindowsPath" }
  "$($run.Output[0])".Trim()
}

function Install-BundleIntoDistro {
  <#
    The archive, unmodified, checked by sha256sum and unpacked by tar INSIDE the
    distro, into <linuxHome>/.local/share/rokid-coder/<v>/. An existing <v>/ whose
    bundle.json matches is reused (a Repair never extracts over a running install).
  #>
  param(
    [Parameter(Mandatory = $true)]$Binding,
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Sha256,
    [Parameter(Mandatory = $true)][string]$Generation
  )
  $run = { param($path, [string[]]$argv) Invoke-WslExec -Distro $Binding.distroName -User $Binding.linuxUser -Path $path -Arguments $argv }
  $tar = Get-WslPath -Binding $Binding -WindowsPath $Archive
  $sum = & $run '/usr/bin/sha256sum' @($tar)
  if ($sum.ExitCode -ne 0 -or ("$($sum.Output[0])" -split '\s+')[0] -ne $Sha256.ToLowerInvariant()) { throw 'The bundle archive does not match its digest' }
  $target = $Binding.bundleDir
  $partial = "$($target.Substring(0, $target.LastIndexOf('/')))/.partial-$Generation"
  if ((& $run '/usr/bin/mkdir' @('-p', $partial)).ExitCode -ne 0) { throw "Could not create $partial" }
  if ((& $run '/usr/bin/tar' @('-xzf', $tar, '-C', $partial)).ExitCode -ne 0) { throw 'The bundle could not be unpacked in WSL' }
  if ((& $run '/usr/bin/test' @('-d', $target)).ExitCode -eq 0) {
    $both = & $run '/usr/bin/sha256sum' @("$target/bundle.json", "$partial/bundle.json")
    $digests = @($both.Output | ForEach-Object { ("$_" -split '\s+')[0] })
    & $run '/usr/bin/rm' @('-rf', $partial) | Out-Null
    if ($both.ExitCode -ne 0 -or $digests.Count -ne 2 -or $digests[0] -ne $digests[1]) { throw "A different build of this version is installed in $target; uninstall it first" }
    return 'reused'
  }
  if ((& $run '/usr/bin/mv' @('-T', $partial, $target)).ExitCode -ne 0) { throw "Could not move the bundle into $target" }
  'extracted'
}

function Get-AdvertiseHosts {
  <# NAT mode's advertised hosts: Tailscale's IPv4 first, then each adapter with a default gateway. #>
  $hosts = New-Object System.Collections.Generic.List[string]
  $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $tailscale) {
    foreach ($line in (Invoke-Native -FilePath $tailscale -ArgumentList @('ip', '-4')).Output) { if ($line.Trim() -match '^\d{1,3}(\.\d{1,3}){3}$') { $hosts.Add($line.Trim()) } }
  }
  foreach ($config in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' })) {
    foreach ($address in @($config.IPv4Address)) { if ($address.IPAddress -and -not $hosts.Contains($address.IPAddress)) { $hosts.Add($address.IPAddress) } }
  }
  @($hosts)
}

function Start-SetupWindow {
  <# rokid-setup install in a console window of its own: the CLI step and the pairing are interactive. #>
  param([Parameter(Mandatory = $true)]$Binding, [Parameter(Mandatory = $true)]$Staged)
  if ($env:ROKID_SETUP_TEST) {
    $env:WSLENV = (@($env:WSLENV, 'ROKID_SETUP_TEST/u', 'ROKID_SETUP_FAIL_AT/u') | Where-Object { $_ }) -join ':'
  }
  $argv = @('-d', $Binding.distroName, '-u', $Binding.linuxUser, '--exec', "$($Binding.bundleDir)/bin/rokid-setup", 'install', '--platform', 'wsl',
    '--bundle', $Binding.bundleDir, '--binding', (Get-WslPath -Binding $Binding -WindowsPath $Staged.Binding), '--task-xml', (Get-WslPath -Binding $Binding -WindowsPath $Staged.TaskXml))
  (Start-Process -FilePath $Binding.wslExe -ArgumentList (ConvertTo-CommandLine $argv) -Wait -PassThru).ExitCode
}

function Read-InstallManifest {
  <# install.json inside the binding's distro: the commit point of rokid-setup install. $null when absent or unreadable. #>
  param([Parameter(Mandatory = $true)]$Binding)
  $run = Invoke-WslExec -Distro $Binding.distroName -User $Binding.linuxUser -Path '/usr/bin/cat' -Arguments @("$($Binding.linuxHome)/.rokid-coder/install.json")
  if ($run.ExitCode -ne 0) { return $null }
  try { ($run.Output -join "`n") | ConvertFrom-Json } catch { $null }
}

function Get-RegisteredBindingPath {
  <# The binding the registered \RokidCoder\agentd task's action names; $null without the task. #>
  $task = Get-ScheduledTask -TaskPath $script:TaskPath -TaskName $script:TaskName -ErrorAction SilentlyContinue
  foreach ($action in @($(if ($task) { $task.Actions }))) {
    if ("$(Get-PropertyValue $action 'Arguments')" -match '-Binding "([^"]+)"') { return $Matches[1] }
  }
  $null
}

function Resolve-CommittedBinding {
  <#
    The binding the committed install was made with: the one its install.json names.
    The registered task's binding is asked first, then each staged one, newest first,
    so a failed Repair's newer binding (perhaps for another distro) is never taken
    for the install. $null when no distro holds a committed install.
  #>
  param($Paths = (Get-RokidPaths))
  $candidates = New-Object System.Collections.Generic.List[string]
  $registered = Get-RegisteredBindingPath
  if ($registered) { $candidates.Add($registered) }
  foreach ($file in @(Get-ChildItem -LiteralPath $Paths.DataRoot -Filter 'binding-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)) {
    if (-not ($candidates | Where-Object { $_ -ieq $file.FullName })) { $candidates.Add($file.FullName) }
  }
  $manifests = @{}
  foreach ($path in $candidates) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $binding = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $where = "$($binding.distroName)|$($binding.linuxUser)|$($binding.linuxHome)"
    if (-not $manifests.ContainsKey($where)) { $manifests[$where] = Read-InstallManifest -Binding $binding }
    $committed = Get-PropertyValue (Get-PropertyValue (Get-PropertyValue $manifests[$where] 'binding') 'bindingPath') 'win'
    if ($committed -and $committed -ieq $path) { return [pscustomobject]@{ Path = $path; Binding = $binding } }
  }
  $null
}

function Get-CommittedGenerations {
  <# The committed generation and its previous, from install.json inside the distro. #>
  param([Parameter(Mandatory = $true)]$Binding)
  $manifest = Read-InstallManifest -Binding $Binding
  if (-not $manifest) { return @() }
  $previous = Get-PropertyValue (Get-PropertyValue (Get-PropertyValue $manifest 'previous') 'manifest') 'binding'
  @(
    Get-GenerationOf (Get-PropertyValue (Get-PropertyValue (Get-PropertyValue $manifest 'binding') 'bindingPath') 'win')
    Get-GenerationOf (Get-PropertyValue (Get-PropertyValue $previous 'bindingPath') 'win')
  ) | Where-Object { $_ }
}

function Invoke-UserInstall {
  <#
    The per-user install after preflight: resolve, stage a NEW generation, put the
    bundle into WSL, then run rokid-setup install. NAT's advertised endpoint goes
    into the binding: rokid-setup writes it inside its transaction, after the
    quiesce and the snapshot, and a rollback puts the previous bytes back [6b-R3].
    Old generations are pruned only after it committed.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][ValidateSet('mirrored', 'nat')][string]$Mode,
    [Parameter(Mandatory = $true)]$Distro,
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Sha256,
    $Paths = (Get-RokidPaths),
    [datetime]$Now = (Get-Date)
  )
  Assert-SessionUser
  $binding = Resolve-Binding -Distro $Distro -Mode $Mode -Version $Version
  if ($Mode -eq 'nat') {
    $binding.advertiseHosts = @(Get-AdvertiseHosts)
    if ($binding.advertiseHosts.Count -eq 0) { throw 'This computer has no network with a default gateway to advertise' }
  }
  $generation = New-Generation -Version $Version -Now $Now
  $staged = New-StagedGeneration -Generation $generation -Binding $binding -Paths $Paths
  Install-BundleIntoDistro -Binding $binding -Archive $Archive -Sha256 $Sha256 -Generation $generation | Out-Null
  $code = Start-SetupWindow -Binding $binding -Staged $staged
  if ($code -ne 0) { return [pscustomobject]@{ ExitCode = $code; Generation = $generation; Staged = $staged } }
  $keep = @(Get-CommittedGenerations -Binding $binding)
  if ($keep -contains $generation) { Remove-OldGenerations -Keep $keep -Paths $Paths }
  [pscustomobject]@{ ExitCode = 0; Generation = $generation; Staged = $staged }
}

Export-ModuleMember -Function * -Variable @()
