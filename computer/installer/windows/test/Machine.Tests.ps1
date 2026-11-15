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

  It 'firewall_check_compares_effective_filters_not_names' {
    # How Windows hands a matching host rule back: enum text, the tailnet as a mask.
    $script:hostRule = @{ Enabled = 'True'; Direction = 'Inbound'; Action = 'Allow'; Profile = 'Domain, Private' }
    $script:portFilter = @{ Protocol = 'TCP'; LocalPort = @('8794'); RemotePort = @('Any') }
    $script:addressFilter = @{ RemoteAddress = @('LocalSubnet', '100.64.0.0/255.192.0.0') }
    Mock -ModuleName RokidCoder Get-NetFirewallRule { [pscustomobject](@{ Name = $Name } + $script:hostRule) }
    Mock -ModuleName RokidCoder Get-FirewallRuleFilter { [pscustomobject]@{ Port = [pscustomobject]$script:portFilter; Address = [pscustomobject]$script:addressFilter } }
    Mock -ModuleName RokidCoder Invoke-Native { [pscustomobject]@{ ExitCode = 0; Output = @('0.0.0.0        8794        127.0.0.1       8792') } }
    $proxy = Get-MachinePlan -Mode nat | Where-Object Name -eq 'RokidCoder-proxy'
    @(Get-PlanItemDrift -Item $proxy) | Should -BeNullOrEmpty
    Test-MachineRuleSet -Mode nat | Should -BeNullOrEmpty
    # Each enforced filter that differs fails the check, by name; a present name alone never passes it.
    $cases = @(
      @{ Field = 'Enabled'; Change = { $script:hostRule.Enabled = 'False' } }
      @{ Field = 'Direction'; Change = { $script:hostRule.Direction = 'Outbound' } }
      @{ Field = 'Action'; Change = { $script:hostRule.Action = 'Block' } }
      @{ Field = 'Protocol'; Change = { $script:portFilter.Protocol = 'UDP' } }
      @{ Field = 'LocalPorts'; Change = { $script:portFilter.LocalPort = @('8795') } }
      @{ Field = 'RemoteAddresses'; Change = { $script:addressFilter.RemoteAddress = @('Any') } }
      @{ Field = 'Profile'; Change = { $script:hostRule.Profile = 'Any' } }
    )
    foreach ($case in $cases) {
      $saved = @{ rule = $script:hostRule.Clone(); port = $script:portFilter.Clone(); address = $script:addressFilter.Clone() }
      & $case.Change
      @(Get-PlanItemDrift -Item $proxy) | Should -Be @($case.Field) -Because $case.Field
      Test-MachineRuleSet -Mode nat | Should -Be @("RokidCoder-proxy ($($case.Field) changed)")
      $script:hostRule = $saved.rule; $script:portFilter = $saved.port; $script:addressFilter = $saved.address
    }
    # A Hyper-V rule still scoped to a network the host has left: its scope is stale.
    Mock -ModuleName RokidCoder Get-NetFirewallHyperVRule {
      [pscustomobject]@{ Name = $Name; Enabled = 'True'; Direction = 'Inbound'; Action = 'Allow'; Protocol = 'TCP'; LocalPorts = @('8792'); RemotePorts = @('Any'); RemoteAddresses = @('192.168.1.0/255.255.255.0', '100.64.0.0/255.192.0.0'); VMCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' }
    }
    $wss = { param($scope) Get-MachinePlan -Mode mirrored -HyperVScope $scope | Where-Object Name -eq 'RokidCoder-wss' }
    @(Get-PlanItemDrift -Item (& $wss @('192.168.1.0/24', '100.64.0.0/10'))) | Should -BeNullOrEmpty
    @(Get-PlanItemDrift -Item (& $wss @('10.20.0.0/16', '100.64.0.0/10'))) | Should -Be @('RemoteAddresses')
    # Absent stays absent.
    Mock -ModuleName RokidCoder Get-NetFirewallRule { $null }
    @(Get-PlanItemDrift -Item $proxy) | Should -Be @('absent')
    ConvertTo-FilterValue @('100.64.0.0/10', 'LocalSubnet', '192.168.1.40') -Address | Should -Be '100.64.0.0/10,192.168.1.40/32,localsubnet'
  }

  It 'repair_reconciles_owned_rules_and_revert_restores_them_exactly' {
    $state = (Get-RokidPaths).MachineState
    $old = @('192.168.1.0/24', '100.64.0.0/10')
    $new = @('10.20.0.0/16', '100.64.0.0/10')
    $earlier = @(Get-MachinePlan -Mode mirrored -HyperVScope $old | Where-Object Kind -eq 'hyperv' | ForEach-Object {
        [pscustomobject]@{ kind = 'hyperv'; name = $_.Name; ids = @($_.Name); runId = 'install'; mode = 'mirrored'; parameters = $_.Parameters }
      })
    Write-MachineState -StatePath $state -State ([pscustomobject]@{ schema = 1; objects = $earlier })
    # The host moved to 10.20.0.0/16; its host rules still match, the Hyper-V ones carry the old scope.
    Mock -ModuleName RokidCoder Get-HyperVScope { $new }
    Mock -ModuleName RokidCoder Get-PlanItemDrift { if ($Item.Kind -eq 'hyperv') { 'RemoteAddresses' } }
    $script:created = New-Object System.Collections.Generic.List[object]
    Mock -ModuleName RokidCoder New-NetFirewallHyperVRule { $script:created.Add(@{ Name = $Name; RemoteAddresses = @($RemoteAddresses) }); [pscustomobject]@{ Name = $Name } }
    Mock -ModuleName RokidCoder Remove-NetFirewallHyperVRule { }
    Mock -ModuleName RokidCoder New-NetFirewallRule { throw 'the matching host rules are left alone' }
    Invoke-MachineApply -Mode mirrored -StatePath $state -RunId 'repair'
    Should -Invoke -ModuleName RokidCoder Remove-NetFirewallHyperVRule -Times 2 -Exactly
    @($script:created | ForEach-Object { "$($_.Name)=$($_.RemoteAddresses -join ',')" }) | Should -Be @('RokidCoder-wss=10.20.0.0/16,100.64.0.0/10', 'RokidCoder-discovery=10.20.0.0/16,100.64.0.0/10')
    $recorded = @((Read-MachineState -StatePath $state).objects)
    @($recorded | ForEach-Object { "$($_.name):$($_.runId)<-$($_.previous.runId)" }) | Should -Be @('RokidCoder-wss:repair<-install', 'RokidCoder-discovery:repair<-install')
    # A failed Repair reverts its run: the earlier rules come back as recorded, scope and all.
    $script:created.Clear()
    Invoke-MachineRevert -StatePath $state -RunId 'repair'
    @($script:created | ForEach-Object { "$($_.Name)=$($_.RemoteAddresses -join ',')" }) | Should -Be @('RokidCoder-wss=192.168.1.0/24,100.64.0.0/10', 'RokidCoder-discovery=192.168.1.0/24,100.64.0.0/10')
    @((Read-MachineState -StatePath $state).objects | ForEach-Object { "$($_.name):$($_.runId)" }) | Should -Be @('RokidCoder-wss:install', 'RokidCoder-discovery:install')
    # A changed rule nobody recorded is never replaced: Apply stops before touching anything.
    Write-MachineState -StatePath $state -State ([pscustomobject]@{ schema = 1; objects = @() })
    $script:created.Clear()
    { Invoke-MachineApply -Mode mirrored -StatePath $state -RunId 'other' } | Should -Throw '*did not create*'
    $script:created | Should -BeNullOrEmpty
    @((Read-MachineState -StatePath $state).objects) | Should -BeNullOrEmpty
  }

  It 'failed_install_reverts_only_this_runs_machine_changes' {
    $state = (Get-RokidPaths).MachineState
    # An earlier install created the mirrored rules; this run adds NAT's.
    Write-MachineState -StatePath $state -State ([pscustomobject]@{ schema = 1; objects = @([pscustomobject]@{ kind = 'hyperv'; name = 'RokidCoder-wss'; ids = @('RokidCoder-wss'); runId = 'earlier'; mode = 'mirrored'; parameters = @{} }) })
    Mock -ModuleName RokidCoder Get-PlanItemDrift { 'absent' }
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

Describe 'firewall filters on the hosted runner, for real' {
  It 'effective_filters_read_back_from_a_real_host_rule' {
    # The property names and the address form Get-EffectiveRuleFilter reads, from a rule Windows really holds.
    $p = (Get-MachinePlan -Mode nat | Where-Object Name -eq 'RokidCoder-proxy').Parameters.Clone()
    $p.Name = "RokidCoder-ci-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $p.DisplayName = 'Rokid Coder CI filter check'
    $p.Group = 'Rokid Coder CI'
    $item = [pscustomobject]@{ Kind = 'firewall'; Name = $p.Name; Cmdlet = 'New-NetFirewallRule'; Parameters = $p }
    try {
      New-NetFirewallRule @p | Out-Null
      @(Get-PlanItemDrift -Item $item) | Should -BeNullOrEmpty -Because "Windows hands back: $((Get-EffectiveRuleFilter -Item $item | ConvertTo-Json -Compress))"
      Disable-NetFirewallRule -Name $p.Name
      @(Get-PlanItemDrift -Item $item) | Should -Be @('Enabled')
      Enable-NetFirewallRule -Name $p.Name
      Set-NetFirewallRule -Name $p.Name -RemoteAddress 'Any'
      @(Get-PlanItemDrift -Item $item) | Should -Be @('RemoteAddresses')
    } finally {
      Remove-NetFirewallRule -Name $p.Name -ErrorAction SilentlyContinue
    }
  }
}
