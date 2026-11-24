# Changelog

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

### Known limits

- Smoke-tested on one fixture, not benchmarked. No savings claim.
- Escalation and repair paths are covered by unit tests only.
- Worktrees do not carry gitignored files beyond a `node_modules` symlink.
- No cross-run learning, no replay, no session pinning yet.
