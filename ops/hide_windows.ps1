# Stop the visible console flashes (DEVLOG #40).
#
# Three of the five theta-desk tasks launch powershell.exe with NO window
# style at all, so every firing pops a fully visible console for a few
# seconds: theta-desk-heartbeat every 15 minutes during the session,
# theta-desk-watchdog roughly every 20-30, theta-desk-keepalive every ~3h.
# The other two (manager, pulse) already pass -WindowStyle Hidden as an
# ARGUMENT, but that alone can still let Windows allocate and flash a
# console for an instant before PowerShell applies the style — the task's
# own "Hidden" setting (Settings.Hidden) is the mechanism Task Scheduler
# actually honours to suppress the window outright, and none of the five
# tasks have it set.
#
# Changing a task's Action or Settings needs elevation for tasks registered
# S4U (same wall hit registering them in the first place, DEVLOG #37/harden
# _task.ps1) — this session cannot do it.
#
#   RUN AS ADMINISTRATOR:
#   powershell -ExecutionPolicy Bypass -File ops\hide_windows.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

$specs = @(
  @{ Name = "theta-desk-heartbeat"; Script = "tick_wrapper.ps1"; WorkDir = $repo },
  @{ Name = "theta-desk-watchdog";  Script = "watchdog.ps1";     WorkDir = $repo },
  @{ Name = "theta-desk-keepalive"; Script = "keepalive.ps1";    WorkDir = $repo },
  @{ Name = "theta-desk-manager";   Script = "manager.ps1";      WorkDir = $repo },
  @{ Name = "theta-desk-pulse";     Script = "pulse.ps1";        WorkDir = $repo }
)

foreach ($s in $specs) {
  $t = Get-ScheduledTask -TaskName $s.Name -ErrorAction SilentlyContinue
  if (-not $t) { "$($s.Name) : not registered, skipped"; continue }

  $args = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$repo\ops\$($s.Script)`""
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args -WorkingDirectory $s.WorkDir
  Set-ScheduledTask -TaskName $s.Name -Action $action | Out-Null

  # the setting Task Scheduler actually honours to suppress the window
  $t2 = Get-ScheduledTask -TaskName $s.Name
  $t2.Settings.Hidden = $true
  Set-ScheduledTask -TaskName $s.Name -Settings $t2.Settings | Out-Null

  $check = schtasks /query /tn $s.Name /v /fo LIST | Select-String "Task To Run|Hidden"
  "$($s.Name):"
  $check | ForEach-Object { "  $($_.Line.Trim())" }
}
"`ndone - no more console flashes from any theta-desk task"
