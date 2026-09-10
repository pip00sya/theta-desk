# Stop the visible console flashes (DEVLOG #40) — a fallback / idempotent
# re-check. The live fix already landed on 2026-09-10 from a NON-elevated
# session: every Set-ScheduledTask call below reported "Access is denied",
# but schtasks /query and a fresh Get-ScheduledTask afterwards showed the
# change had actually committed anyway on all five tasks — a known Task
# Scheduler COM quirk where a secondary internal call throws even though the
# write itself succeeds. So this script is not required for that fix; it is
# kept as a belt-and-braces re-assertion (idempotent — safe to run again)
# and because it's the clearest single place documenting what "hidden"
# actually means for a scheduled task: the action's own -WindowStyle Hidden
# PLUS the task's Settings.Hidden, which is the property Task Scheduler
# actually honours to suppress the window outright rather than trusting the
# launched process to apply a style fast enough. If a future change to
# these tasks ever needs a genuinely elevated hand (e.g. the S4U principal
# itself, per DEVLOG #37/harden_task.ps1), run this as administrator; it
# does nothing destructive either way.
#
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
