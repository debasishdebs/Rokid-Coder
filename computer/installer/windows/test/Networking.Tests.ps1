BeforeAll {
  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
  $script:UserSetup = Join-Path $script:WindowsDir 'user-setup.ps1'
  $script:StartAgentd = Join-Path $script:WindowsDir 'start-agentd.ps1'
}

Describe 'networking' {
  BeforeEach { $script:saved = Use-TestProfile }
  AfterEach { Restore-TestProfile $script:saved }

  It 'mirrored_networking_change_needs_consent_and_preserves_other_keys' {
    Select-NetworkMode -WslVersion ([version]'2.3.26.0') -MirroredMin '2.0.9' -ConsentMirrored $false | Should -Be 'nat'
    $config = Join-Path $env:USERPROFILE '.wslconfig'
    $original = "# my settings`r`n[wsl2]`r`nmemory=8GB`r`nnetworkingMode=nat`r`n[experimental]`r`nautoMemoryReclaim=gradual`r`n"
    Write-Utf8File -Path $config -Content $original
    Set-WslConfigValue -Key 'networkingMode' -Value 'mirrored'
    $lines = Get-Content -LiteralPath $config
    $lines | Should -Contain '# my settings'
    $lines | Should -Contain 'memory=8GB'
    $lines | Should -Contain 'networkingMode=mirrored'
    $lines | Should -Not -Contain 'networkingMode=nat'
    $lines | Should -Contain '[experimental]'
    $lines | Should -Contain 'autoMemoryReclaim=gradual'
    [IO.File]::ReadAllText("$config.rokid-backup") | Should -Be $original
    $log = Get-Content -LiteralPath (Get-RokidPaths).WslConfigLog -Raw | ConvertFrom-Json
    $log.key | Should -Be 'networkingMode'
    $log.previous | Should -Be 'nat'
    # A file with no [wsl2] gets the section; the backup of the first original is never replaced.
    Remove-Item -LiteralPath $config, "$config.rokid-backup"
    Set-WslConfigValue -Key 'networkingMode' -Value 'mirrored'
    Get-Content -LiteralPath $config | Should -Be @('[wsl2]', 'networkingMode=mirrored')
  }

  It 'effective_mode_verified_after_shutdown_and_nat_detected' {
    $script:calls = New-Object System.Collections.Generic.List[string]
    $native = {
      $script:calls.Add(($ArgumentList -join ' '))
      if ($ArgumentList -contains '/usr/bin/wslinfo') { return [pscustomobject]@{ ExitCode = 0; Output = @('nat') } }
      [pscustomobject]@{ ExitCode = 0; Output = @() }
    }
    # user-setup.ps1 calls some of these itself (test scope) and the module calls others (module scope).
    Mock Assert-SessionUser { }
    Mock Get-LxssDistros { @([pscustomobject]@{ Guid = '{g}'; Name = 'Ubuntu'; Version = 2; Default = $true }) }
    Mock Invoke-Native $native
    Mock -ModuleName RokidCoder Invoke-Native $native
    & $script:UserSetup -ApplyWslConfig -Mode mirrored -Distro Ubuntu | Out-Null
    $LASTEXITCODE | Should -Be 3 -Because 'mirrored was set, but WSL fell back to NAT'
    $shutdown = $script:calls.IndexOf('--shutdown')
    $shutdown | Should -BeGreaterOrEqual 0
    $check = @($script:calls) | Where-Object { $_ -like '*/usr/bin/wslinfo --networking-mode' } | Select-Object -First 1
    $script:calls.IndexOf($check) | Should -BeGreaterThan $shutdown -Because 'the effective mode is read after the restart'

    # Without wslinfo: mirrored only when the distro's IPv4s are the host's.
    Mock -ModuleName RokidCoder Get-HostIPv4 { @('192.168.1.40') }
    Mock -ModuleName RokidCoder Invoke-Native {
      if ($ArgumentList -contains '/usr/bin/wslinfo') { return [pscustomobject]@{ ExitCode = 127; Output = @() } }
      [pscustomobject]@{ ExitCode = 0; Output = @('172.28.1.5') }
    }
    Get-EffectiveNetworkingMode -Distro 'Ubuntu' | Should -Be 'nat'
    Mock -ModuleName RokidCoder Invoke-Native {
      if ($ArgumentList -contains '/usr/bin/wslinfo') { return [pscustomobject]@{ ExitCode = 127; Output = @() } }
      [pscustomobject]@{ ExitCode = 0; Output = @('192.168.1.40 ') }
    }
    Get-EffectiveNetworkingMode -Distro 'Ubuntu' | Should -Be 'mirrored'
  }

  It 'nat_fallback_proxy_targets_localhost_forwarding' {
    $plan = Get-MachinePlan -Mode nat
    $proxy = $plan | Where-Object Kind -eq 'portproxy'
    @($proxy).Count | Should -Be 1
    $proxy.Parameters.ListenAddress | Should -Be '0.0.0.0'
    $proxy.Parameters.ListenPort | Should -Be 8794
    $proxy.Parameters.ConnectAddress | Should -Be '127.0.0.1' -Because 'wslrelay forwards localhost, so a new WSL IP needs no refresh'
    $proxy.Parameters.ConnectPort | Should -Be 8792
    $script:netsh = New-Object System.Collections.Generic.List[string]
    Mock -ModuleName RokidCoder Invoke-Native { $script:netsh.Add(($ArgumentList -join ' ')); [pscustomobject]@{ ExitCode = 0; Output = @() } }
    Mock -ModuleName RokidCoder Get-NetFirewallRule { $null }
    Mock -ModuleName RokidCoder New-NetFirewallRule { [pscustomobject]@{ Name = $Name } }
    Invoke-MachineApply -Mode nat -StatePath (Get-RokidPaths).MachineState -RunId 'run-1'
    $script:netsh | Should -Contain 'interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8794 connectaddress=127.0.0.1 connectport=8792'
    Should -Invoke -ModuleName RokidCoder New-NetFirewallRule -Times 1 -Exactly -ParameterFilter { $Name -eq 'RokidCoder-proxy' -and $LocalPort -eq '8794' -and $Protocol -eq 'TCP' }
  }

  It 'localhost_forwarding_false_is_fixed_with_consent' {
    $config = Join-Path $env:USERPROFILE '.wslconfig'
    Write-Utf8File -Path $config -Content "[wsl2]`r`nlocalhostForwarding=false`r`nprocessors=4`r`n"
    Mock -ModuleName RokidCoder Get-WindowsBuild { 22631 }
    Mock -ModuleName RokidCoder Get-LxssDistros { @([pscustomobject]@{ Guid = '{g}'; Name = 'Ubuntu'; Version = 2; Default = $true }) }
    Mock -ModuleName RokidCoder Get-DistroFacts { [pscustomobject]@{ Glibc = (ConvertTo-GlibcVersion 'glibc 2.39'); User = 'zoe'; Uid = 1000; Home = '/home/zoe'; FreeMB = 50000 } }
    Mock -ModuleName RokidCoder Test-MachineRuleSet { @() }
    Mock -ModuleName RokidCoder Get-HostListeners { @() }
    Mock -ModuleName RokidCoder Get-DistroListeners { @() }
    Mock -ModuleName RokidCoder Get-NetConnectionProfile { }
    $item = (Invoke-Preflight -Mode nat).items | Where-Object id -eq 'wsl_localhost_forwarding'
    $item.ok | Should -BeFalse
    $item.action | Should -Be 'wslconfig'
    Mock Assert-SessionUser { }
    Mock Get-LxssDistros { @([pscustomobject]@{ Guid = '{g}'; Name = 'Ubuntu'; Version = 2; Default = $true }) }
    Mock Invoke-Native { [pscustomobject]@{ ExitCode = 0; Output = @() } }
    & $script:UserSetup -ApplyWslConfig -Mode nat -Distro Ubuntu | Out-Null
    $LASTEXITCODE | Should -Be 0
    Get-WslConfigValue -Key 'localhostForwarding' | Should -Be 'true'
    Get-WslConfigValue -Key 'processors' | Should -Be '4'
    Test-Path -LiteralPath "$config.rokid-backup" | Should -BeTrue
    Should -Invoke Invoke-Native -ParameterFilter { $ArgumentList -contains '--shutdown' }
  }

  It 'start_agentd_writes_advertise_only_in_nat_mode' {
    Mock Get-NetIPConfiguration { @([pscustomobject]@{ IPv4DefaultGateway = [pscustomobject]@{ NextHop = '192.168.1.1' }; NetAdapter = [pscustomobject]@{ Status = 'Up' }; IPv4Address = @([pscustomobject]@{ IPAddress = '192.168.1.40' }) }) }
    foreach ($mode in 'nat', 'mirrored') {
      $fake = New-FakeWsl
      $binding = New-TestBinding -Mode $mode
      $binding.wslExe = $fake.Path
      $file = Join-Path $TestDrive "binding-$mode.json"
      Write-Utf8File -Path $file -Content (ConvertTo-Json -InputObject $binding)
      & $script:StartAgentd -Binding $file
      $calls = Get-FakeWslCalls $fake
      if ($mode -eq 'nat') {
        $calls.Count | Should -Be 2
        $calls[0] | Should -BeLike '*-d Ubuntu -u zoe --exec "/home/zoe smith/.local/share/rokid-coder/1.0.0/bin/rokid-setup" advertise set --hosts 192.168.1.40 --port 8794*'
      } else {
        $calls.Count | Should -Be 1 -Because 'mirrored mode advertises nothing'
      }
      $calls[-1] | Should -BeLike '*-d Ubuntu -u zoe --exec "/home/zoe smith/.rokid-coder/bin/agentd" run*'
    }
  }

  It 'wsl_calls_use_exec_with_argv_not_shell_strings' {
    $script:wsl = New-Object System.Collections.Generic.List[object]
    Mock -ModuleName RokidCoder Invoke-Native {
      if ($FilePath -like '*wsl.exe') { $script:wsl.Add(@($ArgumentList)) }
      $out = switch -Wildcard ($ArgumentList -join ' ') {
        '*/usr/bin/id -un' { 'zoe' }
        '*/usr/bin/id -u' { '1000' }
        '*/usr/bin/getent passwd zoe' { 'zoe:x:1000:1000:Zoe:/home/zoe smith:/bin/bash' }
        '*/usr/bin/wslpath -u *' { '/mnt/c/Users/zoe/AppData/Local/Temp/bundle.tar.gz' }
        '*/usr/bin/sha256sum /mnt/*' { 'abc123  /mnt/c/Users/zoe/AppData/Local/Temp/bundle.tar.gz' }
        '*/usr/bin/test -d *' { }
        default { }
      }
      $code = $(if (($ArgumentList -join ' ') -like '*/usr/bin/test -d *') { 1 } else { 0 })
      [pscustomobject]@{ ExitCode = $code; Output = @($out) }
    }
    $distro = [pscustomobject]@{ Guid = '{g}'; Name = 'Ubuntu'; Version = 2; Default = $true }
    $binding = Resolve-Binding -Distro $distro -Mode nat -Version '1.0.0'
    $binding.linuxHome | Should -Be '/home/zoe smith'
    $binding.agentdPath | Should -Be '/home/zoe smith/.rokid-coder/bin/agentd'
    Install-BundleIntoDistro -Binding $binding -Archive 'C:\Users\zoe\AppData\Local\Temp\bundle.tar.gz' -Sha256 'ABC123' -Generation '1.0.0-20261115100000' | Should -Be 'extracted'
    Get-DistroFacts -Distro 'Ubuntu' | Out-Null
    Get-EffectiveNetworkingMode -Distro 'Ubuntu' | Out-Null
    $script:wsl.Count | Should -BeGreaterThan 8
    foreach ($argv in $script:wsl) {
      $at = [array]::IndexOf($argv, '--exec')
      $at | Should -BeGreaterThan 0 -Because "every WSL call is --exec: $($argv -join ' ')"
      $argv[$at + 1] | Should -Match '^/' -Because 'with an absolute path'
      $argv[$at + 1] | Should -Not -Match '/(ba)?sh$'
      $argv | Should -Not -Contain '-c'
      ($argv -join ' ') | Should -Not -Match '~'
    }
    { Invoke-WslExec -Distro 'Ubuntu' -Path 'bin/agentd' } | Should -Throw '*absolute*'
    { Invoke-WslExec -Distro 'Ubuntu' -Path '~/.rokid-coder/bin/agentd' } | Should -Throw '*absolute*'
  }
}
