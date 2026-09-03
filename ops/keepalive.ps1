# Keep the public judge dashboard awake: a verified headless visit every 3 hours
# (scheduled task theta-desk-keepalive). tools/keepalive.py opens the page in
# headless Edge with a DevTools port, waits until the title reads THETA DESK
# (the app rendered, not the "Zzzz" sleep page), holds the session, and logs
# to data/keepalive.log. Seen asleep 2026-09-03 17:15 UTC, a day before the
# deadline — a judge would have met a wake-up button instead of the desk.
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
python "$repo\tools\keepalive.py" 2>&1 | Out-File -Append -Encoding utf8 "$repo\data\keepalive.log"
exit $LASTEXITCODE
