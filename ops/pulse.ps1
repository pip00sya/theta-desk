# Start the read-only broker pulse with no console window.
#
# pythonw.exe is the windowless build of the interpreter, so nothing appears on
# screen and nothing steals focus. The loop only ever GETs the exchange clock,
# the account and the last print; it has no order path.
#
#   ops\pulse.ps1              start it (does nothing if already running)
#   ops\pulse.ps1 -Stop        stop it
#   ops\pulse.ps1 -Status      report
param([switch]$Stop, [switch]$Status)

$repo = Split-Path $PSScriptRoot -Parent
$marker = "$repo\data\pulse.pid"

function Get-Pulse {
  if (-not (Test-Path $marker)) { return $null }
  $procId = Get-Content $marker -ErrorAction SilentlyContinue
  if (-not $procId) { return $null }
  return Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
}

if ($Status) {
  $p = Get-Pulse
  if ($p) {
    $age = (Get-Date) - $p.StartTime
    "pulse running, pid $($p.Id), up $([int]$age.TotalMinutes)m"
    if (Test-Path "$repo\dashboard\web\live.json") {
      $j = Get-Content "$repo\dashboard\web\live.json" -Raw | ConvertFrom-Json
      "  seq $($j.seq) - equity $($j.account.equity) - market open: $($j.market.is_open)"
    }
  } else { "pulse is not running" }
  exit 0
}

if ($Stop) {
  $p = Get-Pulse
  if ($p) { Stop-Process -Id $p.Id -Force; Remove-Item $marker -ErrorAction SilentlyContinue; "stopped" }
  else { "not running" }
  exit 0
}

if (Get-Pulse) { "already running"; exit 0 }

# pythonw sits beside python in the same install
$py = (Get-Command python).Source
$pyw = Join-Path (Split-Path $py -Parent) "pythonw.exe"
if (-not (Test-Path $pyw)) { $pyw = $py }

$env:PYTHONPATH = "$repo\src"
$env:PYTHONUTF8 = "1"
$proc = Start-Process -FilePath $pyw `
  -ArgumentList @("`"$repo\tools\pulse.py`"", "--interval", "3") `
  -WorkingDirectory $repo -WindowStyle Hidden -PassThru
$proc.Id | Out-File -Encoding ascii $marker
"pulse started, pid $($proc.Id) - writing dashboard\web\live.json every 3s"
