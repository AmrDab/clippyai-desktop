!macro customInit
  ; Kill running ClippyAI before installing
  nsExec::ExecToLog 'taskkill /f /im ClippyAI.exe'
  Sleep 1000
!macroend
