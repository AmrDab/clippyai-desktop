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
  ; Give Windows a moment to release the file handles.
  Sleep 1500
!macroend

!macro customUnInit
  ; Same on uninstall — make sure no running instance blocks removal.
  nsExec::ExecToLog 'taskkill /f /t /im ClippyAI.exe'
  Sleep 1000
!macroend
