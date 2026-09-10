# The dead-man watchdog (tools/watchdog.py) — a SEPARATE task from the
# heartbeat, because the process that would report a stalled scheduler is
# the one that is not running. Fires 20 minutes after the heartbeat's own
# first fire (so a slow first tick isn't mistaken for a stall), every 30
# minutes through the session, weekdays only, through the judging horizon.
#
# DEVLOG #40: this task existed only as live Task Scheduler state with no
# committed source — registered by hand at some point, undocumented, and
# missing -WindowStyle Hidden / -Hidden, so every fire popped a visible
# console. This script is that missing source, corrected.
#
# Run once:  powershell -ExecutionPolicy Bypass -File ops\schedule_watchdog.ps1
$repo = Split-Path $PSScriptRoot -Parent
# DEVLOG #40b: -WindowStyle Hidden alone still flashed a console on this
# machine (the OS can allocate one before PowerShell applies the style).
# wscript.exe running run_hidden.vbs never allocates a console at all.
$inner = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$repo\ops\watchdog.ps1`""
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
  -Argument "//B //Nologo `"$repo\ops\run_hidden.vbs`" `"$inner`"" `
  -WorkingDirectory $repo
$weekly = New-ScheduledTaskTrigger -Weekly `
  -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "18:50"
$rep = New-ScheduledTaskTrigger -Once -At "18:50" `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration (New-TimeSpan -Hours 7)
$weekly.Repetition = $rep.Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "theta-desk-watchdog" -Action $action `
  -Trigger $weekly -Settings $settings -Force
Write-Host "Registered 'theta-desk-watchdog': weekdays 18:50+05, every 30 min x 7h."
