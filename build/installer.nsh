; electron-builder auto-includes this file via the nsis.include config in
; electron-builder.yml. customInit fires before any installation steps — we
; use it to kill any running ClippyAI process (and its PowerShell bridge
; subprocess) so file replacements always succeed, even if the previous
; instance didn't quit cleanly during an auto-update.

!macro customInit
  ; Kill the main process. /t also kills children (PowerShell bridge, Electron
  ; helper processes). Silent errors — if nothing is running, taskkill exits
  ; with code 128 which is fine.
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  ; Also kill any orphaned PSBridge powershell processes left by a bad exit
  nsExec::ExecToLog 'powershell.exe -NoProfile -Command "Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '''' } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  ; Give Windows a moment to release the file handles.
  Sleep 1500
!macroend

!macro customUnInit
  ; Kill running instance + child processes
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  ; Kill orphaned PSBridge
  nsExec::ExecToLog 'powershell.exe -NoProfile -Command "Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '''' } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Sleep 1000
  ; Clean up logs directory (~/.clippyai/) — not in %APPDATA% so
  ; deleteAppDataOnUninstall won't reach it
  RMDir /r "$PROFILE\.clippyai"
!macroend
