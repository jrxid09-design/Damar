; DAMAR per-user installer (Inno Setup 6). Built by scripts/release/build-release.cjs, which passes:
;   /DAppVersion=1.0.0 /DStageDir=<staged ship set> /DOutDir=<dist> /DOutName=<file name> [/DSignEnabled /Sdamarsign=...]
#ifndef AppVersion
  #error AppVersion is required
#endif

[Setup]
AppId={{6E0B3C52-8D5E-4D57-9A3A-DA3A2C10B0F1}
AppName=DAMAR
AppVersion={#AppVersion}
AppVerName=DAMAR {#AppVersion}
AppPublisher=DAMAR
VersionInfoVersion={#AppVersion}
VersionInfoProductName=DAMAR
VersionInfoDescription=DAMAR Setup
DefaultDirName={localappdata}\Programs\DAMAR
DisableDirPage=yes
DefaultGroupName=DAMAR
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
; Per-user, never elevated: Windows RedirectionGuard (on by default since Inno 6.5) protects elevated installers from junction
; planting, but here it would also block users whose %LOCALAPPDATA% is a junction, and it is inherited by the shutdown
; helper, which then cannot find the running Core. Nothing this installer writes is reachable with more rights than the user's.
RedirectionGuard=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename={#OutName}
SetupIconFile={#StageDir}\release\damar.ico
UninstallDisplayIcon={app}\release\damar.ico
UninstallDisplayName=DAMAR
LicenseFile={#StageDir}\LICENSE.txt
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
CloseApplications=no
UsePreviousTasks=yes
TimeStampsInUTC=yes
; /DAMARSMOKE (release smoke test only): no shortcuts, no Add/Remove Programs entry, no PATH/Run changes in the real profile.
CreateUninstallRegKey=not IsSmoke
#ifdef SignEnabled
SignTool=damarsign
SignedUninstaller=yes
#endif

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start DAMAR Presence when I sign in"; Flags: unchecked
Name: "addpath"; Description: "Add the ""damar"" command to my PATH"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Upgrade in place: replace program folders wholesale so files removed from a release do not linger. User data is elsewhere.
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\core-snapshot"
Type: filesandordirs; Name: "{app}\inherited-v53"
Type: filesandordirs; Name: "{app}\python-vendor"
Type: filesandordirs; Name: "{app}\w5-cli"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\release"
Type: filesandordirs; Name: "{app}\docs"

[Icons]
Name: "{userprograms}\DAMAR\DAMAR CLI"; Filename: "{app}\damar.cmd"; WorkingDir: "{%USERPROFILE}"; IconFilename: "{app}\release\damar.ico"; Comment: "DAMAR command-line agent"; Check: not IsSmoke
Name: "{userprograms}\DAMAR\DAMAR Control"; Filename: "{app}\runtime\electron\electron.exe"; Parameters: """{app}\release\gui-launch"" control"; WorkingDir: "{app}"; IconFilename: "{app}\release\damar.ico"; Comment: "Open the DAMAR Control dashboard"; Check: not IsSmoke
Name: "{userprograms}\DAMAR\DAMAR Presence"; Filename: "{app}\runtime\electron\electron.exe"; Parameters: """{app}\release\gui-launch"" presence"; WorkingDir: "{app}"; IconFilename: "{app}\release\damar.ico"; Comment: "Start DAMAR Idle Presence and Notch"; Check: not IsSmoke
Name: "{autodesktop}\Damar"; Filename: "{app}\runtime\electron\electron.exe"; Parameters: """{app}\release\gui-launch"" presence"; WorkingDir: "{app}"; IconFilename: "{app}\release\damar.ico"; Comment: "Start DAMAR Idle Presence and Notch"; Check: not IsSmoke
Name: "{userprograms}\DAMAR\DAMAR Documentation"; Filename: "{app}\docs"; Check: not IsSmoke

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "DAMAR Presence"; ValueData: """{app}\runtime\electron\electron.exe"" ""{app}\release\gui-launch"" presence"; Flags: uninsdeletevalue; Tasks: autostart; Check: not IsSmoke

[Run]
Filename: "{app}\damar.cmd"; Description: "Open DAMAR CLI now"; WorkingDir: "{%USERPROFILE}"; Flags: postinstall nowait skipifsilent unchecked shellexec
Filename: "{app}\docs"; Description: "Open the documentation folder"; Flags: postinstall nowait skipifsilent shellexec unchecked

[UninstallRun]
Filename: "{app}\inherited-v53\node.exe"; Parameters: """{app}\release\damar.cjs"" shutdown"; Flags: runhidden waituntilterminated; RunOnceId: "DamarShutdown"

[Code]
const EnvKey = 'Environment';

function IsSmoke: Boolean;
var I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do if CompareText(ParamStr(I), '/DAMARSMOKE') = 0 then Result := True;
end;

function PathHas(Paths, Dir: string): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0;
end;

procedure AddToUserPath(Dir: string);
var Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then Paths := '';
  if PathHas(Paths, Dir) then exit;
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + Dir);
end;

procedure RemoveFromUserPath(Dir: string);
var Paths: string; P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then exit;
  Paths := ';' + Paths + ';';
  P := Pos(';' + Uppercase(Dir) + ';', Uppercase(Paths));
  if P = 0 then exit;
  Delete(Paths, P, Length(Dir) + 1);
  if Copy(Paths, 1, 1) = ';' then Delete(Paths, 1, 1);
  if Copy(Paths, Length(Paths), 1) = ';' then Delete(Paths, Length(Paths), 1);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths);
end;

// Upgrade in place: stop the running Presence/Core of the existing install before files are replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; Old: string;
begin
  Result := '';
  Old := ExpandConstant('{app}');
  if FileExists(Old + '\release\damar.cjs') and FileExists(Old + '\inherited-v53\node.exe') then
    Exec(Old + '\inherited-v53\node.exe', '"' + Old + '\release\damar.cjs" shutdown', Old, SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if IsSmoke then exit;
    if WizardIsTaskSelected('addpath') then AddToUserPath(ExpandConstant('{app}'))
    else RemoveFromUserPath(ExpandConstant('{app}'));
  end;
end;

function HasParam(Name: string): Boolean;
var I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do if CompareText(ParamStr(I), Name) = 0 then Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Data: string;
begin
  if CurUninstallStep = usUninstall then RemoveFromUserPath(ExpandConstant('{app}'));
  if CurUninstallStep = usPostUninstall then
  begin
    // Same location the launcher uses (LOCALAPPDATA environment variable).
    Data := GetEnv('LOCALAPPDATA') + '\DAMAR';
    if not DirExists(Data) then exit;
    // Default keeps user data. Silent uninstall removes it only with /PURGE.
    if HasParam('/PURGE') or ((not UninstallSilent) and (MsgBox('Also remove your DAMAR data?' + #13#10#13#10 + Data + #13#10#13#10 +
       'This deletes sessions, settings, saved provider keys and logs. Choose No to keep them for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES)) then
      DelTree(Data, True, True, True);
  end;
end;
