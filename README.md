# KestoSolver

A solver and sandbox for [Kesto](https://kestopuzzle.com), the daily block
puzzle. Draw a board, play it yourself, or have it solved.

**Live:** https://wky95.github.io/KestoSolver/

Static site, no build step and no dependencies. Open `index.html`, or push to
`main` and GitHub Pages serves it.

## The rules

Every block moves at once. A move shifts each maximal run of blocks one square
in the chosen direction, but only if the square past its leading block is on the
board and not a wall. The puzzle is solved when every block sits on a target.

## Modes

`?mode=edit|play|solve` — linkable and survives a reload.

- **Edit** — paint walls, targets and blocks.
- **Play** — solve it yourself with the arrow keys, WASD, or the on-screen pad.
- **Solve** — search for the answer and step through it.

The Daily Puzzle panel fetches a given day straight from kestopuzzle.com in the
visitor's own browser. Nothing is downloaded in bulk or stored.

## Search strength

| | Budget | Notes |
| --- | --- | --- |
| Fast | ~3s | Handles nearly every daily puzzle |
| Balanced | ~20s | Default |
| Thorough | No time limit, ~1.6GB | Runs until the state cap; desktop only |

**Best effort** is a separate switch. Left off, the solver either proves an
answer optimal or reports that it could not. Turned on, a beam search takes over
when the exact search gives up — it finds *a* solution but cannot prove it is
the shortest, and results say so.

The distinction matters more than the speed: a solver that quietly overstates
its confidence is worse than one that admits defeat.

## Tests

```sh
node test/run.js               # fast suites, ~1 minute
KESTO_SLOW=1 node test/run.js  # everything, including real levels
```

See [test/README.md](test/README.md). They run in CI on every push, and the
slow suites nightly.

## What has been measured

Recorded so the same dead ends are not explored twice. Numbers are from the
16-block board of 2026-08-15 (par 33) unless stated.

**Worked**

- Replacing BigInt boards with a pair of uint32s in the bidirectional search:
  **2.8x**. It also revealed the next bottleneck — hash probing, not arithmetic.
- Collapsing mirrored positions: exactly **4x fewer states** on a board with
  both mirrors, at ~10% cost per state. Applies to 4 of 35 real levels, but that
  includes two of the hard ones, and it moved 2026-06-13 from "Thorough only"
  to "solved at Balanced in 13s".
- Scoring beam candidates by a greedy block-to-target matching rather than
  distance-to-nearest-target: **45 steps down to 34**. Distance-to-nearest lets
  every block claim the same target, so a pile of blocks on one square reads as
  nearly solved.
- Keeping half of each beam level at random instead of purely by score: mean
  result **39 steps to 36.8**, best 39 to 34. A quarter at random changed
  nothing — the perturbation has to be substantial to escape a local trap.

**Marginal, kept because it costs nothing**

- Capping how far the entry arrays grow, so the last doubling cannot overshoot
  into slots that can never be filled: 47-64MB on a board that exhausts its
  budget. Reserving the full budget up front was rejected — it would allocate
  hundreds of megabytes for boards that solve in a thousand states.
- Moving the weighted A* fallback onto the same packed arrays as the main
  search. This did **not** make it faster; the gap to plain BFS is the priority
  queue, not the board representation. What it removed was a hard 2M-state cap
  that existed only because the old code kept BigInt keys in a `Map`, so the
  fallback now explores ~5x more of its budget.

**Did not work, with the numbers**

- Raising the state cap. The frontier multiplies by ~2.9 per search level, so
  one more level of depth costs **~4.8GB**. Proving the 2026-08-15 answer needs
  roughly 1.15 billion states, about 11GB — routine offline, impossible in a
  browser tab. This is why the game ships a par it computed once rather than
  solving on demand.
- Interleaving the hash table's three arrays into one: within noise, 33% more
  memory per bucket.
- Dropping the hash load factor to 50%: 3.5% faster for double the table.
- A learned evaluation for beam selection. Matching already lands within a step
  or two of par, and a small network costs ~50x more per state than the
  arithmetic it would replace. Machine learning pays off where evaluations are
  few and expensive, which is the opposite shape.
