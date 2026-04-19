; electron-builder auto-includes this file via the nsis.include config in
; electron-builder.yml. customInit fires before any installation steps — we
; use it to kill any running ClippyAI process (and its PowerShell bridge
; subprocess) so file replacements always succeed, even if the previous
; instance didn't quit cleanly during an auto-update.

!macro customInit
  ; Kill the main process + entire child tree (PSBridge, Electron helpers).
  ; /t = kill children, /f = force. If nothing is running, taskkill exits
  ; with code 128 — that's fine.
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  ; Give Windows a moment to release the file handles.
  Sleep 1500
!macroend

!macro customUnInit
  ; Kill running instance + child tree
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  Sleep 1000
  ; Clean up logs directory (~/.clippyai/) which is outside %APPDATA%
  ; so deleteAppDataOnUninstall doesn't reach it
  RMDir /r "$PROFILE\.clippyai"
!macroend
