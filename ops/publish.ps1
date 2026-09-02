# Publish the session's evidence so the cloud dashboard and anyone who clones
# the repository are never more than one session stale (DEVLOG #29d).
#
# Runs from tick_wrapper.ps1 after the close, once per session. It refuses to
# publish a broken artifact: the hash chain must verify and the claims must
# reconcile first. A failure here never affects trading — the tick has already
# finished and its exit code is captured before this runs.
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONPATH = "$repo\src"

python -m thetadesk.main verify-journal
if ($LASTEXITCODE -ne 0) { Write-Host "publish: hash chain does not verify - refusing"; exit 1 }

# regenerate the claims block and the verification transcript from the journal
python tools/reconcile.py --write | Out-Null
python tools/publish_prep.py
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$head = git rev-parse --short HEAD
"# generated $stamp at commit $head by: ops/publish.ps1" | Out-File -Encoding utf8 submission/verify_output.txt
python -m thetadesk.main verify-journal 2>&1 | Out-File -Append -Encoding utf8 submission/verify_output.txt
python tools/replay.py 2>&1 | Select-Object -Last 2 | Out-File -Append -Encoding utf8 submission/verify_output.txt
python tools/reconcile.py 2>&1 | Select-Object -Last 2 | Out-File -Append -Encoding utf8 submission/verify_output.txt

# a consistent copy of the store for the cloud dashboard (online backup, not a
# file copy: a plain copy taken mid-transaction can be torn)
python -c "import sqlite3; s=sqlite3.connect('data/thetadesk.sqlite'); d=sqlite3.connect('dashboard/state.sqlite'); s.backup(d); d.close(); s.close()"

git add data/journal data/snapshots data/notes dashboard/state.sqlite WRITEUP.md submission/verify_output.txt DEVLOG.md
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host "publish: nothing new"; exit 0 }
$session = (Get-Date).ToUniversalTime().AddHours(-4).ToString('yyyy-MM-dd')
git commit -q -m "auto: session $session (journal, snapshots, dashboard snapshot, claims)"
git push -q
if ($LASTEXITCODE -ne 0) { Write-Host "publish: push failed (credentials?)"; exit 1 }
Write-Host "publish: pushed session $session"
