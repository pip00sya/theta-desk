"""Print the decision trail from the journal in one screen."""
import json
import pathlib
import sys

p = pathlib.Path(__file__).resolve().parents[1] / "data" / "journal" / "desk.jsonl"
if not p.exists():
    sys.exit("no journal")
for line in p.read_text(encoding="utf-8").splitlines():
    e = json.loads(line)
    k, d = e["kind"], e["data"]
    if k == "signals":
        print(f"SIGNALS  spot={d['spot']} rv20={d['rv20']} iv={d['atm_iv']} vrp={d['vrp_score']}")
    elif k == "desk":
        print(f"DESK     analyst={d['regime_analyst']} second={d['regime_second']} "
              f"veto={d['veto']} size_mult={d['size_mult']} fallbacks={len(d['fallbacks'])}")
    elif k == "gates":
        print(f"GATES    {d['kind']} x{d['qty']} passed={d['passed']} worst={d['worst_case']}")
        for r in d["results"]:
            if not r["passed"]:
                print(f"         FAIL {r['gate']}: {r['reason']}")
    elif k in ("entry_refused", "size_zero", "no_candidate", "desk_veto",
               "order_open", "order_close", "order_hedge", "manage",
               "entry_skipped_duplicate", "integrity", "baseline_naive_entry"):
        print(f"{k.upper():<24} {json.dumps(d, ensure_ascii=False)[:180]}")
