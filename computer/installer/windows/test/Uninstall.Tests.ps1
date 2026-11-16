BeforeAll {
  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
  $script:Uninstall = Join-Path $script:WindowsDir 'uninstall.ps1'

  # A mock body's $script: is the scope of whichever script runs it (machine.ps1, user-setup.ps1,
  # uninstall.ps1), not this file's: what the mocks and the test share is global.
  # install.json per distro (what `cat ~/.rokid-coder/install.json` prints), and the registered task's -Binding.
  $global:RokidTestManifests = @{}
  $global:RokidTestTaskBinding = $null
  # $global:RokidTestUnreadable: distros whose install.json is there but cat cannot read it; $global:RokidTestWslBroken: wsl.exe runs nothing.
  $global:RokidTestUnreadable = @{}; $global:RokidTestUnsearchable = @{}
  $global:RokidTestWslBroken = $false
  $script:fakeWsl = {
    if ($global:RokidTestWslBroken) { return [pscustomobject]@{ ExitCode = 1; Output = @() } }
    if ($Path -eq '/usr/bin/true') { return [pscustomobject]@{ ExitCode = 0; Output = @() } }
    if ($Path -eq '/usr/bin/test' -and $Arguments[0] -eq '-x') {
      return [pscustomobject]@{ ExitCode = $(if ($global:RokidTestUnsearchable[$Distro]) { 1 } else { 0 }); Output = @() }
    }
    if ($Path -eq '/usr/bin/test' -and $Arguments[0] -eq '-e') {
      return [pscustomobject]@{ ExitCode = $(if ($global:RokidTestManifests[$Distro] -or $global:RokidTestUnreadable[$Distro]) { 0 } else { 1 }); Output = @() }
    }
    if ($Path -eq '/usr/bin/cat') {
      $manifest = $global:RokidTestManifests[$Distro]
      if ($manifest -and -not $global:RokidTestUnreadable[$Distro]) { return [pscustomobject]@{ ExitCode = 0; Output = @($manifest) } }
      return [pscustomobject]@{ ExitCode = 1; Output = @() }
    }
    $global:RokidTestWsl.Add("$Distro|$User|$Path|$($Arguments -join ' ')")
    [pscustomobject]@{ ExitCode = $global:RokidTestSetupExit; Output = @('Rokid Coder was removed. Your pairings and settings were kept') }
  }
  $script:fakeTask = {
    if (-not $global:RokidTestTaskBinding) { return $null }
    [pscustomobject]@{ TaskPath = '\RokidCoder\'; TaskName = 'agentd'; Actions = @([pscustomobject]@{ Execute = 'C:\Windows\System32\conhost.exe'; Arguments = "--headless `"powershell.exe`" -File `"C:\x\start-agentd.ps1`" -Binding `"$global:RokidTestTaskBinding`"" }) }
  }

  function Set-Committed {
    <# What a committed install leaves: install.json naming the binding, and the task running it. #>
    param([Parameter(Mandatory = $true)]$Staged, [string]$Distro = 'Ubuntu', [switch]$NoTask)
    $global:RokidTestManifests[$Distro] = ConvertTo-Json -Compress -Depth 5 -InputObject @{ schema = 1; binding = @{ bindingPath = @{ win = $Staged.Binding; linux = '/mnt/c/x' } } }
    if (-not $NoTask) { $global:RokidTestTaskBinding = $Staged.Binding }
  }

  function New-InstalledLayout {
    $paths = Get-RokidPaths
    $binding = New-TestBinding -Mode nat
    $gen = '1.0.0-20261115100000'
    Set-Committed (New-StagedGeneration -Generation $gen -Binding $binding)
    New-Item -ItemType Directory -Force -Path $paths.Journal | Out-Null
    Write-Utf16File -Path (Join-Path $paths.Journal 'task-previous.xml') -Content '<Task/>'
    Write-MachineState -StatePath $paths.MachineState -State ([pscustomobject]@{ schema = 1; objects = @([pscustomobject]@{ kind = 'firewall'; name = 'RokidCoder-proxy'; ids = @('RokidCoder-proxy'); runId = 'a'; mode = 'nat'; parameters = @{} }) })
    $paths
  }
}

Describe 'uninstall' {
  BeforeEach {
    $script:saved = Use-TestProfile
    $global:RokidTestWsl = New-Object System.Collections.Generic.List[string]
    $global:RokidTestSetupExit = 0
    $global:RokidTestManifests = @{}
    $global:RokidTestUnreadable = @{}; $global:RokidTestUnsearchable = @{}
    $global:RokidTestWslBroken = $false
    $global:RokidTestTaskBinding = $null
    Mock Invoke-WslExec $script:fakeWsl
    Mock -ModuleName RokidCoder Invoke-WslExec $script:fakeWsl
    Mock -ModuleName RokidCoder Get-ScheduledTask $script:fakeTask
    Mock Get-ScheduledTask $script:fakeTask
    Mock -ModuleName RokidCoder Get-LxssDistros { @('Ubuntu', 'Ubuntu-24.04') | ForEach-Object { [pscustomobject]@{ Guid = "{$_}"; Name = $_; Version = 2; Default = ($_ -eq 'Ubuntu') } } }
    Mock Get-LxssDistros { @('Ubuntu', 'Ubuntu-24.04') | ForEach-Object { [pscustomobject]@{ Guid = "{$_}"; Name = $_; Version = 2; Default = ($_ -eq 'Ubuntu') } } }
    Mock Unregister-ScheduledTask { }
    Mock Invoke-MachineHelper { 0 }
    Mock Read-Host { 'y' }
  }
  AfterEach { Restore-TestProfile $script:saved }

  It 'uninstall_removes_task_proxy_firewall_and_plugins_keeps_state' {
    $paths = New-InstalledLayout
    & $script:Uninstall
    $LASTEXITCODE | Should -Be 0
    # 1: rokid-setup removes agentd, the plugins, wrappers, PATH block and bundles, and keeps state.
    $global:RokidTestWsl | Should -Be @('Ubuntu|zoe|/home/zoe smith/.rokid-coder/bin/rokid-setup|uninstall')
    # 2, 3: the task, then every recorded rule and the proxy, elevated.
    Should -Invoke Unregister-ScheduledTask -Times 1 -Exactly -ParameterFilter { $TaskPath -eq '\RokidCoder\' -and $TaskName -eq 'agentd' }
    Should -Invoke Invoke-MachineHelper -Times 1 -Exactly -ParameterFilter { $Action -eq 'Revert' -and $All }
    # 5: the generations, bindings and journal; nothing of the distro's state is touched here.
    @(Get-ChildItem -LiteralPath $paths.InstallRoot -Directory -ErrorAction SilentlyContinue) | Should -BeNullOrEmpty
    @(Get-ChildItem -LiteralPath $paths.DataRoot -Filter 'binding-*.json') | Should -BeNullOrEmpty
    Test-Path -LiteralPath $paths.Journal | Should -BeFalse
    # Purge is passed through, confirmed for rokid-setup.
    New-InstalledLayout | Out-Null
    $global:RokidTestWsl.Clear()
    & $script:Uninstall -Purge
    $global:RokidTestWsl | Should -Be @('Ubuntu|zoe|/home/zoe smith/.rokid-coder/bin/rokid-setup|uninstall --purge --yes')
  }

  It 'uninstall_resolves_the_committed_binding_not_the_newest_staged' {
    $committed = New-StagedGeneration -Generation '1.0.0-20261115100000' -Binding (New-TestBinding -Mode mirrored)
    # A later Repair into another distro failed: its binding is the newest file, and nothing committed it.
    $other = New-TestBinding -Mode nat -LinuxHome '/home/zed'
    $other.distroName = 'Ubuntu-24.04'
    $other.linuxUser = 'zed'
    $failed = New-StagedGeneration -Generation '1.0.0-20261116093000' -Binding $other
    (Get-Item -LiteralPath $failed.Binding).LastWriteTimeUtc = [datetime]::UtcNow.AddMinutes(5)
    $expected = @('Ubuntu|zoe|/home/zoe smith/.rokid-coder/bin/rokid-setup|uninstall')

    Set-Committed $committed
    (Resolve-CommittedBinding).Path | Should -Be $committed.Binding
    # No task at all: still the binding install.json names.
    $global:RokidTestTaskBinding = $null
    (Resolve-CommittedBinding).Path | Should -Be $committed.Binding
    # Nothing committed anywhere: no binding, so nothing in WSL is run.
    $global:RokidTestManifests = @{}
    Resolve-CommittedBinding | Should -BeNullOrEmpty
    # The task was left naming the failed Repair's binding (its recovery could not re-create it): install.json decides.
    Set-Committed $committed
    $global:RokidTestTaskBinding = $failed.Binding
    (Resolve-CommittedBinding).Path | Should -Be $committed.Binding
    & $script:Uninstall
    $LASTEXITCODE | Should -Be 0
    $global:RokidTestWsl | Should -Be $expected -Because 'rokid-setup uninstall ran in the committed distro, as its user'
  }

  It 'failed_cleanup_keeps_everything_for_a_retry' {
    $paths = New-InstalledLayout
    $kept = {
      @(Get-ChildItem -LiteralPath $paths.InstallRoot -Directory | Where-Object { $_.Name -match '-\d{14}$' }).Count | Should -Be 1 -Because 'the launcher generation stays'
      @(Get-ChildItem -LiteralPath $paths.DataRoot -Filter 'binding-*.json').Count | Should -Be 1 -Because 'the binding stays'
      Test-Path -LiteralPath $paths.Journal | Should -BeTrue -Because 'the journal stays'
      @((Read-MachineState -StatePath $paths.MachineState).objects).Count | Should -Be 1 -Because 'the machine record stays'
    }
    # rokid-setup uninstall fails in the distro: nothing else is touched, not even the task.
    $global:RokidTestSetupExit = 1
    & $script:Uninstall 3>$null
    $LASTEXITCODE | Should -Be 1
    & $kept
    Should -Invoke Unregister-ScheduledTask -Times 0 -Exactly
    Should -Invoke Invoke-MachineHelper -Times 0 -Exactly
    # Then elevation is refused: the task is gone, but the record, bindings and journal stay.
    $global:RokidTestSetupExit = 0
    Mock Invoke-MachineHelper { throw 'The operation was canceled by the user.' }
    & $script:Uninstall 3>$null
    $LASTEXITCODE | Should -Be 1
    & $kept
    Should -Invoke Unregister-ScheduledTask -Times 1 -Exactly
    # And the retry finishes the job.
    $global:RokidTestTaskBinding = $null
    Mock Invoke-MachineHelper { 0 }
    & $script:Uninstall
    $LASTEXITCODE | Should -Be 0
    @(Get-ChildItem -LiteralPath $paths.DataRoot -Filter 'binding-*.json') | Should -BeNullOrEmpty
    Test-Path -LiteralPath $paths.Journal | Should -BeFalse
    # A committed distro that was unregistered since has nothing left to remove: not a failure.
    New-InstalledLayout | Out-Null
    $global:RokidTestWsl.Clear()
    Mock Get-LxssDistros { @([pscustomobject]@{ Guid = '{x}'; Name = 'Ubuntu-24.04'; Version = 2; Default = $true }) }
    & $script:Uninstall
    $LASTEXITCODE | Should -Be 0
    $global:RokidTestWsl | Should -BeNullOrEmpty
  }

  It 'unreadable_or_corrupt_manifest_stops_uninstall_while_the_distro_exists' {
    $paths = New-InstalledLayout
    $good = $global:RokidTestManifests['Ubuntu']
    $untouched = {
      $global:RokidTestWsl | Should -BeNullOrEmpty -Because 'rokid-setup uninstall did not run'
      Should -Invoke Unregister-ScheduledTask -Times 0 -Exactly
      Should -Invoke Invoke-MachineHelper -Times 0 -Exactly
      @(Get-ChildItem -LiteralPath $paths.DataRoot -Filter 'binding-*.json').Count | Should -Be 1 -Because 'the binding stays for a retry'
      Test-Path -LiteralPath $paths.Journal | Should -BeTrue
    }
    $cases = @(
      @{ Why = 'corrupt'; Set = { $global:RokidTestManifests['Ubuntu'] = '{"schema":1,"binding":' }; Says = '*install.json*Ubuntu*not valid JSON*' }
      @{ Why = 'unreadable'; Set = { $global:RokidTestUnreadable['Ubuntu'] = $true }; Says = '*install.json*Ubuntu*could not be read*' }
      @{ Why = 'wsl.exe runs nothing'; Set = { $global:RokidTestWslBroken = $true }; Says = '*install.json*Ubuntu*could not be read*' }
      @{ Why = 'a directory on the way cannot be searched'; Set = { $global:RokidTestManifests['Ubuntu'] = $null; $global:RokidTestUnsearchable['Ubuntu'] = $true }; Says = '*install.json*Ubuntu*cannot be searched*' }
    )
    foreach ($case in $cases) {
      $global:RokidTestManifests['Ubuntu'] = $good; $global:RokidTestUnreadable = @{}; $global:RokidTestUnsearchable = @{}; $global:RokidTestWslBroken = $false
      & $case.Set
      { Resolve-CommittedBinding } | Should -Throw $case.Says -Because $case.Why
      $warnings = @(& $script:Uninstall 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { $_.Message })
      $LASTEXITCODE | Should -Be 1 -Because $case.Why
      $warnings -join ' ' | Should -BeLike $case.Says
      $warnings -join ' ' | Should -BeLike '*run the uninstaller again*'
      & $untouched
    }
    # Absent from a registered distro is no committed install; an unregistered distro is never asked.
    $global:RokidTestManifests = @{}; $global:RokidTestUnreadable = @{}; $global:RokidTestUnsearchable = @{}; $global:RokidTestWslBroken = $false
    Resolve-CommittedBinding | Should -BeNullOrEmpty
    # (Were it asked, the broken wsl.exe would make that an error.)
    Mock -ModuleName RokidCoder Get-LxssDistros { @() }
    $global:RokidTestWslBroken = $true
    Resolve-CommittedBinding | Should -BeNullOrEmpty
  }

  It 'nsis_uninstaller_keeps_itself_and_its_registration_on_failure' {
    $nsi = Get-Content -LiteralPath (Join-Path $script:WindowsDir 'installer.nsi') -Raw
    $section = [regex]::Match($nsi, '(?s)Section "Uninstall".*?SectionEnd').Value
    $section | Should -Match '(?s)\$\{If\} \$1 != 0.*?\$\{Else\}\s+RMDir /r "\$INSTDIR"\s+DeleteRegKey HKCU "\$\{UNINST_KEY\}"\s+\$\{EndIf\}'
  }

  It 'uninstall_asks_before_reverting_mirrored_mode' {
    New-InstalledLayout | Out-Null
    $config = Join-Path $env:USERPROFILE '.wslconfig'
    Write-Utf8File -Path $config -Content "[wsl2]`r`nmemory=8GB`r`nnetworkingMode=nat`r`n"
    Set-WslConfigValue -Key 'networkingMode' -Value 'mirrored'
    # Kept: Y (the default).
    Mock Read-Host { '' }
    & $script:Uninstall
    Should -Invoke Read-Host -Times 1 -Exactly -ParameterFilter { "$Prompt" -eq 'Keep mirrored networking? [Y/n]' }
    Get-WslConfigValue -Key 'networkingMode' | Should -Be 'mirrored'
    # n: the earlier value comes back, and no other key changes.
    New-InstalledLayout | Out-Null
    Mock Read-Host { 'n' }
    & $script:Uninstall
    Get-WslConfigValue -Key 'networkingMode' | Should -Be 'nat'
    Get-WslConfigValue -Key 'memory' | Should -Be '8GB'
    # Changed since by the person: never asked, never touched.
    New-InstalledLayout | Out-Null
    Set-WslConfigValue -Key 'networkingMode' -Value 'mirrored'
    Write-Utf8File -Path $config -Content "[wsl2]`r`nnetworkingMode=virtioproxy`r`n"
    Mock Read-Host { throw 'asked' }
    & $script:Uninstall
    Get-WslConfigValue -Key 'networkingMode' | Should -Be 'virtioproxy'
  }
}
