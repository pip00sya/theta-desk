# PRIMARY scheduler — mirrors the exchange session (RED-TEAM P9).
# Weekdays, first fire 18:30 Asia/Almaty (= 09:30 ET market open),
# repeat every 15 minutes for 7 hours. Outside that window the task
# does not start at all; tick_wrapper.ps1 adds a second UTC-hours guard
# and the agent's own clock gate (g10) is the final authority.
# Run once:  powershell -ExecutionPolicy Bypass -File ops\schedule_task.ps1

$repo = Split-Path $PSScriptRoot -Parent
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\ops\tick_wrapper.ps1`"" `
  -WorkingDirectory $repo
$weekly = New-ScheduledTaskTrigger -Weekly `
  -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "18:30"
$rep = New-ScheduledTaskTrigger -Once -At "18:30" `
  -RepetitionInterval (New-TimeSpan -Minutes 15) `
  -RepetitionDuration (New-TimeSpan -Hours 7)
$weekly.Repetition = $rep.Repetition
# Battery flags matter on laptops: the defaults silently skip fires on
# battery power (cost us the 18:30-19:00 window on day one of the schedule).
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "theta-desk-heartbeat" -Action $action `
  -Trigger $weekly -Settings $settings -Force
Write-Host "Registered 'theta-desk-heartbeat': weekdays 18:30+05 (09:30 ET), every 15 min x 7h."
