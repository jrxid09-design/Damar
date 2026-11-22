# damar                    new session
# damar resume [id]        session picker, or resume one session (full id or unique 8+ character prefix)
# damar sessions           list saved sessions
# -Session <Core dir> selects the private Core data directory; the profile remembers the last one.
param([Parameter(Position=0)][string]$Verb,[Parameter(Position=1)][string]$Target,[string]$Session,[Alias('Profile')][string]$UiProfile,[string]$CoreUrl)
$ErrorActionPreference='Stop'
# Default profile: <DAMAR_DATA_ROOT>\profile (installed product), else the development scratch folder two levels above this checkout.
if (-not $UiProfile) { $UiProfile=if($env:DAMAR_DATA_ROOT){Join-Path $env:DAMAR_DATA_ROOT 'profile'}else{[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\r7r3-scratch\damar-cli-profile'))} }
$Node=Join-Path $PSScriptRoot 'inherited-v53\node.exe'
$Entry=Join-Path $PSScriptRoot 'src\cli\w5-main.cjs'
if ($Verb -and $Verb -notin @('resume','sessions')) { throw "Unknown command '$Verb'. Use: damar, damar resume [session-id], damar sessions." }
if ($Target -and ($Verb -ne 'resume' -or $Target -notmatch '^[A-Fa-f0-9]{8,64}$')) { throw 'Invalid session id.' }
if (-not ('DamarCliConsoleMode' -as [type])) {
 Add-Type 'using System; using System.Runtime.InteropServices; public static class DamarCliConsoleMode { [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h,out uint mode); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h,uint mode); }'
}
$InputHandle=[DamarCliConsoleMode]::GetStdHandle(-10)
[uint32]$InputMode=0
$HasInputMode=[DamarCliConsoleMode]::GetConsoleMode($InputHandle,[ref]$InputMode)
$StartInfo=New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName=$Node
$StartInfo.UseShellExecute=$false
$StartInfo.WorkingDirectory=$PSScriptRoot
$StartInfo.EnvironmentVariables['DAMAR_CLI_RESTARTABLE']='1'
# The agent's workspace is the directory DAMAR was launched from (protected sources are refused by Core).
$StartInfo.EnvironmentVariables['DAMAR_WORKSPACE']=(Get-Location).ProviderPath
if ($Session -and ($Session.Contains('"') -or $Session -match '[\r\n]')) { throw 'Invalid session path.' }
if ($UiProfile -and ($UiProfile.Contains('"') -or $UiProfile -match '[\r\n]')) { throw 'Invalid profile path.' }
$StartInfo.Arguments='"'+$Entry+'"'
if ($Session) { $StartInfo.Arguments+=' --session "'+$Session.TrimEnd('\')+'"' }
# Private cross-session profile: theme, banner and last provider/model (never credentials).
if ($UiProfile) { New-Item -ItemType Directory -Force $UiProfile | Out-Null; $StartInfo.Arguments+=' --profile "'+$UiProfile.TrimEnd('\')+'"' }
if ($CoreUrl) { $u=$null;if(-not [Uri]::TryCreate($CoreUrl,[UriKind]::Absolute,[ref]$u) -or $u.Scheme -ne 'http' -or $u.Host -ne '127.0.0.1' -or $u.AbsolutePath -ne '/' -or $u.Query -or $u.Fragment){throw 'Invalid loopback Core URL.'};$StartInfo.EnvironmentVariables['DAMAR_CORE_URL']=$u.GetLeftPart([UriPartial]::Authority) }
$BaseArguments=$StartInfo.Arguments
if ($Verb) { $StartInfo.Arguments+=' '+$Verb; if ($Target) { $StartInfo.Arguments+=' '+$Target.ToLowerInvariant() } }
try {
  do {
   $Child=[System.Diagnostics.Process]::Start($StartInfo)
   $Child.WaitForExit()
   $Code=$Child.ExitCode
   $Child.Dispose();$Child=$null
   if ($Code -eq 75) {
    $Marker=Join-Path $UiProfile 'cli-restart-session.json'
    if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) { throw 'CLI_RESTART_SESSION_MARKER_MISSING' }
    try { $ResumeState=Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json } catch { throw 'CLI_RESTART_SESSION_MARKER_INVALID' }
    if ($ResumeState.sessionId -notmatch '^[a-f0-9]{64}$') { throw 'CLI_RESTART_SESSION_MARKER_INVALID' }
    Remove-Item -LiteralPath $Marker -ErrorAction Stop
    $StartInfo.Arguments=$BaseArguments+' resume '+$ResumeState.sessionId
   }
  } while ($Code -eq 75)
} finally {
 if ($HasInputMode) { [DamarCliConsoleMode]::SetConsoleMode($InputHandle,$InputMode) | Out-Null }
 if ($Child) { $Child.Dispose() }
}
if ($Code -ne 0) { throw "CLI exited with code $Code. No service or terminal host was terminated." }
