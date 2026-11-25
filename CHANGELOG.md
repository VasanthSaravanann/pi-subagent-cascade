# Changelog

## [0.2.1] - 2026-11-25

Publish readiness. No behaviour change beyond one type fix.

### Added

- `npm run typecheck` (`tsc --noEmit`) and `npm run check`, with `typescript` and `@types/node` as dev dependencies.
- CI at `.github/workflows/check.yml`: Ubuntu and macOS, `npm ci`, typecheck, tests.
- `Security` and `Development` sections in the README, plus an explicit platform statement.

### Fixed

- `apply` was missing from the tool parameter type, so the shipped v0.2.0 did not typecheck (`Property 'apply' does not exist on type 'Params'`). Runtime was unaffected because vitest strips types without checking them — which is why the typecheck gate now exists.

### Packaging

- `author`, `repository`, `homepage`, `bugs` and `engines` (`node >= 20`) added, so npm and the Pi package gallery can link back to the source.

## [0.2.0] - 2026-11-25

Survivable unattended: probe, ceiling, lock, apply — plus a reproducible verification matrix.

### Added

- `scripts/probe-models.mjs`: pings candidates through `pi` (60 s deadline), records `contextWindow`, `maxTokens` and `priced`, and writes `~/.pi/agent/cascade/config.json` (mode `0600`). Refuses to promote an unpriced or `<16384`-output model to primary; exits non-zero without overwriting a good config.
- Tier resolution order: tool parameter → `PI_CASCADE_TIER0/1` → `config.json` → compiled default.
- `maxCostUsd` (or `PI_CASCADE_MAX_COST_USD`, default `$1.00`): per-repo ceiling over the **trailing 24 h of UTC**. Over budget, dispatch is refused with the observed total and no row is written.
- Single-flight lock at `~/.pi/agent/cascade/lock` (`{pid, taskId, startedAt}`, created with `wx`, dead-pid reclaim).
- `apply: true`: applies the successful patch in place, but only while the source tree is still clean.
- `profile` (`dev` / `prod` / `max`) on every ledger row; `dev` (credit-funded) attempts are excluded from total spend and `$ / green task`.
- `.venv`, `venv`, `target` and `vendor` are symlinked into attempt worktrees, not just `node_modules`.
- `fixtures/{rust-t0,python-repair,typescript-deps,escalation-t1,env-fail,timeout}`: one reproducible repo per ladder branch.

### Fixed

- A patch could carry the `node_modules` symlink, so `git apply` failed with `Directory not empty` in any repo with deps. Linked dirs are now excluded from the patch.
- A killed attempt could stall for many minutes (measured: 18) waiting for a grandchild that still held stdout. The runner now resolves on a 5 s grace timer after SIGKILL.
- A `PASS` row no longer records an error code scraped from the child's own transcript.
- Attempt sequencing is `runLadder` (pure, tested with a fake executor) instead of an inline loop.

### Verified

Six fixtures, one per ladder branch (`t0`, `t0-repair`, `t1`, `ENV_FAIL`, `TIMEOUT`, `PREEXISTING`). Escalation measured `$0.02408` end to end on `deepseek-v4-pro`; a first-pass `t0` costs about `$0.0023`. Fixtures are synthetic; still no savings claim.

## [0.1.0] - 2026-11-25

First release. Scope is deliberately narrow: a gate-verified cascade, real per-attempt cost, and a local ledger.

### Added

- `routed_subagent` tool: T0 -> T0-repair -> T1, each attempt in its own git worktree.
- `expect` parameter: `"green"` (must stay passing) or `"red"` (make a failing gate pass).
- Host-run gate after every child exits; the child's own report is never trusted.
- Baseline gate at HEAD, so a pre-existing failure is reported as `PREEXISTING` and never attributed to a model.
- Deterministic outcome classification: `PASS`, `CAPABILITY_FAIL`, `ENV_FAIL`, `PREEXISTING`, `TIMEOUT`, `ERROR`.
- Append-only JSONL ledger at `~/.pi/agent/cascade/ledger.jsonl` with per-attempt tokens, cost and error code.
- `/router-stats` and `/router-stats reset`.
- Patch output: a successful run leaves the working tree untouched and returns a patch path.
- `skills/subagent-router` routing skill.

### Changed

- Default T1 is `opencode-go/deepseek-v4-pro` instead of `kimi-k3`: the same escalation costs `$0.02703` instead of `$0.08412` (measured, same `t1 PASS`).
- Context-window preflight via `ctx.modelRegistry`; `CONTEXT_FAIL` (`stopReason: "length"`) never escalates, because T1 does not buy a meaningfully larger window.
- Unpriced providers (no catalog pricing) are recorded as `costKnown: false` and surfaced by `/router-stats` instead of reading as `$0.00`.

### Known limits

- Smoke-tested on one fixture, not benchmarked. No savings claim.
- Escalation and repair paths are covered by unit tests only.
- Worktrees do not carry gitignored files beyond a `node_modules` symlink.
- No cross-run learning, no replay, no session pinning yet.
