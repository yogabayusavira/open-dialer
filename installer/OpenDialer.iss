; Open Dialer setup wizard (Inno Setup 6). Build: iscc installer\OpenDialer.iss  ->  installer\Output\OpenDialerSetup.exe
; GitHub builds it on every release tag (.github/workflows/installer.yml).
;
; What it does: shows the tools Open Dialer needs (Node.js and cloudflared come through winget when missing), copies
; the app, then runs installer\finish-setup.cmd: npm install and scripts\setup.mjs, which installs PostgreSQL if it's
; missing (its data in the app's data\postgres folder), creates the opendialer database and writes .env with its
; address and a fresh encryption key.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#define Repo "https://github.com/yogabayusavira/open-dialer"

[Setup]
AppId={{6F1B2C1E-8E4B-4C0C-9F7E-0D1A0E5B7C11}
AppName=Open Dialer
AppVersion={#AppVersion}
AppPublisher=Yoga Bayu Savira
AppPublisherURL={#Repo}
AppSupportURL={#Repo}/issues
DefaultDirName={autopf}\Open Dialer
DisableProgramGroupPage=yes
; No admin rights needed for the app itself; Windows asks for them when Node.js or PostgreSQL get installed.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
LicenseFile=..\NOTICE.md
SetupIconFile=open-dialer.ico
UninstallDisplayIcon={app}\installer\open-dialer.ico
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
OutputDir=Output
OutputBaseFilename=OpenDialerSetup

[Tasks]
Name: "desktopicon"; Description: "Put an Open Dialer shortcut on the desktop"

[Files]
; The app's source. Packages are installed on the PC (npm install), so the installer stays small.
Source: "..\*"; DestDir: "{app}"; Excludes: "\node_modules,\dist,\data,\.git,\.env,\.impeccable,\.claude,\installer\Output,*.tsbuildinfo"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Open Dialer"; Filename: "{app}\Start Open Dialer.bat"; WorkingDir: "{app}"; IconFilename: "{app}\installer\open-dialer.ico"
Name: "{autodesktop}\Open Dialer"; Filename: "{app}\Start Open Dialer.bat"; WorkingDir: "{app}"; IconFilename: "{app}\installer\open-dialer.ico"; Tasks: desktopicon
Name: "{autoprograms}\Finish Open Dialer setup"; Filename: "{app}\installer\finish-setup.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\installer\open-dialer.ico"

[Run]
Filename: "{app}\Start Open Dialer.bat"; WorkingDir: "{app}"; Description: "Start Open Dialer now"; Flags: postinstall nowait shellexec skipifsilent; Check: SetupWorked

[UninstallDelete]
; Your data (data\postgres) and .env stay: uninstalling never deletes leads or keys. Only the build output goes.
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\node_modules"

[Code]
var
  ToolsPage: TWizardPage;
  Worked: Boolean;

function Has(Command: String): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/c where ' + Command, '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

// winget lives in WindowsApps, which isn't always on PATH for programs started from elsewhere.
function Winget: String;
begin
  Result := ExpandConstant('{localappdata}\Microsoft\WindowsApps\winget.exe');
  if not FileExists(Result) then Result := 'winget';
end;

function HasWinget: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\Microsoft\WindowsApps\winget.exe')) or Has('winget');
end;

function HasNode: Boolean;
begin
  Result := Has('node') or FileExists(ExpandConstant('{commonpf64}\nodejs\node.exe'));
end;

function HasCloudflared: Boolean;
begin
  Result := Has('cloudflared') or FileExists(ExpandConstant('{commonpf32}\cloudflared\cloudflared.exe')) or FileExists(ExpandConstant('{commonpf64}\cloudflared\cloudflared.exe'));
end;

function HasPostgres: Boolean;
begin
  Result := Has('psql') or DirExists(ExpandConstant('{commonpf64}\PostgreSQL'));
end;

function SetupWorked: Boolean;
begin
  Result := Worked;
end;

procedure OpenLink(Sender: TObject);
var
  Code: Integer;
begin
  ShellExec('open', TNewStaticText(Sender).Hint, '', '', SW_SHOWNORMAL, ewNoWait, Code);
end;

// One row on the "What gets installed" page: name and status with a "Learn more" link beside it, then what it's for.
function AddTool(Top: Integer; Name, Status, What, Url: String): Integer;
var
  Title, Info, Link: TNewStaticText;
begin
  Title := TNewStaticText.Create(ToolsPage);
  Title.Parent := ToolsPage.Surface;
  Title.Top := Top;
  Title.Caption := Name + ':  ' + Status;
  Title.Font.Style := [fsBold];
  Link := TNewStaticText.Create(ToolsPage);
  Link.Parent := ToolsPage.Surface;
  Link.Top := Top;
  Link.Left := Title.Left + Title.Width + ScaleX(12);
  Link.Caption := 'Learn more';
  Link.Hint := Url;
  Link.Cursor := crHand;
  Link.Font.Color := clBlue;
  Link.Font.Style := [fsUnderline];
  Link.OnClick := @OpenLink;
  Info := TNewStaticText.Create(ToolsPage);
  Info.Parent := ToolsPage.Surface;
  Info.Top := Title.Top + Title.Height + ScaleY(2);
  Info.Width := ToolsPage.SurfaceWidth;
  Info.WordWrap := True;
  Info.Caption := What;
  Result := Info.Top + Info.Height + ScaleY(10);
end;

function State(Present: Boolean): String;
begin
  if Present then Result := 'already on this PC' else Result := 'will be installed';
end;

procedure InitializeWizard;
var
  Top: Integer;
begin
  ToolsPage := CreateCustomPage(wpLicense, 'What gets installed', 'Open Dialer needs a few tools. Anything already on this PC is skipped.');
  Top := 0;
  Top := AddTool(Top, 'Node.js', State(HasNode), 'Runs Open Dialer on this computer.', 'https://nodejs.org');
  Top := AddTool(Top, 'PostgreSQL 17', State(HasPostgres), 'The database for your leads, calls and settings, kept in the folder you pick next. If you already have PostgreSQL, setup asks for its admin password once.', 'https://www.postgresql.org');
  Top := AddTool(Top, 'cloudflared', State(HasCloudflared), 'A Cloudflare tunnel, so Twilio can reach this computer when you call.', 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/');
  Top := AddTool(Top, 'winget', 'part of Windows', 'Windows'' own installer, used to install the tools above.', 'https://learn.microsoft.com/windows/package-manager/winget/');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ToolsPage.ID) and (not HasWinget) and not (HasNode and HasCloudflared and HasPostgres) then
  begin
    MsgBox('winget isn''t on this PC, so the missing tools can''t be installed for you.' + #13#10#13#10 +
      'Install "App Installer" from the Microsoft Store, then run this setup again. Or install the tools yourself from the links on this page.', mbError, MB_OK);
    Result := False;
  end;
end;

// Runs one install command in a window you can see, so winget's own prompts can be answered.
procedure Step(Caption, Command: String);
var
  Code: Integer;
begin
  WizardForm.StatusLabel.Caption := Caption;
  Exec(ExpandConstant('{cmd}'), '/c "' + Command + '"', '', SW_SHOW, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  if not HasNode then Step('Installing Node.js...', '"' + Winget + '" install -e --id OpenJS.NodeJS.LTS --source winget');
  if not HasCloudflared then Step('Installing cloudflared...', '"' + Winget + '" install -e --id Cloudflare.cloudflared --source winget');
  WizardForm.StatusLabel.Caption := 'Setting up PostgreSQL, Open Dialer''s packages and your settings (.env)...';
  Worked := Exec(ExpandConstant('{app}\installer\finish-setup.cmd'), '', ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Worked then
    MsgBox('Open Dialer is installed, but setting it up didn''t finish (the window that just closed says why). Fix that, then open "Finish Open Dialer setup" from the Start menu.', mbError, MB_OK);
end;
