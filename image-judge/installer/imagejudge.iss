; ImageJudge Windows 安装包（Inno Setup 6，文档 §17、T027）
;
; 构建步骤：
;   1. 在 apps/desktop 执行: pyinstaller imagejudge.spec --noconfirm
;   2. 用 Inno Setup Compiler 编译本脚本（或 iscc imagejudge.iss）
;
; 注意：
;   - 源目录为 PyInstaller onedir 产物 dist\ImageJudge
;   - 用户数据（SQLite/日志）位于 %LOCALAPPDATA%\ImageJudge，卸载时默认保留
;   - 平台模式客户端不携带任何平台 DashScope Key（验收 A09）

#define MyAppName "ImageJudge"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "zhangyvjing.com"
#define MyAppURL "https://zhangyvjing.com"
#define MyAppExeName "ImageJudge.exe"
; PyInstaller onedir 产物目录（相对本脚本所在目录）
#define PyInstallerOut "..\apps\desktop\dist\ImageJudge"

[Setup]
AppId={{B7E4C2A1-5D93-4F6E-8A2C-9E1D0F3B6A74}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
; 中文界面
ShowLanguageDialog=auto
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=ImageJudge-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
; 安装前关闭正在运行的程序
CloseApplications=yes
RestartApplications=no
; 可选代码签名：正式发行时启用
; SignTool=signtool sign /fd SHA256 /tr http://timestamp.sectigo.com $f
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; PyInstaller onedir 全部产物
Source: "{#PyInstallerOut}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 仅清理临时残留（CSV 原子写失败残留的 .tmp）；不删除用户数据
Type: filesandordirs; Name: "{app}"

[Code]
// 卸载时询问是否删除用户数据（%LOCALAPPDATA%\ImageJudge，含 SQLite 与日志）
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  UserDataDir: string;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    UserDataDir := ExpandConstant('{localappdata}\ImageJudge');
    if DirExists(UserDataDir) then
    begin
      if MsgBox('是否同时删除本地数据（数据库与日志）？' + #13#10 + UserDataDir,
        mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(UserDataDir, True, True, True);
      end;
    end;
  end;
end;
