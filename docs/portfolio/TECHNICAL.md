# ThetaDesk: inspect a decision before inspecting a curve

ThetaDesk is a paper-trading research system built for the Alpaca AI Trading
Agents Hackathon. [The event and submission](HACKATHON.md) establish participation;
the journal, replay and developer record establish what the implementation did.
No competition award or live-money result is claimed.

## The model discussion has a limited contract

The signal layer derives realized volatility, option-chain information and a
candidate structure from a stored market snapshot. Model roles can challenge
the proposal, veto the session or reduce size. They do not compute the final
order or expand the deterministic risk budget.

The retained design uses separate analyst, second-opinion, news and risk roles.
Cross-provider disagreement is preserved as part of the decision rather than
being averaged into an unrestricted model instruction. A provider failure and a
fallback are events to record; they are not silently described as model consensus.

## Deterministic checks govern the broker boundary

Entry gates check conditions including liquidity, timing, budget, quote quality
and portfolio payoff. The portfolio stress calculation considers the existing
book together with the proposed structure. Management and exits have their own
path; refusing a new entry does not require rewriting an existing journal.

The implementation also enforces a paper host, idempotent order identifiers,
tick locking and fill reconciliation. A proposed or pending order is distinct
from a broker-reported fill. The source's `engine/`, `manage/` and execution
modules make those boundaries inspectable.

## Three checks answer different questions

| Evidence | What it can establish | What it cannot establish |
| --- | --- | --- |
| Hash-chain verification | Detect an in-place change to retained journal entries | Prove the original input was economically correct |
| Signal replay | Regenerate the signal from retained inputs | Validate future market performance |
| Broker/claims reconciliation | Match stored claims and reported fills to records | Turn optimistic paper fills into live execution results |

The competition record reports 91/91 signal-snapshot matches. The October
migration verified a 5,988-entry journal. These are dated records; see
[ENGINEERING-RECORD.md](ENGINEERING-RECORD.md) for the later test run and
option-expiry fixtures. Neither count is presented as a fresh verification in
this documentation update.

## Read the recorded mistakes as engineering evidence

The development log retains stale volatility-window findings, after-hours mark
problems, mleg sign conventions and resulting corrections. Quarantined marks
stay in the record instead of being edited out of the chain. Counterfactual
books use different assumptions and provide bounds on behaviour, not an exact
attribution of profit to individual model roles.

The original deck and video also have identifiable versions. The cover of the
retained PDF counts 18 gates; the later source explanation counts 19 deterministic
rules under its documented grouping. The old slide is preserved as an artifact,
not silently edited to look newer. Recorded returns, account values and trade
counts remain archived paper-run figures.

## Reproduce a bounded offline path

The public [source repository](https://github.com/pip00sya/theta-desk) includes
an offline demo week, saved snapshots, replay, reconciliation, a Streamlit view,
the submission write-up, developer log and Alpaca API feedback.

```sh
pip install -e ".[dashboard,dev]"
python tools/demo_week.py
python tools/replay.py
python tools/reconcile.py
streamlit run dashboard/app.py
```

Use a separate local checkout for generated demo artifacts. The offline demo is
simulated, replay consumes archived inputs, and the hosted dashboard shows a
snapshot. Connecting provider and paper-broker credentials is a separate path
described in the source's environment example. No live-money trading is needed
to inspect this project.
