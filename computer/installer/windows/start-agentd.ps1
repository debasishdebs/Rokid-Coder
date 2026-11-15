<#
  The \RokidCoder\agentd task's action, one copy per generation:
  %LOCALAPPDATA%\Programs\RokidCoder\<gen>\start-agentd.ps1 -Binding <its own binding-<gen>.json>.
  It is self-contained (no module import), so a rollback to this generation
  runs exactly the launcher it was staged with [6b-R10].

  1. Reads the binding.
  2. NAT mode only: writes the advertised endpoint (the Windows host's IPv4s and
     the port proxy) through `rokid-setup advertise set` [6b-R3].
  3. Runs the bound distro's agentd as the bound Linux user: --exec with argv,
     no shell, no ~.
#>
param(
  [Parameter(Mandatory = $true)][string]$Binding
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$b = Get-Content -LiteralPath $Binding -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($field in 'distroName', 'linuxUser', 'agentdPath', 'bundleDir', 'wslExe', 'networkMode', 'advertisePort') {
  if (-not $b.$field) { throw "The binding $Binding has no $field" }
}
if (-not $b.agentdPath.StartsWith('/') -or $b.agentdPath.Contains('~')) { throw "agentdPath must be absolute: $($b.agentdPath)" }
$env:WSL_UTF8 = '1'

if ($b.networkMode -eq 'nat') {
  $hosts = New-Object System.Collections.Generic.List[string]
  $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $tailscale) {
    foreach ($line in @(& $tailscale ip -4 2>$null)) {
      if ("$line".Trim() -match '^\d{1,3}(\.\d{1,3}){3}$') { $hosts.Add("$line".Trim()) }
    }
  }
  foreach ($config in @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' })) {
    foreach ($address in @($config.IPv4Address)) {
      if ($address.IPAddress -and -not $hosts.Contains($address.IPAddress)) { $hosts.Add($address.IPAddress) }
    }
  }
  if ($hosts.Count -gt 0) {
    & $b.wslExe -d $b.distroName -u $b.linuxUser --exec "$($b.bundleDir)/bin/rokid-setup" advertise set --hosts ($hosts -join ',') --port ([string]$b.advertisePort)
  }
}

& $b.wslExe -d $b.distroName -u $b.linuxUser --exec $b.agentdPath run
exit $LASTEXITCODE
