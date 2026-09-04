# Start the one-minute management loop with no console window (DEVLOG #36).
#
# pythonw.exe is the windowless interpreter, so nothing appears on screen and
# nothing steals focus. Each pass runs `thetadesk.main manage` under the
# tick's own lock: exits only, never an entry. See tools/manager.py.
#
#   ops\manager.ps1              start it (does nothing if already running)
#   ops\manager.ps1 -Stop        stop it
#   ops\manager.ps1 -Status      report
param([switch]$Stop, [switch]$Status)

$repo = Split-Path $PSScriptRoot -Parent
$marker = "$repo\data\manager.pid"

function Get-Manager {
  if (-not (Test-Path $marker)) { return $null }
  $procId = Get-Content $marker -ErrorAction SilentlyContinue
  if (-not $procId) { return $null }
  return Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
}

if ($Status) {
  $p = Get-Manager
  if ($p) {
    $age = (Get-Date) - $p.StartTime
    "manager running, pid $($p.Id), up $([int]$age.TotalMinutes)m"
    if (Test-Path "$repo\data\manager.log") {
      Get-Content "$repo\data\manager.log" -Tail 3 -Encoding utf8
    }
  } else { "manager is not running" }
  exit 0
}

if ($Stop) {
  $p = Get-Manager
  if ($p) { Stop-Process -Id $p.Id -Force; Remove-Item $marker -ErrorAction SilentlyContinue; "stopped" }
  else { "not running" }
  exit 0
}

if (Get-Manager) { "already running"; exit 0 }

$py = (Get-Command python).Source
$pyw = Join-Path (Split-Path $py -Parent) "pythonw.exe"
if (-not (Test-Path $pyw)) { $pyw = $py }

$env:PYTHONPATH = "$repo\src"
$env:PYTHONUTF8 = "1"
$proc = Start-Process -FilePath $pyw `
  -ArgumentList @("`"$repo\tools\manager.py`"", "--interval", "60") `
  -WorkingDirectory $repo -WindowStyle Hidden -PassThru
$proc.Id | Out-File -Encoding ascii $marker
"manager started, pid $($proc.Id) - a management pass every 60s while the exchange is open"
