BeforeAll {
  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
  $script:UserSetup = Join-Path $script:WindowsDir 'user-setup.ps1'
  $script:StartAgentd = Join-Path $script:WindowsDir 'start-agentd.ps1'
  $script:Ns = @{ t = 'http://schemas.microsoft.com/windows/2004/02/mit/task' }
  $script:Distro = [pscustomobject]@{ Guid = '{0b5bd4a5-7a7c-4d66-9c43-6e0c2f6f0f11}'; Name = 'Ubuntu'; Version = 2; Default = $true }

  function Get-TaskNode { param([xml]$Xml, [string]$Path) $n = Select-Xml -Xml $Xml -XPath $Path -Namespace $script:Ns; if ($n) { $n.Node.InnerText } else { $null } }
  function Get-FileBytes { param([string[]]$Files) @($Files | ForEach-Object { [Convert]::ToBase64String([IO.File]::ReadAllBytes($_)) }) }
  function ConvertTo-Sid { param([string]$Value) if ($Value -match '^S-1-') { $Value } else { (New-Object Security.Principal.NTAccount $Value).Translate([Security.Principal.SecurityIdentifier]).Value } }

  function Set-InstallMocks {
    Mock -ModuleName RokidCoder Assert-SessionUser { }
    Mock -ModuleName RokidCoder Resolve-Binding { New-TestBinding -Mode $Mode -Version $Version }
    Mock -ModuleName RokidCoder Install-BundleIntoDistro { 'extracted' }
    Mock -ModuleName RokidCoder Set-AdvertisedEndpoint { }
    Mock -ModuleName RokidCoder Start-SetupWindow { $script:setupExit }
    Mock -ModuleName RokidCoder Get-CommittedGenerations { $script:committed }
    Mock -ModuleName RokidCoder Register-ScheduledTask { throw 'user-setup must never register the task' }
    Mock -ModuleName RokidCoder Invoke-Native { throw "user-setup ran $FilePath itself" }
  }
}

Describe 'staging' {
  BeforeEach { $script:saved = Use-TestProfile }
  AfterEach { Restore-TestProfile $script:saved }

  It 'refuses_when_process_user_is_not_session_user' {
    Mock -ModuleName RokidCoder Get-ProcessUserSid { 'S-1-5-21-1-1-1-1001' }
    Mock -ModuleName RokidCoder Get-SessionOwnerSid { 'S-1-5-21-9-9-9-500' }
    { Assert-SessionUser } | Should -Throw 'Run the installer from your own Windows account, not as another user'
    & $script:UserSetup -CheckSession 2>$null
    $LASTEXITCODE | Should -Be 1
    Set-InstallMocks
    Mock -ModuleName RokidCoder Assert-SessionUser { throw 'Run the installer from your own Windows account, not as another user' }
    { Invoke-UserInstall -Version '1.0.0' -Mode nat -Distro $script:Distro -Archive 'x' -Sha256 'y' } | Should -Throw '*own Windows account*'
    Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Recurse -File | Should -BeNullOrEmpty -Because 'nothing was staged for the wrong user'
    Mock -ModuleName RokidCoder Get-SessionOwnerSid { 'S-1-5-21-1-1-1-1001' }
    { Assert-SessionUser } | Should -Not -Throw
  }

  It 'task_xml_has_no_tilde_and_absolute_paths' {
    $local = $env:LOCALAPPDATA
    $launcher = Join-Path $local 'Programs\RokidCoder\1.0.0-20261115100000\start-agentd.ps1'
    $binding = Join-Path $local 'RokidCoder\binding-1.0.0-20261115100000.json'
    $xml = New-TaskXml -Sid 'S-1-5-21-1-1-1-1001' -Distro 'Ubuntu' -Generation '1.0.0-20261115100000' -Launcher $launcher -Binding $binding -SystemRoot 'C:\Windows'
    $file = Join-Path $TestDrive 'task.xml'
    Write-Utf16File -Path $file -Content $xml
    $bytes = [IO.File]::ReadAllBytes($file)
    $bytes[0] | Should -Be 0xFF
    $bytes[1] | Should -Be 0xFE
    $text = [IO.File]::ReadAllText($file, [Text.Encoding]::Unicode)
    $text | Should -Match 'encoding="UTF-16"'
    $text | Should -Not -Match '~'
    $text | Should -Match ([regex]::Escape($script:UserName)) -Because 'a non-ASCII user name survives'
    [xml]$doc = $text
    Get-TaskNode $doc '//t:Exec/t:Command' | Should -Be 'C:\Windows\System32\conhost.exe'
    $arguments = Get-TaskNode $doc '//t:Exec/t:Arguments'
    $arguments | Should -BeLike '--headless "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "*" -Binding "*"'
    $arguments | Should -Match ([regex]::Escape("-File `"$launcher`""))
    $arguments | Should -Match ([regex]::Escape("-Binding `"$binding`""))
    { New-TaskXml -Sid 'S-1-5-21-1' -Distro 'Ubuntu' -Generation 'g' -Launcher '~\start-agentd.ps1' -Binding $binding } | Should -Throw '*absolute*'
    { New-TaskXml -Sid 'S-1-5-21-1' -Distro 'Ubuntu' -Generation 'g' -Launcher 'start-agentd.ps1' -Binding $binding } | Should -Throw '*absolute*'
    # The binding's Linux side is absolute too, with a home that has a space.
    $b = New-TestBinding -LinuxHome '/home/zoe smith'
    $b.agentdPath | Should -Be '/home/zoe smith/.rokid-coder/bin/agentd'
  }

  It 'binding_persisted_and_reused_by_task' {
    $binding = New-TestBinding -Mode mirrored
    $staged = New-StagedGeneration -Generation '1.0.0-20261115100000' -Binding $binding
    $persisted = Get-Content -LiteralPath $staged.Binding -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($key in $binding.Keys) { "$($persisted.$key)" | Should -Be "$($binding[$key])" -Because $key }
    [IO.File]::ReadAllBytes($staged.Binding)[0] | Should -Not -Be 0xEF -Because 'no BOM: node reads it with JSON.parse'
    [xml]$task = [IO.File]::ReadAllText($staged.TaskXml, [Text.Encoding]::Unicode)
    Get-TaskNode $task '//t:Principal/t:UserId' | Should -Be $binding.windowsSid
    Get-TaskNode $task '//t:LogonTrigger/t:UserId' | Should -Be $binding.windowsSid
    $arguments = Get-TaskNode $task '//t:Exec/t:Arguments'
    $arguments | Should -Match ([regex]::Escape("-Binding `"$($staged.Binding)`""))
    $arguments | Should -Match ([regex]::Escape("-File `"$($staged.Launcher)`""))
    [IO.File]::ReadAllText($staged.Launcher) | Should -Be ([IO.File]::ReadAllText($script:StartAgentd))
    # What the task's launcher runs with that binding: its distro, Linux user and agentd, through --exec.
    $fake = New-FakeWsl
    $copy = Join-Path $TestDrive 'binding-copy.json'
    $persisted.wslExe = $fake.Path
    Write-Utf8File -Path $copy -Content (ConvertTo-Json -InputObject $persisted)
    & $staged.Launcher -Binding $copy
    Get-FakeWslCalls $fake | Should -Be @('-d Ubuntu -u zoe --exec "/home/zoe smith/.rokid-coder/bin/agentd" run')
  }

  It 'user_setup_stages_versioned_files_and_never_registers_or_overwrites' {
    Set-InstallMocks
    $script:setupExit = 0
    $script:committed = @('1.0.0-20261115100000')
    $result = Invoke-UserInstall -Version '1.0.0' -Mode mirrored -Distro $script:Distro -Archive 'C:\t\a.tar.gz' -Sha256 'abc' -Now ([datetime]::new(2026, 11, 15, 10, 0, 0, [DateTimeKind]::Utc))
    $result.ExitCode | Should -Be 0
    $result.Generation | Should -Be '1.0.0-20261115100000'
    $paths = Get-RokidPaths
    $files = @((Join-Path $paths.DataRoot 'binding-1.0.0-20261115100000.json'), (Join-Path $paths.InstallRoot '1.0.0-20261115100000\start-agentd.ps1'), (Join-Path $paths.InstallRoot '1.0.0-20261115100000\task.xml'))
    foreach ($file in $files) { Test-Path -LiteralPath $file | Should -BeTrue }
    $before = Get-FileBytes $files
    { New-StagedGeneration -Generation '1.0.0-20261115100000' -Binding (New-TestBinding -Mode nat) } | Should -Throw '*never staged twice*'
    Get-FileBytes $files | Should -Be $before
    Should -Invoke -ModuleName RokidCoder Register-ScheduledTask -Times 0 -Exactly
    Should -Invoke -ModuleName RokidCoder Invoke-Native -Times 0 -Exactly
    Should -Invoke -ModuleName RokidCoder Start-SetupWindow -Times 1 -Exactly -ParameterFilter { $Staged.TaskXml -eq $files[2] -and $Staged.Binding -eq $files[0] }
  }

  It 'same_version_repair_failure_restores_original_binding_launcher_and_task' {
    Set-InstallMocks
    $script:setupExit = 0
    $script:committed = @('1.0.0-20261115100000')
    $first = Invoke-UserInstall -Version '1.0.0' -Mode mirrored -Distro $script:Distro -Archive 'C:\t\a.tar.gz' -Sha256 'abc' -Now ([datetime]::new(2026, 11, 15, 10, 0, 0, [DateTimeKind]::Utc))
    $original = @($first.Staged.Binding, $first.Staged.Launcher, $first.Staged.TaskXml)
    $before = Get-FileBytes $original
    # Repair of the same version, switching to NAT; rokid-setup fails at step 9 (ROKID_SETUP_FAIL_AT=9) and rolls back.
    $script:setupExit = 1
    $repair = Invoke-UserInstall -Version '1.0.0' -Mode nat -Distro $script:Distro -Archive 'C:\t\a.tar.gz' -Sha256 'abc' -Now ([datetime]::new(2026, 11, 16, 9, 30, 0, [DateTimeKind]::Utc))
    $repair.ExitCode | Should -Be 1
    $repair.Generation | Should -Be '1.0.0-20261116093000' -Because 'a Repair of the same version is a new generation'
    (Get-Content -LiteralPath $repair.Staged.Binding -Raw | ConvertFrom-Json).networkMode | Should -Be 'nat'
    Get-FileBytes $original | Should -Be $before -Because "the original generation's binding, launcher and task are untouched"
    Should -Invoke -ModuleName RokidCoder Get-CommittedGenerations -Times 1 -Exactly -Because 'nothing is pruned after a failure'
    Should -Invoke -ModuleName RokidCoder Register-ScheduledTask -Times 0 -Exactly
    # The task rokid-setup's recovery re-creates names the original files (node: wsl_failed_upgrade_restarts_previous_bundle...).
    [xml]$task = [IO.File]::ReadAllText($first.Staged.TaskXml, [Text.Encoding]::Unicode)
    Get-TaskNode $task '//t:Exec/t:Arguments' | Should -Match ([regex]::Escape($first.Staged.Binding))
  }
}

Describe 'on the hosted runner, for real' {
  BeforeAll { $script:scripts = Get-WslScripts }

  It 'task_xml_registers_for_real_on_hosted_runner' {
    $sid = Get-ProcessUserSid
    $xml = New-TaskXml -Sid $sid -Distro 'CI' -Generation '0.0.0-ci' -Launcher 'C:\ci\start-agentd.ps1' -Binding 'C:\ci\binding-ci.json' -Command (Join-Path $env:SystemRoot 'System32\cmd.exe') -Arguments '/c exit 0'
    $file = Join-Path $TestDrive 'task.xml'
    Write-Utf16File -Path $file -Content $xml
    $name = '\RokidCoder-CI\xmltest'
    try {
      & schtasks.exe /Create /TN $name /XML $file /F | Out-Null
      $LASTEXITCODE | Should -Be 0
      $exported = (& schtasks.exe /Query /TN $name /XML) -join "`r`n"
      $LASTEXITCODE | Should -Be 0
      [xml]$doc = $exported
      ConvertTo-Sid (Get-TaskNode $doc '//t:Principal/t:UserId') | Should -Be $sid
      ConvertTo-Sid (Get-TaskNode $doc '//t:LogonTrigger/t:UserId') | Should -Be $sid
      foreach ($pair in @(@('//t:Principal/t:LogonType', 'InteractiveToken'), @('//t:Principal/t:RunLevel', 'LeastPrivilege'), @('//t:Settings/t:MultipleInstancesPolicy', 'IgnoreNew'))) {
        $value = Get-TaskNode $doc $pair[0]
        if ($null -ne $value) { $value | Should -Be $pair[1] -Because $pair[0] }
      }
      Get-TaskNode $doc '//t:Settings/t:DisallowStartIfOnBatteries' | Should -Be 'false'
      Get-TaskNode $doc '//t:Settings/t:StopIfGoingOnBatteries' | Should -Be 'false'
      Get-TaskNode $doc '//t:Settings/t:ExecutionTimeLimit' | Should -Be 'PT0S'
      $effective = (Get-ScheduledTask -TaskPath '\RokidCoder-CI\' -TaskName 'xmltest').Settings
      $effective.DisallowStartIfOnBatteries | Should -BeFalse -Because '[6b-R22]'
      $effective.StopIfGoingOnBatteries | Should -BeFalse
      # The recovery path: re-create it from the exported definition.
      $again = Join-Path $TestDrive 'exported.xml'
      Write-Utf16File -Path $again -Content $exported
      & schtasks.exe /Create /TN $name /XML $again /F | Out-Null
      $LASTEXITCODE | Should -Be 0
    } finally {
      & schtasks.exe /Delete /TN $name /F 2>$null | Out-Null
    }
  }

  It 'upgrade_reregisters_task_and_restores_exported_xml_on_failure' {
    $sid = Get-ProcessUserSid
    $make = { param($gen) $f = Join-Path $TestDrive "task-$gen.xml"; Write-Utf16File -Path $f -Content (New-TaskXml -Sid $sid -Distro 'CI' -Generation $gen -Launcher "C:\ci\$gen\start-agentd.ps1" -Binding "C:\ci\binding-$gen.json"); $f }
    $old = & $make 'gen1'
    $new = & $make 'gen2'
    $name = '\RokidCoder-CI\upgrade'
    $previous = Join-Path $TestDrive "journal $script:UserName\task-previous.xml"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $previous) | Out-Null
    try {
      Invoke-WslScript -Script $script:scripts.exportTask -InputObject @{ taskPath = '\RokidCoder-CI\'; taskName = 'upgrade'; file = $previous } | Should -Be 'absent'
      & schtasks.exe /Create /TN $name /XML $old /F | Out-Null
      # Step 9: the registered definition is exported BEFORE /Create replaces it.
      Invoke-WslScript -Script $script:scripts.exportTask -InputObject @{ taskPath = '\RokidCoder-CI\'; taskName = 'upgrade'; file = $previous } | Should -Be 'exported'
      $bytes = [IO.File]::ReadAllBytes($previous)
      $bytes[0] | Should -Be 0xFF
      $bytes[1] | Should -Be 0xFE
      & schtasks.exe /Create /TN $name /XML $new /F | Out-Null
      ((& schtasks.exe /Query /TN $name /XML) -join "`n") | Should -Match 'binding-gen2\.json'
      # The failure: recovery re-creates the previous definition from the export.
      & schtasks.exe /Create /TN $name /XML $previous /F | Out-Null
      $LASTEXITCODE | Should -Be 0
      [xml]$restored = (& schtasks.exe /Query /TN $name /XML) -join "`n"
      $arguments = Get-TaskNode $restored '//t:Exec/t:Arguments'
      $arguments | Should -Match ([regex]::Escape('-File "C:\ci\gen1\start-agentd.ps1" -Binding "C:\ci\binding-gen1.json"'))
    } finally {
      & schtasks.exe /Delete /TN $name /F 2>$null | Out-Null
    }
  }

  It 'legacy_windows_daemon_stopped_by_exact_identity_and_ports_verified' {
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $listener = "`$l = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), $port; `$l.Start(); Start-Sleep -Seconds 300"
    $proc = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile', '-Command', $listener) -PassThru -WindowStyle Hidden
    try {
      $deadline = (Get-Date).AddSeconds(30)
      while (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        if ((Get-Date) -gt $deadline) { throw 'the stand-in daemon never listened' }
        Start-Sleep -Milliseconds 200
      }
      $found = Invoke-WslScript -Script $script:scripts.listeners -InputObject @{ ports = @($port) } | ConvertFrom-Json
      $identity = @($found)[0]
      $identity.pid | Should -Be $proc.Id
      $identity.port | Should -Be $port
      $identity.executablePath | Should -Not -BeNullOrEmpty
      $identity.commandLine | Should -Match 'TcpListener'
      # The pid now names "another" process (another creation time): it is never stopped.
      $reused = @{ pid = $identity.pid; executablePath = $identity.executablePath; commandLine = $identity.commandLine; creationDate = '2001-01-01T00:00:00.0000000Z' }
      Invoke-WslScript -Script $script:scripts.stopExact -InputObject $reused | Should -Be 'mismatch'
      (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty
      $exact = @{ pid = $identity.pid; executablePath = $identity.executablePath; commandLine = $identity.commandLine; creationDate = $identity.creationDate }
      Invoke-WslScript -Script $script:scripts.stopExact -InputObject $exact | Should -Be 'stopped'
      $proc.WaitForExit(10000) | Should -BeTrue
      Invoke-WslScript -Script $script:scripts.listeners -InputObject @{ ports = @($port) } | Should -BeNullOrEmpty -Because 'the ports are free'
      Invoke-WslScript -Script $script:scripts.stopExact -InputObject $exact | Should -Be 'gone'
    } finally {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
