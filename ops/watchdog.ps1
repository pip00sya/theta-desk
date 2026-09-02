# Dead-man watchdog: a SEPARATE scheduled task (theta-desk-watchdog) that
# alerts when the heartbeat task stops producing ticks. Same env loading as
# tick_wrapper.ps1; never runs a tick itself.
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
Get-Content "$repo\.env" | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim())
  }
}
$env:PYTHONPATH = "$repo\src"
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

python "$repo\tools\watchdog.py" 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\watchdog.log"
exit $LASTEXITCODE
