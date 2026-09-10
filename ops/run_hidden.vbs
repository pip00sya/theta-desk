' Truly invisible launcher (DEVLOG #40b).
'
' -WindowStyle Hidden on powershell.exe is a REQUEST powershell.exe applies
' after it starts — the OS can still allocate and flash a console window in
' the instant before that request is processed, and on this machine it
' still did, periodically, after the tasks were set to Hidden + WindowStyle
' Hidden both. WScript.Shell.Run with windowStyle 0 is a different, harder
' guarantee: the console is never created in the first place.
'
' Usage from a scheduled task's Action:
'   wscript.exe //B //Nologo "...\ops\run_hidden.vbs" "powershell -NoProfile -ExecutionPolicy Bypass -File ...\ops\tick_wrapper.ps1"
Set shell = CreateObject("WScript.Shell")
shell.Run WScript.Arguments(0), 0, False
