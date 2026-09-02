# Loads .env then runs one tick. Target this from Task Scheduler.
# Skips weekends and off-hours locally; the tick itself checks the exchange
# clock and returns early when the market is closed (holidays, the two
# scheduler fires after the 20:00 UTC close) - DEVLOG #28.
$utc = (Get-Date).ToUniversalTime()
if ($utc.DayOfWeek -eq 'Saturday' -or $utc.DayOfWeek -eq 'Sunday') { exit 0 }
if ($utc.Hour -lt 13 -or $utc.Hour -gt 20) { exit 0 }

$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
Get-Content "$repo\.env" | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim())
  }
}
$env:PYTHONPATH = "$repo\src"
# Python under the scheduler defaulted to cp1252 -> mojibake in tick.log and
# a possible UnicodeEncodeError on LLM text (DEVLOG #28)
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

python -m thetadesk.main tick 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\tick.log"
$rc = $LASTEXITCODE

# Evidence archive + agent's daily note once per SESSION after the close.
# The stamp is the New York session date (UTC-4): evidence.py names its
# directory the same way, so the guard actually matches now (it never did:
# evidence used the host's local date, the wrapper used UTC, and both
# post-close ticks re-ran the block, the second run wiping the day's note).
if ($utc.Hour -eq 20 -and $utc.Minute -ge 5) {
  $stamp = $utc.AddHours(-4).ToString('yyyy-MM-dd')
  if (-not (Test-Path "$repo\data\evidence\$stamp")) {
    python -m thetadesk.audit.evidence 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\tick.log"
  }
  if (-not (Test-Path "$repo\data\notes\$stamp.md")) {
    python "$repo\tools\daily_note.py" 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\tick.log"
  }
}
exit $rc
