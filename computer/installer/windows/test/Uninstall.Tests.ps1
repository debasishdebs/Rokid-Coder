BeforeAll {
  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
  $script:Uninstall = Join-Path $script:WindowsDir 'uninstall.ps1'

  function New-InstalledLayout {
    $paths = Get-RokidPaths
    $binding = New-TestBinding -Mode nat
    $gen = '1.0.0-20261115100000'
    New-StagedGeneration -Generation $gen -Binding $binding | Out-Null
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
    Mock Invoke-WslExec { $script:wsl.Add("$Distro|$User|$Path|$($Arguments -join ' ')"); [pscustomobject]@{ ExitCode = 0; Output = @('Rokid Coder was removed. Your pairings and settings were kept') } }
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
