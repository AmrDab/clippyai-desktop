import { describe, it, expect } from 'vitest';
import { shellBlockReason, isProtectedShellCwd } from '../src/main/shell-guard';

// Refused even when the user clicked Approve.
const BLOCKED: string[] = [
  // Unix (pre-existing)
  'rm -rf /', 'rm -rf ~', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sdb1', ':(){ :|:& };:',
  // macOS
  'sudo rm -rf /System', 'rm -rf /Library', 'rm -rf /Applications', 'rm -rf /Users', 'rm -rf /Users/amr', 'rm -rf /Users/amr/',
  'rm -fr /usr', 'rm -rf "/Applications"', 'rm -rf /Users/amr/*', 'ls; rm -rf /etc',
  'diskutil eraseDisk APFS Foo disk2', 'diskutil eraseVolume HFS+ x /Volumes/x', 'diskutil secureErase 0 disk3',
  'diskutil apfs deleteContainer disk1', 'diskutil zeroDisk disk2', 'csrutil disable', 'csrutil authenticated-root disable',
  'sudo spctl --master-disable', 'spctl --global-disable', 'tmutil deletelocalsnapshots 2024', 'tmutil delete /Volumes/B/x',
  // format
  'format C:', 'format d: /q /y', 'format.com E: /FS:NTFS', 'cmd /c format c: /q',
  'powershell -Command Format-Volume -DriveLetter D', 'Clear-Disk -Number 1 -RemoveData',
  // rd / del on roots
  'rd /s /q C:\\', 'rmdir /s /q c:\\', 'RD /S /Q "C:\\Windows"', 'rd /s C:\\Windows\\',
  'rmdir /q /s "C:\\Program Files"', 'rd /s /q "C:\\Program Files (x86)"', 'rd /s /q C:\\Users\\amr_d',
  'rd /s /q %USERPROFILE%', 'rd /s /q %SystemRoot%', 'del /f /s /q C:\\*', 'erase /s /q c:\\windows\\*.*',
  'dir && rd /s /q D:\\', 'r^d /s /q C:\\', 'rd /s /q C:\\Users',
  // Remove-Item -Recurse on roots
  'Remove-Item -Recurse -Force C:\\', 'Remove-Item -Path C:\\Windows -Recurse -Force',
  'Remove-Item -LiteralPath "C:\\Program Files" -Recurse', 'ri -r -fo $env:USERPROFILE',
  'Remove-Item -Recurse -Force ~', 'rm -r -fo C:\\Users\\amr_d\\', 'Remove-Item $HOME -Recurse',
  'powershell -c "Remove-Item -Recurse -Force C:\\*"', 'Remove-Item -Rec ${env:ProgramFiles(x86)}',
  // registry
  'reg delete HKLM\\SOFTWARE\\Microsoft /f', 'reg.exe delete "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet" /f',
  'Remove-Item -Path HKLM:\\SOFTWARE\\Foo -Recurse',
  // shadows / backups / boot
  'vssadmin delete shadows /all /quiet', 'vssadmin.exe Delete Shadows /For=C:', 'wmic shadowcopy delete',
  'wbadmin delete catalog -quiet', 'wbadmin delete systemstatebackup', 'bcdedit /set {default} recoveryenabled No',
  'bcdedit /deletevalue safeboot', 'bcdedit.exe /delete {current}',
  // cipher
  'cipher /w:C:\\', 'cipher /w C:\\Users',
  // Defender / firewall
  'Set-MpPreference -DisableRealtimeMonitoring $true', 'powershell Set-MpPreference -DisableIOAVProtection 1',
  'Set-MpPreference -DisableBehaviorMonitoring:$true',
  'reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender" /v DisableAntiSpyware /t REG_DWORD /d 1 /f',
  'sc stop WinDefend', 'sc config WinDefend start= disabled', 'net stop mpssvc', 'Stop-Service -Name WinDefend -Force',
  'Set-Service mpssvc -StartupType Disabled', 'netsh advfirewall set allprofiles state off',
  'netsh firewall set opmode disable', 'Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled False',
  // scheduled tasks as SYSTEM
  'schtasks /create /tn x /tr C:\\evil.exe /sc onlogon /ru SYSTEM', 'schtasks /Create /RU "NT AUTHORITY\\SYSTEM" /TN t /TR x /SC daily',
  'Register-ScheduledTask -TaskName x -Action $a -User SYSTEM', 'New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\\SYSTEM" -LogonType ServiceAccount',
  // takeown
  'takeown /f C:\\Windows\\System32 /r /d y', 'takeown /r /d y /f "C:\\Program Files"', 'takeown /f C:\\ /r',
];

// Harmless look-alikes that must still run.
const ALLOWED: string[] = [
  'dir', 'git status', 'git log --format=%H -n 5', 'git log --format c:%s', 'Get-Process | Format-Table',
  'Get-ChildItem | Format-List', 'npm run format', 'prettier --write . && npm run format:check',
  'echo hello', 'ipconfig /all', 'systeminfo', 'tasklist',
  'rd /s /q build', 'rd /s /q C:\\Users\\amr_d\\project\\node_modules', 'rmdir /s /q "%TEMP%\\clippy-tmp"',
  'rd C:\\Users\\amr_d\\empty', 'del C:\\Users\\amr_d\\notes.txt', 'del /q *.log', 'rd /s /q "C:\\Program Files\\MyApp\\cache"',
  'Remove-Item -Recurse -Force .\\dist', 'Remove-Item -Recurse C:\\Users\\amr_d\\tmp\\build',
  'Remove-Item C:\\Users\\amr_d\\file.txt', 'Remove-Item -Recurse ~\\Downloads\\old', 'rm -r node_modules',
  'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', 'reg delete HKCU\\Software\\MyApp /f',
  'reg add HKCU\\Software\\MyApp /v Theme /d dark /f',
  'vssadmin list shadows', 'wbadmin get versions', 'bcdedit', 'bcdedit /enum', 'bcdedit /enum all /v',
  'cipher /c secret.txt', 'cipher', 'Set-MpPreference -DisableRealtimeMonitoring $false',
  'Set-MpPreference -ExclusionExtension .tmp', 'Get-MpComputerStatus', 'sc query WinDefend', 'net start mpssvc',
  'Get-Service WinDefend', 'netsh advfirewall show allprofiles', 'netsh advfirewall set allprofiles state on',
  'Set-NetFirewallProfile -Enabled True', 'schtasks /query /fo LIST', 'schtasks /create /tn backup /tr C:\\b.cmd /sc daily',
  'schtasks /run /tn SYSTEMcheck', 'Register-ScheduledTask -TaskName x -Action $a -User amr_d',
  'takeown /f C:\\Users\\amr_d\\locked.txt', 'takeown /f D:\\data\\folder /r /d y', 'icacls C:\\Users\\amr_d\\x',
  'rm -rf /Users/amr/project/build', 'rm -rf /tmp/clippy', 'rm -rf /var/tmp/x', 'rm -rf /usr/local/share/foo',
  'rm -rf ~/Downloads/old', 'rm file.txt', 'diskutil list', 'diskutil info disk1', 'diskutil mount disk2',
  'csrutil status', 'spctl --status', 'spctl --assess -v app.app', 'tmutil listbackups', 'tmutil latestbackup',
  'echo formatted output', 'python -c "print(1)"', 'curl https://example.com',
];

describe('shellBlockReason', () => {
  it.each(BLOCKED)('blocks %s', (cmd) => {
    expect(shellBlockReason(cmd)).not.toBeNull();
  });
  it.each(ALLOWED)('allows %s', (cmd) => {
    expect(shellBlockReason(cmd)).toBeNull();
  });
  it('names what it refused', () => {
    expect(shellBlockReason('vssadmin delete shadows /all')).toBe('deleting shadow copies');
    expect(shellBlockReason('format C:')).toBe('formatting a drive');
  });
});

describe('isProtectedShellCwd', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  it.each([
    '/', '/System', '/System/Library', 'C:\\', 'C:', 'c:/', 'D:\\', 'C:\\Windows', 'c:\\windows\\', 'C:\\Windows\\System32',
    'C:\\Program Files', 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\..\\Windows',
  ])('refuses %s', (cwd) => {
    expect(isProtectedShellCwd(cwd, env)).toBe(true);
  });
  it.each([
    '/Users/me', '/tmp', 'C:\\Users\\amr_d', 'C:\\Users\\amr_d\\Desktop', 'D:\\projects', 'C:\\WindowsApps-backup', 'C:\\Program Files Data',
  ])('allows %s', (cwd) => {
    expect(isProtectedShellCwd(cwd, env)).toBe(false);
  });
});
