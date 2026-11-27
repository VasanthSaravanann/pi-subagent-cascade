---
name: subagent-router
description: Route delegated coding work through cheap-to-frontier model escalation verified by a deterministic gate. Use when a task can be proven done by a shell command (node --test, npm test, pytest, cargo test, tsc --noEmit) and you want a cheap model tried first, with an automatic repair attempt and one escalation to a stronger model. Use it for implementation, bugfix, and refactor work that ends in a runnable check. Do not use it for read-only exploration, code review, research, or any task without a deterministic verification command; for those use the plain subagent tool.
metadata:
  version: "0.2.2"
---

# Subagent cascade router

`routed_subagent` runs T0 → T0-repair → T1. Each attempt is a separate `pi` child in its own git worktree, followed by a host-run gate. A failed attempt is discarded, never rolled back.

## Route first

- Implementation, bugfix, or refactor **with a runnable gate** → call `routed_subagent` with `gate` set to that exact command.
- Exploration, review, research, or anything without a deterministic command → plain `subagent`.
- The user asks for the strongest model up front → plain `subagent` with an explicit `model`.

## Defaults worth knowing

- Tiers resolve: tool param → `PI_CASCADE_TIER0`/`PI_CASCADE_TIER1` → `~/.pi/agent/cascade/config.json` → compiled default. Do not guess a model id; pass one only when the user names it.
- `maxCostUsd` defaults to `$1.00` per repo per trailing 24 h; over budget the call is refused before spending. Leave it alone unless the user sets a budget.
- `apply: true` patches the working tree on success, only while it is still clean. Omit it unless the user asks for the change in place; the default returns a patch path.
- A second concurrent cascade is refused by the run lock. That is expected, not an error to retry in a loop.

## Choose `expect` correctly

- `expect: "green"` (default) — the gate passes today and must stay passing. The tool refuses to dispatch if the gate is already red, because a pre-existing failure cannot be attributed to a model.
- `expect: "red"` — the task is to make a currently failing gate pass. Use this for "fix the failing test" work; without it the tool will (correctly) refuse.

## Do not

- Do not pass a gate that is interactive, long-running, network-dependent, or flaky: no `npm run dev`, `--watch`, `curl`, or remote URLs. The tool rejects these.
- Do not pass a gate that the child could trivially weaken: if the tests are the only check, say in the task that tests must not be deleted or loosened.
- Do not retry the same call after a failure. If the tool reports it did not pass, report the gate output and stop — escalating again by hand is what the cascade exists to avoid.
- Do not claim savings. Report what the tool reported: attempts, per-attempt cost, and the patch path.

## Read the result

The tool returns one of:

| Result | Meaning | Next action |
|---|---|---|
| `PASS` on `t0` | Cheap model solved it | Apply the patch |
| `PASS` on `t0-repair` | Cheap model needed the error text | Apply the patch |
| `PASS` on `t1` | Escalation was required | Apply the patch |
| `PREEXISTING` | Gate was already red at HEAD with `expect:"green"` | Fix or commit the baseline; nothing was spent on a model |
| Did not pass | Every attempt failed | Report the gate tail and the branch of attempts; do not silently retry |

A successful run leaves the user's working tree untouched. The change is a patch file:

```bash
git apply <patchPath>
```

Say this explicitly when reporting a success, or the user will think nothing happened.
