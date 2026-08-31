# PRIMARY scheduler (RED-TEAM P9: local beats GitHub Actions cron for reliability).
# Registers a Windows Task Scheduler job: every 30 min, weekdays,
# 13:00-21:00 UTC window enforcement happens inside the tick itself (clock gate).
# Run as the user once:  powershell -ExecutionPolicy Bypass -File ops\schedule_task.ps1

$repo = Split-Path $PSScriptRoot -Parent
$python = (Get-Command python).Source
$action = New-ScheduledTaskAction -Execute $python `
  -Argument "-m thetadesk.main tick" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 30)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName "theta-desk-heartbeat" -Action $action `
  -Trigger $trigger -Settings $settings -Force
Write-Host "Registered 'theta-desk-heartbeat' (every 30 min). Env vars must be set"
Write-Host "machine-wide or via a wrapper that loads .env (see ops\tick_wrapper.ps1)."
