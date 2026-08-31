.PHONY: test demo status tick dry verify replay reconcile dashboard selfcheck

test:
	python -m pytest tests -q

demo:
	python tools/demo_week.py

status:
	python -m thetadesk.main status

tick:
	python -m thetadesk.main tick

dry:
	python -m thetadesk.main tick --dry-run

selfcheck:
	python tools/selfcheck.py

verify:
	python -m thetadesk.main verify-journal
	python tools/replay.py
	python tools/reconcile.py

reconcile-write:
	python tools/reconcile.py --write

dashboard:
	streamlit run dashboard/app.py
