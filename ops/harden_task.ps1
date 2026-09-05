# Make the tick survive a reboot nobody logs back in from (DEVLOG #37).
#
# On 2026-09-04 at 15:03Z the machine took an uncorrectable hardware error
# one minute after a management pass, rebooted to the login screen, and sat
# there. The heartbeat task is registered "Interactive only", so with no
# logged-in session it fired nothing for the rest of Friday's trading day.
#
# S4U runs the task under the user's account without a stored password and
# without an interactive session. Changing a task's principal needs elevation.
#
#   RUN AS ADMINISTRATOR:
#   powershell -ExecutionPolicy Bypass -File ops\harden_task.ps1
$ErrorActionPreference = "Stop"
$me = "$env:USERDOMAIN\$env:USERNAME"
foreach ($name in @("theta-desk-heartbeat", "theta-desk-watchdog", "theta-desk-keepalive")) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { "$name : not registered, skipped"; continue }
  $p = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
  Set-ScheduledTask -TaskName $name -Principal $p | Out-Null
  $mode = (schtasks /query /tn $name /v /fo LIST | Select-String 'Logon Mode').Line.Trim()
  "$name : $mode"
}
# the two loops start from the Startup folder today, which also needs a login;
# register them as boot-time tasks so they come back with the machine
$repo = Split-Path $PSScriptRoot -Parent
foreach ($loop in @("pulse", "manager")) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$repo\ops\$loop.ps1`"" `
    -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)
  $p = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName "theta-desk-$loop" -Action $action -Trigger $trigger `
    -Settings $settings -Principal $p -Force | Out-Null
  "theta-desk-$loop : registered at startup (S4U)"
}
"done - the desk now comes back with the machine, logged in or not"
