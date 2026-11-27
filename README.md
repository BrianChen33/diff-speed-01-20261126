# diff-speed-01-20261126

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/BrianChen33/diff-speed-01-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/BrianChen33/diff-speed-01-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A fast, exact drop-in for makefun-diff 1.0.0: `solve.js` returns, for every case's `{ old, new }` input, exactly the patch makefun-diff returns — same Myers edit script (deletion-first tie-break, no edge-diagonal pruning), same patch format — but computed with interned line ids and a typed-array Myers trace instead of the reference's per-path linked lists.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` (the house driver, unchanged) reads `cases.json`, answers each case with `run` from `solve.js`, and writes `answers.json`. Deterministic: two runs produce identical bytes. Practice set: 4/4 cases byte-identical to the reference, ~0.79 s CPU locally (vs ~2.72 s for the house baseline on the same machine).

## Files

- `solve.js` — dependency-free ES module exporting `run(input)`.
- `main.ts` — house driver (verbatim).
- `LICENSE` — MIT.
