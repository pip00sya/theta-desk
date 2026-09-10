# Keep the public judge dashboard awake — see ops/keepalive.ps1 for why.
# Every 3 hours, every day (a judge can open the link at any hour), through
# the judging horizon.
#
# DEVLOG #40: like watchdog, this task existed only as live Task Scheduler
# state with no committed source, and was missing -WindowStyle Hidden /
# -Hidden — every fire popped a visible console. This is that missing
# source, corrected.
#
# Run once:  powershell -ExecutionPolicy Bypass -File ops\schedule_keepalive.ps1
$repo = Split-Path $PSScriptRoot -Parent
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$repo\ops\keepalive.ps1`"" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Days 16)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "theta-desk-keepalive" -Action $action `
  -Trigger $trigger -Settings $settings -Force
Write-Host "Registered 'theta-desk-keepalive': every 3 hours, every day, for 16 days."
