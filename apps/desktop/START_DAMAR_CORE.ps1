param([Parameter(Mandatory=$true)][string]$Session,[switch]$Resume,[string]$RecoverFrom,[ValidateRange(1024,65535)][int]$Port=29623,[string]$KeyStore,[string]$SettingsFile,[string]$SandboxRegistry)
# Starts the run-owned isolated DAMAR Core host on 127.0.0.1:29623 (foreground; Ctrl+C stops it).
#   New session : -Session <NEW dir under D:\Damar\R9_WORK\r7r3-scratch>
#   Clean resume: -Session <dir that was stopped cleanly> -Resume
#   After crash : -Session <NEW dir> -RecoverFrom <crashed dir>   (new identity, rotated credentials, no grants)
# No existing listener or process is ever touched.
$ErrorActionPreference='Stop'
foreach($v in @($Session,$RecoverFrom)){ if($v -and ($v.Contains('"') -or $v -match '[\r\n]')){ throw 'Invalid session path.' } }
if($Resume -and $RecoverFrom){ throw 'Use either -Resume or -RecoverFrom.' }
$Node=Join-Path $PSScriptRoot 'inherited-v53\node.exe'
$Entry=Join-Path $PSScriptRoot 'src\core-host\core-host.cjs'
$NodeArgs=@($Entry,$Session.TrimEnd('\'))
if($Resume){ $NodeArgs+='--resume' }
if($RecoverFrom){ $NodeArgs+=@('--recover-from',$RecoverFrom.TrimEnd('\')) }
$PreviousSettingsFile=$env:DAMAR_CORE_SETTINGS_FILE
$PreviousPort=$env:DAMAR_CORE_PORT;$PreviousKeyStore=$env:DAMAR_KEY_STORE;$PreviousSandboxRegistry=$env:DAMAR_SANDBOX_REGISTRY
$env:DAMAR_CORE_PORT=[string]$Port
$env:DAMAR_CORE_SETTINGS_FILE=if($SettingsFile){$SettingsFile}else{'D:\Damar\R9_WORK\r7r3-scratch\damar-cli-profile\core-settings.json'}
if($KeyStore){$env:DAMAR_KEY_STORE=$KeyStore};if($SandboxRegistry){$env:DAMAR_SANDBOX_REGISTRY=$SandboxRegistry}
try {
  & $Node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Core host exited with code $LASTEXITCODE. No other process was terminated." }
} finally {
 if ($null -eq $PreviousSettingsFile) { Remove-Item Env:DAMAR_CORE_SETTINGS_FILE -ErrorAction SilentlyContinue }
  else { $env:DAMAR_CORE_SETTINGS_FILE=$PreviousSettingsFile }
 if ($null -eq $PreviousPort) { Remove-Item Env:DAMAR_CORE_PORT -ErrorAction SilentlyContinue } else { $env:DAMAR_CORE_PORT=$PreviousPort }
 if ($null -eq $PreviousKeyStore) { Remove-Item Env:DAMAR_KEY_STORE -ErrorAction SilentlyContinue } else { $env:DAMAR_KEY_STORE=$PreviousKeyStore }
 if ($null -eq $PreviousSandboxRegistry) { Remove-Item Env:DAMAR_SANDBOX_REGISTRY -ErrorAction SilentlyContinue } else { $env:DAMAR_SANDBOX_REGISTRY=$PreviousSandboxRegistry }
}
