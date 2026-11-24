# @vasanthsaravanan/pi-subagent-cascade

Cheap-to-frontier model escalation for delegated Pi work, gated by your own test suite.

A delegated task runs on a cheap model first. If the gate fails, the same model gets one repair attempt with the error text. If it still fails, the frontier model takes over. Every attempt runs in its own git worktree and every attempt is recorded with its real cost.

## Why

Model routers guess a tier before the work happens. This one observes the result:

- the gate is run by the host after the child exits, never trusted from the child,
- a failed attempt is discarded, not rolled back over your working tree,
- a gate that is already red at HEAD is never blamed on the model,
- cost per attempt comes from the child's own usage events.

## Install

```bash
pi install npm:@vasanthsaravanan/pi-subagent-cascade
```

Requires Pi 1.6+ and a git repository for the work to run in.

## Quickstart

```bash
cd your-repo                       # must be a clean git tree
pi
```

```text
Use routed_subagent with gate "node --test" and expect "red" to make the failing tests pass.
```

Or call it directly with `-p`. The tool needs three things: a task, a gate, and whether the gate is expected to be green or red today.

| Parameter | Required | Meaning |
|---|---|---|
| `task` | yes | What the child should do |
| `gate` | yes | Deterministic command proving the task is done |
| `expect` | no | `"green"` (default) or `"red"` |
| `tier0` | no | Cheap model, default `opencode-go/deepseek-v4.1-flash` |
| `tier1` | no | Frontier model, default `opencode-go/deepseek-v4-pro` |
| `timeoutMs` | no | Per-attempt deadline, default 8 minutes |
| `profile` | no | `"dev"` (credit-funded), `"prod"` (default), `"max"` |
| `maxCostUsd` | no | Ceiling for this repo over the trailing 24 h; default `$1.00` |
| `apply` | no | Patch the clean source tree on success (default `false`) |

### Tier resolution

`tier0`/`tier1` resolve in this order, first non-empty wins:

1. the tool parameter,
2. `PI_CASCADE_TIER0` / `PI_CASCADE_TIER1` from the environment,
3. `~/.pi/agent/cascade/config.json` (written by the probe below),
4. the compiled default.

A missing config is normal, not an error. A model that is absent from the catalog, or has a context window under 64k, refuses the call **before** anything is spent.

```bash
node scripts/probe-models.mjs            # prod: paid, ≥16k output, priced
node scripts/probe-models.mjs --profile dev
```

The probe pings each candidate through `pi` (60 s deadline), records `contextWindow`, `maxTokens` and `priced` per candidate, and writes `config.json` with mode `0600`. It refuses to promote an unpriced or `<16384`-output model to primary — `adaption/*` is a credit-funded **dev** profile, never a silent production swap — and it exits non-zero without touching a working config.

### Spend ceiling and lock

The ceiling sums ledger cost **for the same repo over the trailing 24 h of UTC** before dispatch; over budget it refuses with the observed total and writes no row. Never compute that window from a local date — the ledger is UTC and a local-date filter silently reads `$0.00`.

```bash
PI_CASCADE_MAX_COST_USD=0.50            # per-repo, trailing 24 h
```

A single-flight lock at `~/.pi/agent/cascade/lock` holding `{pid, taskId, startedAt}` stops two cascades running at once. A live pid refuses with the holder's info; a dead pid is reclaimed.

### Applying the patch

With `apply: true` the patch is applied **only** if the source tree is still clean, and the output says whether it was applied. Preflight already refuses a dirty tree, so this guard covers the window during a run: a tree that went dirty in the meantime leaves the patch on disk with a reason.

### `expect` matters

- `expect: "green"` — the gate passes today and must stay passing. If it is already red, the tool refuses and spends nothing, because a pre-existing failure cannot be attributed to a model.
- `expect: "red"` — the task is to make a failing gate pass. Use this for "fix the failing test" work.

## Where your change goes

A successful run does **not** edit your working tree. Each attempt runs in a throwaway git worktree, so a failed attempt never pollutes anything. On success you get a patch:

```text
Task mwuwgrtq-0639 passed the gate on t0 after 1 attempt(s); total $0.00400.

  t0         PASS             $0.00400

Patch: /Users/you/.pi/agent/cascade/patches/mwuwgrtq-0639-t0.patch
Apply with: git apply /Users/you/.pi/agent/cascade/patches/mwuwgrtq-0639-t0.patch
```

```bash
git apply ~/.pi/agent/cascade/patches/mwuwgrtq-0639-t0.patch
```

## Stats

```text
/router-stats          # attempts, pass rate, spend, $ per green task
/router-stats reset    # clear the ledger
```

The ledger is `~/.pi/agent/cascade/ledger.jsonl`, outside the repo, so it survives project switches. It stores one row per attempt: tier, outcome, gate exit, error code, tokens, cost. No source code and no raw stderr.

## What runs

```text
preflight (clean tree, deterministic gate)
  └─ baseline gate at HEAD in a throwaway worktree
       ├─ expect:green and red already  → PREEXISTING, stop, spend nothing
       ├─ expect:red and green already  → nothing to fix, stop, spend nothing
       └─ otherwise
            ├─ T0        cheap model, its own worktree → gate
            ├─ T0-repair cheap model + gate error     → gate
            └─ T1        frontier model + gate error  → gate
```

Each attempt is `pi --mode json -p --no-session --model <tier>` with the working directory set to its worktree. The gate runs on the host after the child exits.

The shipped skill is trigger-verified in both directions: a read-only prompt ("explain what src/policy.ts does") does **not** call `routed_subagent`, and a gated repair request in a real repo does.

## Limitations (read before trusting a number)

- **Smoke-tested, not benchmarked.** The published checks cover one `node --test` fixture where T0 succeeded first try, plus unit tests for classification, the ladder, aggregation and the ledger. The escalation and repair paths are exercised by unit tests, not by a multi-repo benchmark. There is no savings claim in this release.
- **Gitignored files are missing from the worktree.** `node_modules`, `.venv`, `venv`, `target` and `vendor` are symlinked in; plain gitignored files (`.env`, local config, build output) are not. A gate that needs one will fail; run the gate in a way that does not depend on them.
- **Your tree must be clean.** Worktrees branch from `HEAD`, so uncommitted work is refused rather than stashed.
- **One cascade at a time.** A single-flight lock serialises runs; a concurrent call is refused rather than queued.
- **Dollar figures exclude credit runs.** `dev`-profile rows are counted separately and never enter total spend or `$ / green task`.
- **The gate runs with your shell.** It is executed as `sh -c <gate>` inside the worktree. Only pass gates you would run yourself.
- **No learning, no replay, no pinning.** Each call starts from the configured tiers; there is no cross-run adaptation in this version.
- **Escalation is priced, not naive.** Default T1 is `deepseek-v4-pro` (~4× T0), not the catalog's priciest model: the same escalation measured `$0.08412` on `kimi-k3` and `$0.02703` on `deepseek-v4-pro`, with the same `t1 PASS`. `kimi-k3` is available explicitly, never by default.

## Design notes

- The runner is a subprocess, not a nested tool call: a custom tool cannot reach `subagent`, and `pi` has no `--cwd` flag.
- Classification keys off the gate's exit code, then a bounded output tail. Environment failures (DNS, connection refused, port in use, rate limits, missing binaries) never escalate the model.
- A task counts as green only if its last attempt passed; `$ per green task` charges every attempt to the task.

MIT.
