# Tests

Plain Node, no dependencies, no build step.

```sh
node test/run.js              # fast suites (~1 min)
KESTO_SLOW=1 node test/run.js # everything, including real levels (~10 min)
```

The page itself stays a static site — nothing here ships to the browser.

## How the app is tested without a browser

`harness.js` is a minimal DOM shim: enough `classList` / `dataset` /
`addEventListener` / `getBoundingClientRect` for `app.js` to run under Node.
It builds its element table by **parsing `index.html`**, so the shim cannot
drift away from the real markup — a renamed id fails the tests rather than
silently passing.

`createApp()` is one page load. Options:

- `worker: true` — installs a stand-in `Worker`, exercising the branch real
  browsers take. Without it `app.js` falls back to solving on the main thread.
  Both paths are worth testing; they format messages differently and only the
  worker path can be cancelled.
- `deferTimers: true` — queues `setTimeout` and worker replies instead of
  running them inline, so a test can inspect the page mid-search (the
  "Solving..." message) and then call `flushTimers()`.
- `mode`, `strength`, `savedGrids` — seed the URL and localStorage.

## Suites

| File | What it protects |
| --- | --- |
| `test-modes.js` | Switching Edit/Play/Solve keeps a found solution and its chips; editing the board discards it |
| `test-app.js` | Edge cases plus 250 random sessions × 400 operations, checking nine invariants after *every* operation |
| `test-async.js` | Daily puzzle loading: success, failure, rapid clicks, and that a failed fetch leaves the board alone |
| `test-play-rules.js` | Play mode's move rule matches `solver.js` exactly, in both directions |
| `test-beam.js` | The Best effort switch changes behaviour, and a beam result is never labelled optimal |
| `test-optimality.js` | Across budgets that expire mid-level, every "proven optimal" claim equals Kesto's par |
| `test-levels.js` | Every real level in `fixtures/` solves to the published par |

The last two are the ones that matter most. `solver.js` may return an
*approximate* answer, and the difference between "36 steps" and "36 steps,
proven shortest" is the whole product — a solver that quietly overstates its
confidence is worse than one that admits defeat.

## Invariants

`test-app.js` asserts these after every fuzzed operation. Each exists because
breaking it was reachable through the UI at some point:

- exactly one mode tab is active and matches `body[data-mode]`
- only the current mode's panels are visible
- both grids round-trip through localStorage with legal cell values
- Edit mode has no leftover animated block overlays
- the playback panel's chip count equals its step total
- at most one chip is marked current
- Play mode conserves blocks — moves relocate them, never create or destroy

## Fixtures

`fixtures/` holds real puzzles fetched from kestopuzzle.com, each with the par
the game publishes. Par is the ground truth the optimality tests check against.

```sh
node test/fetch-fixtures.js   # add any missing days, skips what is already there
```

Committed rather than fetched on demand so the suite runs offline and so a
change in the upstream API cannot quietly turn the tests green.

## Utility

```sh
node test/verify.js test/fixtures/puzzle-20260815.json DDRDDDURRUR...
```

Replays a move string through an implementation written independently of
`solver.js`, and reports whether every block lands on a target. Useful when a
solution looks wrong, and used by the suites so a path is never trusted on the
solver's own say-so.
