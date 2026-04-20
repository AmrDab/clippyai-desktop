; electron-builder auto-includes this file via the nsis.include config in
; electron-builder.yml. customInit fires before any installation steps — we
; use it to kill any running ClippyAI process (and its PowerShell bridge
; subprocess) so file replacements always succeed, even if the previous
; instance didn't quit cleanly during an auto-update.

!macro customInit
  ; Kill the main process + entire child tree (PSBridge, Electron helpers).
  ; /t = kill children, /f = force. If nothing is running, taskkill exits
  ; with code 128 — that's fine.
  ; First kill — catches the main process
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  Sleep 2000
  ; Second kill — catches any child processes that respawned or were slow to die
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  ; Long sleep — Windows needs time to release NTFS file locks after process death.
  ; 1500ms was too short on many machines (the old v0.9.x update loop bug).
  Sleep 3000
!macroend

!macro customUnInit
  ; Kill running instance + child tree
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  Sleep 1000
  ; Clean up logs directory (~/.clippyai/) which is outside %APPDATA%
  ; so deleteAppDataOnUninstall doesn't reach it
  RMDir /r "$PROFILE\.clippyai"
!macroend
