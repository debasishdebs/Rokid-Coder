BeforeAll {
  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')

  function Set-HealthyMachine {
    Mock -ModuleName RokidCoder Get-WindowsBuild { 22631 }
    Mock -ModuleName RokidCoder Get-WslExePaths { [pscustomobject]@{ Store = 'C:\Program Files\WSL\wsl.exe'; Inbox = 'C:\Windows\System32\wsl.exe' } }
    Mock -ModuleName RokidCoder Get-WslVersionInfo { [pscustomobject]@{ Version = [version]'2.3.26.0'; Source = 'file' } }
    Mock -ModuleName RokidCoder Get-LxssDistros { @([pscustomobject]@{ Guid = '{g}'; Name = 'Ubuntu'; Version = 2; Default = $true }) }
    Mock -ModuleName RokidCoder Get-DistroFacts { [pscustomobject]@{ Glibc = [version]'2.39.0.0'; User = 'zoe'; Uid = 1000; Home = '/home/zoe'; FreeMB = 50000 } }
    Mock -ModuleName RokidCoder Get-NetConnectionProfile { [pscustomobject]@{ Name = 'Home'; NetworkCategory = 'Private'; InterfaceIndex = 5 } }
    Mock -ModuleName RokidCoder Get-EffectiveNetworkingMode { 'mirrored' }
    Mock -ModuleName RokidCoder Get-WslConfigValue { $null }
    Mock -ModuleName RokidCoder Test-MachineRuleSet { @() }
    Mock -ModuleName RokidCoder Get-HostListeners { @() }
    Mock -ModuleName RokidCoder Get-DistroListeners { @() }
    Mock -ModuleName RokidCoder Read-MachineState { [pscustomobject]@{ schema = 1; objects = @() } }
    Mock -ModuleName RokidCoder Get-FreeSpaceMB { 100000 }
  }
  function Get-Item-Of { param($Result, $Id) @($Result.items) | Where-Object { $_.id -eq $Id } }
}

Describe 'preflight' {
  BeforeEach { Set-HealthyMachine }

  It 'preflight_reports_each_windows_requirement_with_fix' {
    $common = 'windows_version', 'wsl_installed', 'wsl_version', 'wsl_distro', 'distro_glibc', 'distro_user', 'network_profile', 'firewall_rules', 'ports', 'disk_space'
    $mirrored = Invoke-Preflight -Mode mirrored
    $nat = Invoke-Preflight -Mode nat
    @($mirrored.items.id) | Sort-Object | Should -Be (@($common + 'wsl_mirrored_networking') | Sort-Object)
    @($nat.items.id) | Sort-Object | Should -Be (@($common + 'wsl_localhost_forwarding') | Sort-Object)
    foreach ($item in @($mirrored.items) + @($nat.items)) {
      @($item.PSObject.Properties.Name) | Should -Contain 'optional'
      $item.ok | Should -BeTrue -Because "$($item.id) passes on a healthy machine"
      $item.fix | Should -Not -BeNullOrEmpty -Because "$($item.id) says how to fix it"
      $item.detail | Should -Not -BeNullOrEmpty
    }
    Test-PreflightPassed -Result $mirrored | Should -BeTrue
    # And each one fails, with its fix shown, when its requirement is not met.
    Mock -ModuleName RokidCoder Get-WindowsBuild { 19045 }
    Mock -ModuleName RokidCoder Get-DistroFacts { [pscustomobject]@{ Glibc = [version]'2.31.0.0'; User = 'root'; Uid = 0; Home = '/root'; FreeMB = 10 } }
    Mock -ModuleName RokidCoder Test-MachineRuleSet { @('RokidCoder-proxy') }
    Mock -ModuleName RokidCoder Get-FreeSpaceMB { 100 }
    $bad = Invoke-Preflight -Mode nat
    foreach ($id in 'windows_version', 'distro_glibc', 'distro_user', 'firewall_rules', 'disk_space') { (Get-Item-Of $bad $id).ok | Should -BeFalse -Because $id }
    (Get-Item-Of $bad 'distro_user').fix | Should -Match 'adduser'
    (Get-Item-Of $bad 'firewall_rules').action | Should -Be 'machine'
    Test-PreflightPassed -Result $bad | Should -BeFalse
    Format-PreflightText -Result $bad | Should -Match 'FIX  windows_version'
  }

  It 'inbox_wsl_fails_with_update_fix' {
    Mock -ModuleName RokidCoder Get-WslExePaths { [pscustomobject]@{ Store = $null; Inbox = 'C:\Windows\System32\wsl.exe' } }
    Mock -ModuleName RokidCoder Get-WslVersionInfo { [pscustomobject]@{ Version = $null; Source = 'inbox' } }
    $item = Get-Item-Of (Invoke-Preflight -Mode mirrored) 'wsl_version'
    $item.ok | Should -BeFalse
    $item.fix | Should -Match 'wsl --update'
    $item.fix | Should -Match 'NAT'
    # NAT mode takes the inbox WSL.
    (Get-Item-Of (Invoke-Preflight -Mode nat) 'wsl_version').ok | Should -BeTrue
  }

  It 'distro_read_from_hkcu_lxss_and_wsl1_rejected' {
    $root = 'TestRegistry:\Lxss'
    New-Item -Path $root -Force | Out-Null
    New-ItemProperty -Path $root -Name DefaultDistribution -Value '{aaaa}' | Out-Null
    New-Item -Path "$root\{aaaa}" -Force | Out-Null
    New-ItemProperty -Path "$root\{aaaa}" -Name DistributionName -Value 'Ubuntu-24.04' | Out-Null
    New-ItemProperty -Path "$root\{aaaa}" -Name Version -Value 2 -PropertyType DWord | Out-Null
    New-Item -Path "$root\{bbbb}" -Force | Out-Null
    New-ItemProperty -Path "$root\{bbbb}" -Name DistributionName -Value 'Legacy' | Out-Null
    New-ItemProperty -Path "$root\{bbbb}" -Name Version -Value 1 -PropertyType DWord | Out-Null
    $script:distros = Get-LxssDistros -Root $root
    $script:distros.Count | Should -Be 2
    (Select-Distro -Distros $script:distros).Name | Should -Be 'Ubuntu-24.04'
    (Select-Distro -Distros $script:distros -Requested 'Legacy').Version | Should -Be 1
    Mock -ModuleName RokidCoder Get-LxssDistros { $script:distros }
    $item = Get-Item-Of (Invoke-Preflight -Mode nat -DistroName 'Legacy') 'wsl_distro'
    $item.ok | Should -BeFalse
    $item.fix | Should -Match 'wsl --set-version Legacy 2'
    # A default that is not Ubuntu is not guessed: the installer asks.
    Mock -ModuleName RokidCoder Get-LxssDistros { @([pscustomobject]@{ Guid = '{c}'; Name = 'Debian'; Version = 2; Default = $true }) }
    $none = Invoke-Preflight -Mode nat
    (Get-Item-Of $none 'wsl_distro').detail | Should -Match 'Choose a distro: Debian'
  }

  It 'public_network_profile_flagged' {
    Mock -ModuleName RokidCoder Get-NetConnectionProfile { @([pscustomobject]@{ Name = 'Cafe WiFi'; NetworkCategory = 'Public'; InterfaceIndex = 7 }) }
    $item = Get-Item-Of (Invoke-Preflight -Mode mirrored) 'network_profile'
    $item.ok | Should -BeFalse
    $item.detail | Should -Match 'Cafe WiFi'
    $item.fix | Should -Match 'Private'
  }

  It 'nat_mode_install_on_wsl_below_mirrored_min' {
    Select-NetworkMode -WslVersion ([version]'1.2.5.0') -MirroredMin '2.0.9' -ConsentMirrored $true | Should -Be 'nat'
    Mock -ModuleName RokidCoder Get-WslVersionInfo { [pscustomobject]@{ Version = [version]'1.2.5.0'; Source = 'file' } }
    $result = Invoke-Preflight -Mode nat
    Test-PreflightPassed -Result $result | Should -BeTrue
    (Get-Item-Of (Invoke-Preflight -Mode mirrored) 'wsl_version').ok | Should -BeFalse
  }

  It 'declined_mirrored_selects_nat_and_skips_mirrored_items' {
    Select-NetworkMode -WslVersion ([version]'2.3.26.0') -MirroredMin '2.0.9' -ConsentMirrored $false | Should -Be 'nat'
    Select-NetworkMode -WslVersion ([version]'2.3.26.0') -MirroredMin '2.0.9' -ConsentMirrored $true | Should -Be 'mirrored'
    $result = Invoke-Preflight -Mode nat
    @($result.items.id) | Should -Not -Contain 'wsl_mirrored_networking'
    Should -Invoke -ModuleName RokidCoder Get-EffectiveNetworkingMode -Times 0 -Exactly
    Should -Invoke -ModuleName RokidCoder Test-MachineRuleSet -ParameterFilter { $Mode -eq 'nat' }
  }

  It 'ports_classifies_current_legacy_and_other_owners' {
    $root = '/home/zoe/.local/share/rokid-coder/'
    Get-PortOwnerClass -Owner ([pscustomobject]@{ Side = 'wsl'; Port = 8792; Pid = 10; Name = ''; Path = '/home/zoe/.local/share/rokid-coder/1.0.0/node/bin/node'; CommandLine = '' }) -BundleRoot $root | Should -Be 'current'
    Get-PortOwnerClass -Owner ([pscustomobject]@{ Side = 'wsl'; Port = 8792; Pid = 11; Name = ''; Path = '/usr/bin/node'; CommandLine = '' }) -BundleRoot $root | Should -Be 'other'
    $script:legacy = [pscustomobject]@{ Side = 'host'; Port = 8791; Pid = 4242; Name = 'node.exe'; Path = 'C:\Program Files\nodejs\node.exe'; CommandLine = '"C:\Program Files\nodejs\node.exe" "C:\src\agentd\dist\cli.js" run' }
    Get-PortOwnerClass -Owner $script:legacy -BundleRoot $root | Should -Be 'legacy'
    Get-PortOwnerClass -Owner ([pscustomobject]@{ Side = 'host'; Port = 8792; Pid = 50; Name = 'wslrelay.exe'; Path = ''; CommandLine = '' }) -BundleRoot $root | Should -Be 'relay'
    Get-PortOwnerClass -Owner ([pscustomobject]@{ Side = 'host'; Port = 8794; Pid = 900; Name = 'svchost.exe'; Path = ''; CommandLine = '' }) -BundleRoot $root -ProxyRecorded $true | Should -Be 'current'
    Get-PortOwnerClass -Owner ([pscustomobject]@{ Side = 'host'; Port = 8794; Pid = 900; Name = 'svchost.exe'; Path = ''; CommandLine = '' }) -BundleRoot $root -ProxyRecorded $false | Should -Be 'other'
    Get-PortOwnerClass -Owner ([pscustomobject]@{ Side = 'host'; Port = 8792; Pid = 77; Name = 'node.exe'; Path = 'C:\x\node.exe'; CommandLine = 'node server.js' }) -BundleRoot $root | Should -Be 'other'

    Mock -ModuleName RokidCoder Get-HostListeners { @($script:legacy) }
    (Get-Item-Of (Invoke-Preflight -Mode mirrored) 'ports').ok | Should -BeFalse -Because 'legacy passes only once its retire is consented'
    (Get-Item-Of (Invoke-Preflight -Mode mirrored -RetireLegacy) 'ports').ok | Should -BeTrue
    Mock -ModuleName RokidCoder Get-HostListeners { @([pscustomobject]@{ Side = 'host'; Port = 8792; Pid = 77; Name = 'other.exe'; Path = 'C:\x\other.exe'; CommandLine = '' }) }
    $blocked = Get-Item-Of (Invoke-Preflight -Mode mirrored -RetireLegacy) 'ports'
    $blocked.ok | Should -BeFalse
    $blocked.detail | Should -Match 'pid 77 other.exe'
  }

  It 'upgrade_with_running_daemon_passes_preflight' {
    Mock -ModuleName RokidCoder Get-DistroListeners { @(8791, 8792 | ForEach-Object { [pscustomobject]@{ Side = 'wsl'; Port = $_; Pid = 321; Name = ''; Path = '/home/zoe/.local/share/rokid-coder/1.0.0/node/bin/node'; CommandLine = '' } }) }
    Mock -ModuleName RokidCoder Get-HostListeners { @([pscustomobject]@{ Side = 'host'; Port = 8792; Pid = 50; Name = 'wslrelay.exe'; Path = ''; CommandLine = '' }) }
    (Get-Item-Of (Invoke-Preflight -Mode nat) 'ports').ok | Should -BeTrue
  }
}

Describe 'the WSL version' {
  It 'wsl_version_read_from_file_version_not_localized_output' {
    Mock -ModuleName RokidCoder Get-WslExePaths { [pscustomobject]@{ Store = 'C:\Program Files\WSL\wsl.exe'; Inbox = $null } }
    Mock -ModuleName RokidCoder Get-FileProductVersion { '2.3.26.0' }
    Mock -ModuleName RokidCoder Invoke-Native { [pscustomobject]@{ ExitCode = 0; Output = @('WSL-Version: 9.9.9.9') } }
    $info = Get-WslVersionInfo
    $info.Version | Should -Be ([version]'2.3.26.0')
    $info.Source | Should -Be 'file'
    Should -Invoke -ModuleName RokidCoder Invoke-Native -Times 0 -Exactly
    # Only without a file version is the console read, and then only its version-shaped token (German here).
    Mock -ModuleName RokidCoder Get-FileProductVersion { $null }
    Mock -ModuleName RokidCoder Invoke-Native { [pscustomobject]@{ ExitCode = 0; Output = @('WSL-Version: 2.0.9.0', 'Kernelversion: 5.15.133.1-1') } }
    $fallback = Get-WslVersionInfo
    $fallback.Version | Should -Be ([version]'2.0.9.0')
    $fallback.Source | Should -Be 'console'
    Should -Invoke -ModuleName RokidCoder Invoke-Native -Times 1 -Exactly -ParameterFilter { $ArgumentList -contains '--version' }
  }
}
