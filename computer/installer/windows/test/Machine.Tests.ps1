BeforeAll {
  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
  $script:MachinePs1 = Join-Path $script:WindowsDir 'machine.ps1'

  function Test-InvocationBinds {
    <#
      [6b-R7] One planned invocation against the REAL cmdlet's metadata (never a mock):
      no unknown parameter, every mandatory one of some parameter set supplied, and
      each value accepted by its ValidateSet or enum type. Returns the problems.
    #>
    param([Parameter(Mandatory = $true)][string]$Cmdlet, [Parameter(Mandatory = $true)][hashtable]$Parameters)
    $command = Get-Command -Name $Cmdlet -CommandType Cmdlet, Function -ErrorAction Stop | Where-Object { $_.ModuleName -eq 'NetSecurity' } | Select-Object -First 1
    if (-not $command) { return @("$Cmdlet is not in the NetSecurity module on this runner") }
    $problems = @()
    foreach ($name in $Parameters.Keys) {
      if (-not $command.Parameters.ContainsKey($name)) { $problems += "$Cmdlet has no -$name"; continue }
      $meta = $command.Parameters[$name]
      $values = @($Parameters[$name])
      foreach ($set in @($meta.Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] })) {
        foreach ($v in $values) { if ($set.ValidValues -notcontains "$v") { $problems += "-$name does not accept '$v'" } }
      }
      $type = $meta.ParameterType
      if ($type.IsArray) { $type = $type.GetElementType() }
      if ($type.IsEnum) {
        foreach ($v in $values) { try { [void][Enum]::Parse($type, "$v", $true) } catch { $problems += "-$name ($($type.Name)) does not accept '$v'" } }
      }
    }
    $bindable = @($command.ParameterSets | Where-Object {
        $set = $_
        $mandatory = @($set.Parameters | Where-Object { $_.IsMandatory } | ForEach-Object { $_.Name })
        $inSet = @($set.Parameters | ForEach-Object { $_.Name }) + @($set.Parameters | ForEach-Object { $_.Aliases } | Where-Object { $_ })
        -not ($mandatory | Where-Object { -not $Parameters.ContainsKey($_) }) -and -not ($Parameters.Keys | Where-Object { $inSet -notcontains $_ })
      })
    if ($bindable.Count -eq 0) { $problems += "$Cmdlet binds no parameter set with $(@($Parameters.Keys) -join ', ')" }
    $problems
  }
}

Describe 'the machine plan' {
  BeforeEach { $script:saved = Use-TestProfile }
  AfterEach { Restore-TestProfile $script:saved }

  It 'firewall_rules_are_scoped' {
    $mirrored = Get-MachinePlan -Mode mirrored -HyperVScope @('192.168.1.0/24', '100.64.0.0/10')
    $nat = Get-MachinePlan -Mode nat
    @($mirrored.Name) | Should -Be @('RokidCoder-wss', 'RokidCoder-discovery', 'RokidCoder-wss-host', 'RokidCoder-discovery-host')
    @($nat.Name) | Should -Be @('v4tov4 0.0.0.0:8794', 'RokidCoder-proxy')
    $byName = @{}
    foreach ($item in @($mirrored) + @($nat)) { $byName[$item.Name] = $item.Parameters }
    $byName['RokidCoder-wss'].Protocol | Should -Be 'TCP'
    $byName['RokidCoder-wss'].LocalPorts | Should -Be @('8792')
    $byName['RokidCoder-wss'].VMCreatorId | Should -Be '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
    $byName['RokidCoder-wss'].RemoteAddresses | Should -Be @('192.168.1.0/24', '100.64.0.0/10')
    $byName['RokidCoder-discovery'].Protocol | Should -Be 'UDP'
    $byName['RokidCoder-discovery'].RemotePorts | Should -Be @('8793')
    $byName['RokidCoder-discovery'].VMCreatorId | Should -Be '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
    $byName['RokidCoder-wss-host'].LocalPort | Should -Be @('8792')
    $byName['RokidCoder-discovery-host'].RemotePort | Should -Be @('8793')
    $byName['RokidCoder-proxy'].LocalPort | Should -Be @('8794')
    foreach ($name in 'RokidCoder-wss', 'RokidCoder-discovery') { $byName[$name].Profiles | Should -Be @('Private', 'Domain') }
    foreach ($name in 'RokidCoder-wss-host', 'RokidCoder-discovery-host', 'RokidCoder-proxy') {
      $byName[$name].Profile | Should -Be @('Private', 'Domain')
      $byName[$name].RemoteAddress | Should -Be @('LocalSubnet', '100.64.0.0/10')
      $byName[$name].Group | Should -Be 'Rokid Coder'
      $byName[$name].Direction | Should -Be 'Inbound'
    }
    foreach ($item in @($mirrored) + @($nat) | Where-Object Kind -ne 'portproxy') {
      $item.Parameters.Name | Should -Not -BeNullOrEmpty
      $item.Parameters.DisplayName | Should -Not -BeNullOrEmpty -Because "$($item.Name) needs -DisplayName [6b-R7]"
      $item.Parameters.Action | Should -Be 'Allow'
      ($item.Parameters.Values | ForEach-Object { "$_" }) -join ' ' | Should -Not -Match '\bAny\b'
      $item.Parameters.Keys | Should -Not -Contain 'DefaultInboundAction'
    }
    # The Hyper-V scope is the host's Private/Domain prefixes plus the tailnet.
    Mock -ModuleName RokidCoder Get-NetConnectionProfile { @([pscustomobject]@{ NetworkCategory = 'Private'; InterfaceIndex = 5 }, [pscustomobject]@{ NetworkCategory = 'Public'; InterfaceIndex = 9 }) }
    Mock -ModuleName RokidCoder Get-NetIPAddress { if ($InterfaceIndex -eq 5) { [pscustomobject]@{ IPAddress = '192.168.1.40'; PrefixLength = 24 } } else { [pscustomobject]@{ IPAddress = '10.9.9.9'; PrefixLength = 8 } } }
    Get-HyperVScope | Should -Be @('192.168.1.0/24', '100.64.0.0/10')
  }

  It 'machine_commands_bind_against_real_cmdlet_metadata' {
    $plan = @(Get-MachinePlan -Mode mirrored -HyperVScope @('192.168.1.0/24', '100.64.0.0/10')) + @(Get-MachinePlan -Mode nat)
    foreach ($item in $plan | Where-Object Kind -ne 'portproxy') {
      Test-InvocationBinds -Cmdlet $item.Cmdlet -Parameters $item.Parameters | Should -BeNullOrEmpty -Because $item.Name
    }
    # The check bites: a rule without -DisplayName, or with an unknown parameter or value, fails.
    $rule = ($plan | Where-Object Name -eq 'RokidCoder-proxy').Parameters.Clone()
    $rule.Remove('DisplayName')
    Test-InvocationBinds -Cmdlet 'New-NetFirewallRule' -Parameters $rule | Should -Match 'binds no parameter set'
    $bad = ($plan | Where-Object Name -eq 'RokidCoder-wss').Parameters.Clone()
    $bad['Direction'] = 'Sideways'
    Test-InvocationBinds -Cmdlet 'New-NetFirewallHyperVRule' -Parameters $bad | Should -Not -BeNullOrEmpty
    $bad = ($plan | Where-Object Name -eq 'RokidCoder-wss').Parameters.Clone()
    $bad['NoSuchParameter'] = 1
    Test-InvocationBinds -Cmdlet 'New-NetFirewallHyperVRule' -Parameters $bad | Should -Match 'no -NoSuchParameter'
    # And every rule the plan creates is removable by the name it records.
    (Get-Command Remove-NetFirewallRule -CommandType Cmdlet, Function).Parameters.ContainsKey('Name') | Should -BeTrue
    (Get-Command Remove-NetFirewallHyperVRule -CommandType Cmdlet, Function).Parameters.ContainsKey('Name') | Should -BeTrue
  }

  It 'elevated_helper_changes_only_machine_scope' {
    $script:native = New-Object System.Collections.Generic.List[string]
    Mock -ModuleName RokidCoder Invoke-Native { $script:native.Add("$FilePath $($ArgumentList -join ' ')"); [pscustomobject]@{ ExitCode = 0; Output = @() } }
    Mock -ModuleName RokidCoder Get-NetFirewallRule { $null }
    Mock -ModuleName RokidCoder Get-NetFirewallHyperVRule { $null }
    Mock -ModuleName RokidCoder New-NetFirewallRule { [pscustomobject]@{ Name = $Name } }
    Mock -ModuleName RokidCoder New-NetFirewallHyperVRule { [pscustomobject]@{ Name = $Name } }
    Mock -ModuleName RokidCoder Get-NetConnectionProfile { @([pscustomobject]@{ NetworkCategory = 'Private'; InterfaceIndex = 5 }) }
    Mock -ModuleName RokidCoder Get-NetIPAddress { [pscustomobject]@{ IPAddress = '192.168.1.40'; PrefixLength = 24 } }
    foreach ($forbidden in 'Invoke-WslExec', 'Get-LxssDistros', 'Set-WslConfigValue', 'New-StagedGeneration', 'Resolve-Binding', 'Register-ScheduledTask') {
      Mock -ModuleName RokidCoder $forbidden { throw "machine.ps1 called $forbidden" }
      Mock $forbidden { throw "machine.ps1 called $forbidden" }
    }
    Mock Set-ItemProperty { throw 'machine.ps1 wrote the registry' } -ParameterFilter { "$Path" -like 'HKCU:*' -or "$Path" -like 'HKEY_CURRENT_USER*' -or "$LiteralPath" -like 'HKCU:*' }
    $before = @(Get-ChildItem -LiteralPath $TestDrive -Recurse -File | ForEach-Object { $_.FullName })
    $state = (Get-RokidPaths).MachineState
    foreach ($mode in 'mirrored', 'nat') {
      & $script:MachinePs1 -Apply -Mode $mode -StatePath $state -RunId "run-$mode"
      $LASTEXITCODE | Should -Be 0
    }
    $after = @(Get-ChildItem -LiteralPath $TestDrive -Recurse -File | ForEach-Object { $_.FullName })
    @($after | Where-Object { $before -notcontains $_ }) | Should -Be @($state) -Because 'the only file it writes is the machine-wide record'
    @($script:native | Where-Object { $_ -notlike '*\netsh.exe *' }) | Should -BeNullOrEmpty -Because 'no wsl.exe, schtasks.exe or anything but netsh'
    $recorded = (Read-MachineState -StatePath $state).objects
    @($recorded.name) | Should -Be @('RokidCoder-wss', 'RokidCoder-discovery', 'RokidCoder-wss-host', 'RokidCoder-discovery-host', 'v4tov4 0.0.0.0:8794', 'RokidCoder-proxy')
    { Invoke-MachineApply -Mode nat -StatePath (Join-Path $env:USERPROFILE 'state.json') -RunId 'x' } | Should -Throw '*ProgramData*'
  }

  It 'failed_install_reverts_only_this_runs_machine_changes' {
    $state = (Get-RokidPaths).MachineState
    # An earlier install created the mirrored rules; this run adds NAT's.
    Write-MachineState -StatePath $state -State ([pscustomobject]@{ schema = 1; objects = @([pscustomobject]@{ kind = 'hyperv'; name = 'RokidCoder-wss'; ids = @('RokidCoder-wss'); runId = 'earlier'; mode = 'mirrored'; parameters = @{} }) })
    Mock -ModuleName RokidCoder Test-PlanItemPresent { $false }
    Mock -ModuleName RokidCoder New-NetFirewallRule { [pscustomobject]@{ Name = $Name } }
    Mock -ModuleName RokidCoder Invoke-Native {
      if ($ArgumentList -contains 'show') { return [pscustomobject]@{ ExitCode = 0; Output = @('', '0.0.0.0        8794        127.0.0.1       8792') } }
      [pscustomobject]@{ ExitCode = 0; Output = @() }
    }
    Mock -ModuleName RokidCoder Remove-NetFirewallRule { }
    Mock -ModuleName RokidCoder Remove-NetFirewallHyperVRule { }
    Invoke-MachineApply -Mode nat -StatePath $state -RunId 'this-run'
    Invoke-MachineRevert -StatePath $state -RunId 'this-run'
    Should -Invoke -ModuleName RokidCoder Remove-NetFirewallRule -Times 1 -Exactly -ParameterFilter { $Name -eq 'RokidCoder-proxy' }
    Should -Invoke -ModuleName RokidCoder Remove-NetFirewallHyperVRule -Times 0 -Exactly
    Should -Invoke -ModuleName RokidCoder Invoke-Native -Times 1 -Exactly -ParameterFilter { ($ArgumentList -join ' ') -eq 'interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=8794' }
    @((Read-MachineState -StatePath $state).objects.name) | Should -Be @('RokidCoder-wss') -Because 'the earlier install keeps its rule'
    { Invoke-MachineRevert -StatePath $state } | Should -Throw '*-RunId or -All*'
  }

  It 'uninstall_removes_only_recorded_proxy_and_rules' {
    $state = (Get-RokidPaths).MachineState
    Write-MachineState -StatePath $state -State ([pscustomobject]@{ schema = 1; objects = @(
          [pscustomobject]@{ kind = 'firewall'; name = 'RokidCoder-proxy'; ids = @('RokidCoder-proxy'); runId = 'a'; mode = 'nat'; parameters = @{} }
          [pscustomobject]@{ kind = 'portproxy'; name = 'v4tov4 0.0.0.0:8794'; ids = @('0.0.0.0:8794->127.0.0.1:8792'); runId = 'a'; mode = 'nat'; parameters = @{ ListenAddress = '0.0.0.0'; ListenPort = 8794; ConnectAddress = '127.0.0.1'; ConnectPort = 8792 } }
          [pscustomobject]@{ kind = 'hyperv'; name = 'RokidCoder-wss'; ids = @('RokidCoder-wss'); runId = 'b'; mode = 'mirrored'; parameters = @{} }
        ) })
    Mock -ModuleName RokidCoder Invoke-Native {
      if ($ArgumentList -contains 'show') { return [pscustomobject]@{ ExitCode = 0; Output = @('0.0.0.0  9000  127.0.0.1  9001', '0.0.0.0  8794  127.0.0.1  8792') } }
      [pscustomobject]@{ ExitCode = 0; Output = @() }
    }
    Mock -ModuleName RokidCoder Remove-NetFirewallRule { }
    Mock -ModuleName RokidCoder Remove-NetFirewallHyperVRule { }
    Invoke-MachineRevert -StatePath $state -All
    Should -Invoke -ModuleName RokidCoder Remove-NetFirewallRule -Times 1 -Exactly -ParameterFilter { $Name -eq 'RokidCoder-proxy' }
    Should -Invoke -ModuleName RokidCoder Remove-NetFirewallHyperVRule -Times 1 -Exactly -ParameterFilter { $Name -eq 'RokidCoder-wss' }
    Should -Invoke -ModuleName RokidCoder Invoke-Native -Times 1 -Exactly -ParameterFilter { $ArgumentList -contains 'delete' }
    Should -Invoke -ModuleName RokidCoder Invoke-Native -Times 0 -Exactly -ParameterFilter { $ArgumentList -contains 'listenport=9000' }
    @((Read-MachineState -StatePath $state).objects) | Should -BeNullOrEmpty
  }
}
