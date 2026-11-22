param([Parameter(Mandatory=$true)][string]$Session,[switch]$Console,[switch]$Check)
$ErrorActionPreference='Stop'
if (!$Console -and !$Check) {
  Start-Process powershell.exe -ArgumentList @('-NoProfile','-NoExit','-File',('"'+$PSCommandPath+'"'),'-Session',('"'+$Session+'"'),'-Console')
  exit
}
$Product=Split-Path $PSScriptRoot -Parent
$Node=Join-Path $Product 'node.exe'
if (!(Test-Path $Node)) { $Node=(Get-Command node.exe -ErrorAction Stop).Source }
$Cli=Join-Path $Product 'scripts\r7r3-cli.cjs'
$Descriptor=Get-Content -LiteralPath (Join-Path $Session 'session.json') -Raw | ConvertFrom-Json
if ($Descriptor.address -ne 'http://127.0.0.1:29623') { throw 'Wrong session endpoint. No fallback.' }
$script:DamarNode=$Node
$script:DamarCli=$Cli
$script:DamarSession=$Session
function global:damar { & $script:DamarNode $script:DamarCli $script:DamarSession @args }
if ($Check) {
  damar --help
  if ($LASTEXITCODE -ne 0) { throw 'CLI help failed.' }
  damar status --json
  if ($LASTEXITCODE -ne 0) { throw 'CLI service status failed.' }
  damar jobs --json
  if ($LASTEXITCODE -ne 0) { throw 'CLI jobs failed.' }
  exit 0
}
Write-Host 'DAMAR private CLI | 127.0.0.1:29623 | same service as Desktop'
Write-Host 'Credentials stay in the session folder and are not printed.'
Write-Host 'damar --help'
Write-Host 'damar status --json'
Write-Host 'damar jobs --json'
Write-Host 'Safe plan example (PowerShell stdin JSON):'
Write-Host '''{"text":"Owner synthetic SHA256 demo","syntheticData":true}'' | damar job plan - --json'
Write-Host 'Approve: ''{"planId":"COPY_ACTUAL_ID","version":1}'' | damar job approve - --owner --json'
Write-Host 'Execute requires actual plan/version and approvalId; verify uses actual plan/version. Use --help. Do not screenshot grants.'
damar --help
