BeforeAll {
  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
  $script:Uninstall = Join-Path $script:WindowsDir 'uninstall.ps1'

  # install.json per distro (what `cat ~/.rokid-coder/install.json` prints), and the registered task's -Binding.
  $script:manifests = @{}
  $script:taskBinding = $null
  $script:fakeWsl = {
    if ($Path -eq '/usr/bin/cat') {
      $manifest = $script:manifests[$Distro]
      if ($manifest) { return [pscustomobject]@{ ExitCode = 0; Output = @($manifest) } }
      return [pscustomobject]@{ ExitCode = 1; Output = @() }
    }
    $script:wsl.Add("$Distro|$User|$Path|$($Arguments -join ' ')")
    [pscustomobject]@{ ExitCode = $script:setupExit; Output = @('Rokid Coder was removed. Your pairings and settings were kept') }
  }
  $script:fakeTask = {
    if (-not $script:taskBinding) { return $null }
    [pscustomobject]@{ TaskPath = '\RokidCoder\'; TaskName = 'agentd'; Actions = @([pscustomobject]@{ Execute = 'C:\Windows\System32\conhost.exe'; Arguments = "--headless `"powershell.exe`" -File `"C:\x\start-agentd.ps1`" -Binding `"$script:taskBinding`"" }) }
  }

  function Set-Committed {
    <# What a committed install leaves: install.json naming the binding, and the task running it. #>
    param([Parameter(Mandatory = $true)]$Staged, [string]$Distro = 'Ubuntu', [switch]$NoTask)
    $script:manifests[$Distro] = ConvertTo-Json -Compress -Depth 5 -InputObject @{ schema = 1; binding = @{ bindingPath = @{ win = $Staged.Binding; linux = '/mnt/c/x' } } }
    if (-not $NoTask) { $script:taskBinding = $Staged.Binding }
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
    $script:wsl = New-Object System.Collections.Generic.List[string]
    $script:setupExit = 0
    $script:manifests = @{}
    $script:taskBinding = $null
    Mock Invoke-WslExec $script:fakeWsl
    Mock -ModuleName RokidCoder Invoke-WslExec $script:fakeWsl
    Mock -ModuleName RokidCoder Get-ScheduledTask $script:fakeTask
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
    $script:wsl | Should -Be @('Ubuntu|zoe|/home/zoe smith/.rokid-coder/bin/rokid-setup|uninstall')
    # 2, 3: the task, then every recorded rule and the proxy, elevated.
    Should -Invoke Unregister-ScheduledTask -Times 1 -Exactly -ParameterFilter { $TaskPath -eq '\RokidCoder\' -and $TaskName -eq 'agentd' }
    Should -Invoke Invoke-MachineHelper -Times 1 -Exactly -ParameterFilter { $Action -eq 'Revert' -and $All }
    # 5: the generations, bindings and journal; nothing of the distro's state is touched here.
    @(Get-ChildItem -LiteralPath $paths.InstallRoot -Directory -ErrorAction SilentlyContinue) | Should -BeNullOrEmpty
    @(Get-ChildItem -LiteralPath $paths.DataRoot -Filter 'binding-*.json') | Should -BeNullOrEmpty
    Test-Path -LiteralPath $paths.Journal | Should -BeFalse
    # Purge is passed through, confirmed for rokid-setup.
    New-InstalledLayout | Out-Null
    $script:wsl.Clear()
    & $script:Uninstall -Purge
    $script:wsl | Should -Be @('Ubuntu|zoe|/home/zoe smith/.rokid-coder/bin/rokid-setup|uninstall --purge --yes')
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
    $script:taskBinding = $null
    (Resolve-CommittedBinding).Path | Should -Be $committed.Binding
    # Nothing committed anywhere: no binding, so nothing in WSL is run.
    $script:manifests = @{}
    Resolve-CommittedBinding | Should -BeNullOrEmpty
    # The task was left naming the failed Repair's binding (its recovery could not re-create it): install.json decides.
    Set-Committed $committed
    $script:taskBinding = $failed.Binding
    (Resolve-CommittedBinding).Path | Should -Be $committed.Binding
    & $script:Uninstall
    $LASTEXITCODE | Should -Be 0
    $script:wsl | Should -Be $expected -Because 'rokid-setup uninstall ran in the committed distro, as its user'
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
