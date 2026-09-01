# Loads .env then runs one tick. Target this from Task Scheduler.
# Skips weekends and off-hours locally (the tick's clock gate is the real
# authority; this just avoids useless wakeups).
$utc = (Get-Date).ToUniversalTime()
if ($utc.DayOfWeek -eq 'Saturday' -or $utc.DayOfWeek -eq 'Sunday') { exit 0 }
if ($utc.Hour -lt 13 -or $utc.Hour -gt 21) { exit 0 }

$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
Get-Content "$repo\.env" | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim())
  }
}
$env:PYTHONPATH = "$repo\src"
python -m thetadesk.main tick 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\tick.log"

# Evidence archive + agent's daily note once per day after the close
if ($utc.Hour -eq 20 -and $utc.Minute -ge 5) {
  $stamp = $utc.ToString('yyyy-MM-dd')
  if (-not (Test-Path "$repo\data\evidence\$stamp")) {
    python -m thetadesk.audit.evidence 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\tick.log"
    python "$repo\tools\daily_note.py" 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\tick.log"
  }
}
