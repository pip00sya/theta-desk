.PHONY: test demo status tick dry verify replay reconcile dashboard selfcheck alert-test

test:
	python -m pytest tests -q

demo:
	python tools/demo_week.py

status:
	python -m thetadesk.main status

tick:
	python -m thetadesk.main tick

# A rehearsal never touches the live store (DEVLOG #28): point it at a scratch copy.
dry:
	@echo "use: THETADESK_DATA_DIR=<scratch dir> python -m thetadesk.main tick --dry-run   (or: make demo)"

selfcheck:
	python tools/selfcheck.py

alert-test:
	python -m thetadesk.main alert-test

verify:
	python -m thetadesk.main verify-journal
	python tools/replay.py
	python tools/reconcile.py

reconcile-write:
	python tools/reconcile.py --write

dashboard:
	streamlit run dashboard/app.py

# consistent copy even while a tick is writing (sqlite online backup, not a file copy)
snapshot-dashboard:
	python -c "import sqlite3; s=sqlite3.connect('data/thetadesk.sqlite'); d=sqlite3.connect('dashboard/state.sqlite'); s.backup(d); d.close(); s.close(); print('dashboard/state.sqlite refreshed')"
