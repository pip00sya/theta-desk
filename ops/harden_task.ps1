# Make every theta-desk task survive a reboot nobody logs back in from,
# AND never flash a console. One elevated pass, all five tasks.
#
# History:
#   DEVLOG #37 (2026-09-04): a hardware error rebooted the machine to the
#   login screen mid-session; "Interactive only" tasks fired nothing until
#   someone logged in. Fix: S4U (runs under the account, no stored password,
#   no interactive session needed). Changing a task's principal needs
#   elevation, which a normal session does not have.
#
#   DEVLOG #40 (2026-09-10): three periodic tasks launched powershell.exe
#   with no window style at all, so every firing popped a visible console.
#   -WindowStyle Hidden was added first and genuinely DID commit despite
#   Set-ScheduledTask reporting "Access is denied" (a Task Scheduler COM
#   quirk) — but the console still flashed sometimes: -WindowStyle Hidden is
#   a request PowerShell applies AFTER starting, and Windows can allocate a
#   console in the instant before that.
#
#   DEVLOG #40b (2026-09-10, same day): the real fix is not to give
#   powershell.exe a console to begin with. wscript.exe running
#   ops/run_hidden.vbs (WScript.Shell.Run ..., 0, False) never allocates one
#   — this time changing the Action's executable genuinely needed elevation
#   (unlike the arg-only change above), and a non-elevated attempt at
#   watchdog cost it its S4U hardening when the safe path was
#   unregister-then-reregister without admin rights. This script restores
#   S4U on all five AND switches all five to the wscript launcher, so
#   running it once fixes everything in one place.
#
#   RUN AS ADMINISTRATOR:
#   powershell -ExecutionPolicy Bypass -File ops\harden_task.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$me = "$env:USERDOMAIN\$env:USERNAME"

function Hidden-Action($scriptName) {
    $inner = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$repo\ops\$scriptName`""
    New-ScheduledTaskAction -Execute "wscript.exe" `
        -Argument "//B //Nologo `"$repo\ops\run_hidden.vbs`" `"$inner`"" `
        -WorkingDirectory $repo
}

# ---- the three periodic tasks: registered independently over the week,
# each may or may not currently exist, be S4U, or use the vbs launcher ----
$periodic = @{
    "theta-desk-heartbeat" = "tick_wrapper.ps1"
    "theta-desk-watchdog"  = "watchdog.ps1"
    "theta-desk-keepalive" = "keepalive.ps1"
}
foreach ($name in $periodic.Keys) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { "$name : not registered, skipped"; continue }
    Set-ScheduledTask -TaskName $name -Action (Hidden-Action $periodic[$name]) | Out-Null
    $p = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
    Set-ScheduledTask -TaskName $name -Principal $p | Out-Null
    $s = (Get-ScheduledTask -TaskName $name).Settings
    $s.Hidden = $true
    Set-ScheduledTask -TaskName $name -Settings $s | Out-Null
    $mode = (schtasks /query /tn $name /v /fo LIST | Select-String 'Logon Mode').Line.Trim()
    "$name : wscript launcher, Hidden settings, $mode"
}

# ---- pulse/manager: long-running background loops, started at boot ----
foreach ($loop in @("pulse", "manager")) {
    $name = "theta-desk-$loop"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -Hidden -ExecutionTimeLimit (New-TimeSpan -Days 0)
    $p = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $name -Action (Hidden-Action "$loop.ps1") -Trigger $trigger `
        -Settings $settings -Principal $p -Force | Out-Null
    "$name : registered at startup (S4U, wscript launcher)"
}
"`ndone - all five tasks: no console flash, survive a reboot with nobody logged in"
