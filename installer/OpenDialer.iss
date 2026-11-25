; Open Dialer setup wizard (Inno Setup 6). Build: iscc installer\OpenDialer.iss  ->  installer\Output\OpenDialerSetup.exe
; GitHub builds it on every release tag (.github/workflows/installer.yml).
;
; What it does: shows the free tools Open Dialer needs (installed only when missing, through winget), lets you pick
; where your data lives, copies the app, then runs installer\finish-setup.cmd: npm install and scripts\setup.mjs,
; which writes .env with a fresh encryption key (and the database address for PostgreSQL).

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
; No admin rights needed for the app itself; winget asks for them when Node.js or Docker need installing.
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
Name: "{autoprograms}\Finish Open Dialer setup (Docker)"; Filename: "{app}\installer\finish-setup.cmd"; Parameters: "docker"; WorkingDir: "{app}"; IconFilename: "{app}\installer\open-dialer.ico"; Check: UseDocker

[Run]
Filename: "{app}\Start Open Dialer.bat"; WorkingDir: "{app}"; Description: "Start Open Dialer now"; Flags: postinstall nowait shellexec skipifsilent; Check: SetupWorked

[UninstallDelete]
; Your data and .env stay: uninstalling never deletes leads or keys. Only the build output goes.
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\node_modules"

[Code]
var
  ToolsPage: TWizardPage;
  DbPage: TInputOptionWizardPage;
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

function HasDocker: Boolean;
begin
  Result := Has('docker') or FileExists(ExpandConstant('{commonpf64}\Docker\Docker\Docker Desktop.exe'));
end;

function UseDocker: Boolean;
begin
  Result := Assigned(DbPage) and DbPage.Values[1];
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

// One row on the "What gets installed" page: name and status, what it's for, and a link to read more.
function AddTool(Top: Integer; Name, Status, What, Url: String): Integer;
var
  Title, Info, Link: TNewStaticText;
begin
  Title := TNewStaticText.Create(ToolsPage);
  Title.Parent := ToolsPage.Surface;
  Title.Top := Top;
  Title.Caption := Name + ':  ' + Status;
  Title.Font.Style := [fsBold];
  Info := TNewStaticText.Create(ToolsPage);
  Info.Parent := ToolsPage.Surface;
  Info.Top := Title.Top + ScaleY(17);
  Info.Width := ToolsPage.SurfaceWidth;
  Info.WordWrap := True;
  Info.Caption := What;
  Link := TNewStaticText.Create(ToolsPage);
  Link.Parent := ToolsPage.Surface;
  Link.Top := Info.Top + Info.Height + ScaleY(2);
  Link.Caption := 'Learn more: ' + Url;
  Link.Hint := Url;
  Link.Cursor := crHand;
  Link.Font.Color := clBlue;
  Link.Font.Style := [fsUnderline];
  Link.OnClick := @OpenLink;
  Result := Link.Top + Link.Height + ScaleY(12);
end;

function State(Present: Boolean): String;
begin
  if Present then Result := 'already on this PC' else Result := 'will be installed';
end;

procedure InitializeWizard;
var
  Top: Integer;
begin
  ToolsPage := CreateCustomPage(wpLicense, 'What gets installed', 'Open Dialer uses a few free tools. Anything already on this PC is skipped.');
  Top := 0;
  Top := AddTool(Top, 'Node.js', State(HasNode), 'Runs Open Dialer on this computer.', 'https://nodejs.org');
  Top := AddTool(Top, 'cloudflared', State(HasCloudflared), 'A free Cloudflare tunnel, so Twilio can reach this computer when you call.', 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/');
  Top := AddTool(Top, 'Docker Desktop', 'only if you pick PostgreSQL next', 'Runs the PostgreSQL database. Free for small businesses; it may ask you to restart Windows.', 'https://www.docker.com/products/docker-desktop/');
  Top := AddTool(Top, 'winget', 'part of Windows', 'Windows'' own installer, used to install the tools above.', 'https://learn.microsoft.com/windows/package-manager/winget/');

  DbPage := CreateInputOptionPage(ToolsPage.ID, 'Where to keep your data', 'Your leads, calls and settings stay on this computer either way.',
    'Pick one. You can move to PostgreSQL later.', True, False);
  DbPage.Add('Simple (recommended): a file in the Open Dialer folder. Nothing else to install.');
  DbPage.Add('PostgreSQL in Docker: for larger teams. Installs Docker Desktop.');
  DbPage.Values[0] := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ToolsPage.ID) and (not HasWinget) and not (HasNode and HasCloudflared) then
  begin
    MsgBox('winget isn''t on this PC, so the missing tools can''t be installed for you.' + #13#10#13#10 +
      'Install "App Installer" from the Microsoft Store, then run this setup again. Or install Node.js and cloudflared yourself from the links on this page.', mbError, MB_OK);
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
  Args: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if not HasNode then Step('Installing Node.js...', '"' + Winget + '" install -e --id OpenJS.NodeJS.LTS --source winget');
  if not HasCloudflared then Step('Installing cloudflared...', '"' + Winget + '" install -e --id Cloudflare.cloudflared --source winget');
  if UseDocker and not HasDocker then Step('Installing Docker Desktop...', '"' + Winget + '" install -e --id Docker.DockerDesktop --source winget');
  WizardForm.StatusLabel.Caption := 'Installing Open Dialer''s packages and writing your settings (.env)...';
  if UseDocker then Args := 'docker' else Args := '';
  Worked := Exec(ExpandConstant('{app}\installer\finish-setup.cmd'), Args, ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Worked then
  begin
    if UseDocker then
      MsgBox('Open Dialer is installed, but the database isn''t set up yet. Docker Desktop usually needs its first start, and sometimes a restart of Windows.' + #13#10#13#10 +
        'Once Docker Desktop is running, open "Finish Open Dialer setup (Docker)" from the Start menu.', mbInformation, MB_OK)
    else
      MsgBox('Open Dialer is installed, but setting it up didn''t finish (see the window that just closed). Check your internet connection, then run installer\finish-setup.cmd in the Open Dialer folder.', mbError, MB_OK);
  end;
end;
