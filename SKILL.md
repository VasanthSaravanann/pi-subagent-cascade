# pi-subagent-cascade — design of record

> **Not a skill, and not the shipped one.** Users get `skills/subagent-router/SKILL.md`.
> This file is internal engineering notes: tracked in git (since 27 Nov), excluded from the
> npm tarball by the `files` whitelist, and never loaded at runtime. It deliberately has no
> skill frontmatter — a `name: subagent-router` header here would collide with the real skill.

| | |
|---|---|
| Package | `@vasanthsaravanan/pi-subagent-cascade` |
| Status | **published 27 Nov 2026** — `0.2.3` is `latest`, verified by installing the registry tarball and running a live cascade through it |
| Repo | github.com/VasanthSaravanann/pi-subagent-cascade (public) |
| Verified against | pi-coding-agent 1.6.0, pi-subagents 0.90.0, pi-subagent-model-router 0.3.0, vitest 3.2.7 |
| Lineage | `subagent_routers.md` → `plan.md` → `execution-plan.md` → this file |
| Uncommitted siblings | `plan.md`, `execution-plan.md`, `protocol .md`, `subagent_routers.md`, `docs/` |

Read by task: §2 constraints, §6 architecture, §7 execution log, §8 test matrix, §9 fixes, §10 environment traps, §12 rules. §1–§5 are the analysis that produced the scope; they are settled and should not be re-litigated without a measurement.

## 1. Verdict

- **The gap is exactly one thing:** nothing escalates a subagent to a stronger model after a **failed gate**. `pi-subagent-model-router` is confirmed pre-execution-only ("never launches or retries a native run itself"); `pi-subagents` deliberately does not fall back to another model on failure.
- **Everything else the original proposal wanted already exists:** worktree isolation, host-run gates, typed gates, per-launch model, per-child cost. Rebuilding them was the proposal's main error.
- **Cut permanently:** Rust/WASM classifier, Wilson lower-bound skip, `git stash`/`git clean` rollback, 4-bucket taxonomy, config-file cost rates, `/router-replay`.
- **Shipped size:** ~600 lines of TypeScript across 7 modules, not a crate.
- **The missing piece in the proposal was not code, it was order:** repair on the same cheap tier *before* escalating. That is now the second rung of the ladder.

## 2. Verified API facts (these shaped the architecture)

| Assumption | Reality (pi 1.6.0) |
|---|---|
| `before_subagent_spawn` hook | Does not exist. Use `tool_call` / `tool_result` / `tool_execution_*`. |
| Parent sees the child's tool results | No. Child is a separate process; parent only sees its own tools' results. |
| A custom tool can call `subagent` | **No.** `ctx.tools` = `read, bash, edit, write, subagent_launch, bg_wait`. `executeTool("subagent")` returns `{toolCall, result, isError:true}` in ~1 ms. `subagent_launch` exists but is an internal workflow-child contract. |
| Nested tool call result shape | `r.toolCall`, `r.result`, `r.isError` — read `r.result`, not `r.content`. |
| Tool `details` may hold anything | It is structured-cloned. A non-plain payload fails with `(...)=>definition.execute(...) could not be cloned`. |
| `pi` has a `--cwd` flag | **No.** cwd is set on the spawned process. This is what makes per-attempt worktrees possible. |
| Extension commands print output | `ctx.ui.notify` renders only in the TUI. Emit to stderr when `!ctx.hasUI`. |
| Gate exit code is in `details.exitCode` | It was `null` on a non-zero exit. Parse the tool-result text / your own host run instead. |
| Parent must run gates | Yes — always. Never trust a child's own "tests pass". |
| Peer dependency name | `typebox` (not `@sinclair/typebox`, which is a legacy import alias). |
| Package entry | `pi.extensions: ["./src/index.ts"]` works with no build step; `dist` + `tsc` only introduces stale-bundle failures. |

Also verified: `pi --mode json -p --no-session` child emits `message_end` events with assistant `usage.cost.total` (measured `$0.00252` for a 2-turn run) and `toolResult` content carrying `EXIT_CODE=1` plus assertion stderr.

## 3. Gap analysis

| Layer | State |
|---|---|
| Pi core | Virtual models route per request with persistent per-branch `state` (`docs/virtual-models.md`); escalation for the main agent is ~110 LOC (`examples/extensions/jev-router.ts`). Snapshots exist (`examples/extensions/git-checkpoint.ts`). No gate feedback. |
| pi-subagents 0.90.0 | Per-launch model + thinking suffix, `worktree: true`, host-run `options.gate` and typed gates, acceptance/review gates, per-child cost, workflow scripts, watchdog. No model fallback on failure. |
| pi-subagent-model-router 0.3.0 | Rubric/LLM judge before the call, then abstains. No ledger, no feedback, no retry. |
| This package | The missing loop: gate-observed escalation with repair-first, isolation, and a real cost ledger. |

A cascade was also expressible as a ~50-line `pi-subagents` workflow script. That was the correctness baseline to beat, and the reason the first release is deliberately small.

## 4. Economics (why "learning" is deferred)

```
E[cascade]  = C0 + (1 - p0) * C1
E[frontier] = C1
cascade wins iff p0 > C0 / C1
```

With the proposal's own numbers (`C0/C1 = 0.125`), the unconditional cascade is optimal for any task class passing more than 12.5%. Consequences that decided the roadmap:

1. An adaptive "skip T0" layer can save at most **one cheap attempt per task**; the dumb cascade saves ~3× that on a 50% class. The statistics are not where the money is.
2. `minSamplesForSkip: 8` with a 90% Wilson bound requires **0/8 successes** to fire. Inert exactly where it would matter.
3. Cost must come from observed usage, not a config table: blended rates hide cache reads, where the savings actually live.
4. Latency is a first-class term; escalation doubles wall-clock and loses the prompt cache.
5. The ledger is one-armed: `T0: FAIL` says nothing about what T1 would have done. Any adaptive claim needs randomized exploration first.

## 5. Defects avoided, and corrections found by building

Avoided by design (from the proposal): escalating before repair; no baseline gate; observing gates in the child's stderr; promising a failed-diff on escalation that isolation makes impossible; test-weakening as "success".

Found only by running it:

1. **A blanket `PREEXISTING` refusal breaks the primary use case.** "Fix the failing test" starts red by definition; the first smoke run was correctly refused and did nothing. Fixed with `expect: "green" | "red"`. Red remains a hard stop only when green was promised; red becomes the target when asked for.
2. **`/router-stats` was invisible outside the TUI**, so it was untestable and looked broken. Now emits to stderr when `!ctx.hasUI`.
3. **`T0 first-pass 50%` was a lie with two tasks** — the PREEXISTING run was counted in the denominator. Aggregation now reports `routed` tasks and divides by that.
4. **An LLM paraphrases complex gate strings.** A gate with shell arithmetic was rewritten when the model constructed the call, so the intended escalation never fired. Keep gates plain; verify determinism in the tool, not in the prompt.
5. **Worktrees do not carry gitignored files.** `node_modules` is symlinked; `.env` and build artifacts are not. Documented, not solved.

## 6. Shipped architecture (v0.1.0)

```
src/index.ts       tool `routed_subagent` + `/router-stats` command, orchestration
src/runner.ts      spawn `pi --mode json -p --no-session --model <tier>`, parse events
src/isolation.ts   preflight, git worktree add/remove, `sh -c` gate with deadline
src/classify.ts    PASS / CAPABILITY_FAIL / ENV_FAIL / PREEXISTING / TIMEOUT / ERROR
src/policy.ts      ladder sequencing (`runLadder`), prompts, tiers, ceiling, aggregation, stats (pure)
src/ledger.ts      append-only JSONL, task ids, signatures
src/types.ts       shared shapes
test/*.test.ts     78 unit tests (classifier+gate predicate, ladder w/ fake executor, tiers, ceiling, aggregation, ledger, lock, isolation)
skills/subagent-router/SKILL.md   the shipped routing skill
```

Loop:

```
preflight (clean tree, deterministic gate)
  └─ baseline gate at HEAD in a throwaway worktree
       ├─ expect:green and red  → PREEXISTING, stop, $0
       ├─ expect:red and green  → already satisfied, stop, $0
       └─ otherwise
            ├─ t0        cheap model, own worktree → host gate
            ├─ t0-repair cheap model + gate error  → host gate
            └─ t1        frontier model + gate error → host gate
```

- Each attempt: detached worktree from `HEAD`, `node_modules` symlinked, child spawned with that worktree as cwd, gate run on the host afterwards, worktree force-removed.
- Success writes a patch (`git -C wt add -A; git diff --cached --binary`) to `~/.pi/agent/cascade/patches/<taskId>-<tier>.patch`. **The user's tree is never modified** — the change lands with `git apply`.
- Ledger row per attempt (`~/.pi/agent/cascade/ledger.jsonl`): `ts, taskId, repo, sig, tier, attempt, model, outcome, gate, gateExit, errCode, errTail(≤300), baselineGreen, durationMs, costUsd, tokens, patchFile, escalatedTo`. No source, no raw stderr.
- Timeouts: per-attempt deadline (default 8 min) with process-group SIGKILL; `TIMEOUT` never escalates.
- **v0.2.0/0.2.1 unattended safety**, all verified live: model probe writes `~/.pi/agent/cascade/config.json` (0600) and refuses to promote unpriced or <16k-output models; tier resolution is param → `PI_CASCADE_TIER0/1` → config → default; a per-repo **trailing-24h-UTC** cost ceiling (default $1.00) refuses dispatch with the observed total and writes no row; a single-flight lock (`{pid,taskId,startedAt}`, `wx`, dead-pid reclaim) serialises runs; `apply: true` patches the source tree only while it is clean; `node_modules`, `.venv`, `venv`, `target`, `vendor` are linked into every worktree.
- Every ledger row carries `profile` (`dev`/`prod`/`max`); `dev` (credit-funded) attempts are counted separately and excluded from total spend and `$/green task`. Legacy rows read as `prod`.
- `npm run check` = `tsc --noEmit` + vitest, run in CI on Ubuntu and macOS. v0.2.0 shipped a type error because vitest strips types: the typecheck gate exists because of that.
- Host gate runs are executed with `PI_CASCADE_GATE=1` in the environment, so a gate can tell a host run from a child invoking it.
- An unusable tier model (not found / deprecated / provider rejected) ends the ladder as `ERROR` instead of burning the repair and escalation rungs.
- Defaults: T0 `opencode-go/deepseek-v4.1-flash`, T1 `opencode-go/deepseek-v4-pro`; overridable per call (`kimi-k3` only as an explicit opt-in).
- Preflight reads `ctx.modelRegistry`: unknown model → refuse; `contextWindow < 64,000` → refuse. Resolved windows are reported in the tool output and in `details.tiers`.

### 6.1 Model landscape and resolution

Prices are **per 1M tokens** from the catalog; `ctx/out` are the model's own limits. Verified by probe, not assumed.

| Model | $in | $out | ctx | max out | Verdict |
|---|---|---|---|---|---|
| `opencode-go/mimo-v2.6-flash` | 0.14 | 0.28 | 1M | 131k | cheapest usable Chinese flash |
| `opencode-go/deepseek-v4.1-flash` | 0.15 | 0.60 | 1M | **384k** | **T0 default** — measured $0.002–0.004/task |
| `opencode-go/qwen3.8-flash` | 0.15 | 0.47 | 1M | 131k | driver/session default |
| `opencode-go/minimax-m3.1-flash` | 0.15 | 0.60 | 1M | 512k | biggest output among flashes |
| `opencode-go/deepseek-v4-pro` | 0.66 | 1.98 | 1M | 384k | **T1 default** — measured $0.0197 |
| `opencode-go/glm-5.3` | 1.40 | 4.40 | 1M | 131k | alternative T1 |
| `opencode-go/qwen3.8-max` | 2.00 | 6.00 | 1M | 131k | opt-in |
| `opencode-go/kimi-k3` | 3.00 | 15.00 | 1.05M | 1.05M | **opt-in only** — 20× T0 |
| `opencode-go/gpt-6-luna` | 0.10 | 0.50 | 1.05M | 128k | cheapest overall, but priced per input tier above 272k |
| `adaption/*` (all) | — | — | up to 1M | **8k** | credit-funded, **unpriced** — dev/test only |

**Price is not nationality.** The two cheapest paid models in this catalog are American (`gpt-6-luna`, `claude-haiku-5-5`, both $0.10/$0.50); the most expensive are `kimi-k3` ($3/$15) and `qwen3.8-max` ($2/$6), which are not. Rank by `$/capability/context`, never by vendor or country.

Three consequences, all verified by running:

1. **The T0 window is not the constraint.** 1M tokens with a 16,384 reserve (~983k usable) against a measured ~24k-token attempt — 40× headroom. Per-attempt context is isolated by construction: every rung is a fresh `pi --mode json -p --no-session` process.
2. **T1 must add capability, not just price.** `kimi-k3` adds 5% context and 20× cost; the same-family pro tier adds capability for ~4× T0. Measured on the escalation fixture: `kimi-k3` T1 → **$0.08412**, `deepseek-v4-pro` T1 → **$0.02703**, both `t1 PASS`. Same result, 3.1× cheaper.
3. **The adaption fallback is not production-grade.** Every adaption model caps at **8,192 output tokens** and publishes **no pricing**, so rows must read `costKnown:false` and count as $0. It is a credits-funded **dev/test** tier for small tasks, never a silent production swap.

### 6.2 Profiles

| Profile | T0 | T1 | Use |
|---|---|---|---|
| `dev` | `adaption/deepseek-v4-flash` | `adaption/glm-5.2` | fixtures, smoke tests, small tasks — spends credits, not dollars |
| `prod` | `opencode-go/deepseek-v4.1-flash` | `opencode-go/deepseek-v4-pro` | real work; both Chinese, both priced, 1M ctx |
| `max` | `opencode-go/deepseek-v4.1-flash` | `opencode-go/kimi-k3` | explicit opt-in when a task needs the strongest model |

Spend credits on fixtures; spend money only on release verification and real work. Ledger rows carry the profile so credit-funded runs can never be mistaken for cost data.

The driver loop is the real long-context risk, not any child: run a night as a **sequence of short `pi -p` invocations per step**, with state in the repo, the ledger and `~/.pi/agent/cascade/run-*.log`. Never one session holding the whole plan plus every result.

Probe before any long or costly run — a model that answers `PING_OK` is the only model you may spend on:

```bash
pi -ne -p 'Reply with exactly: PING_OK' --model opencode-go/deepseek-v4.1-flash
```

Resolution order (v0.2.0): tool param → `PI_CASCADE_TIER0/1` env → `~/.pi/agent/cascade/config.json` (written by `scripts/probe-models.mjs`) → compiled default. An unusable model is a hard `ERROR`, never a silent fall-through to the ladder (see §9).

Toolchains on this machine: `node 23.9`, `python3 3.15`, `cargo 1.100`, `jq`, `git`. **No `go`** — no Go fixture. Python fixtures use stdlib `unittest`, not pytest.

## 7. Execution log

| Stage | Outcome |
|---|---|
| Analysis against installed sources | 12 API mismatches found; proposal's architecture reduced to one missing policy |
| Repo init | `.gitignore` first, `.hygiene-guard` marker, scoped pre-commit hook, LICENSE, `package.json` (`pi.extensions` → `src/index.ts`, no build) |
| V1-01 spike (gate) | `subagent` not callable from a tool → **subprocess runner** chosen; cost + gate text proven extractable |
| Implementation | 7 modules, ~600 LOC, patch-based output |
| Unit tests | 25 tests / 3 files, green |
| Live fixtures | T0 first-pass PASS `$0.00400`; T0-repair PASS `$0.00690`; red-baseline refusal `$0` |
| Packaging | tarball = 12 files, no internal docs; install-from-tarball verified; `/router-stats` verified in `pi -p` |
| Release | tag `v0.1.0`, pushed; **npm publish deliberately not run** |
| v0.2.0 night | Phases A–D executed in one autonomous loop: 7 commits, six fixtures, six ladder branches, tag `v0.2.0`; publish held |
| Typecheck catch | `tsc --noEmit` on the tagged v0.2.0 failed (`apply` missing from `Params`); vitest strips types, so nothing caught it. Fixed, CI + `npm run check` added, tag `v0.2.1` |
| Publish readiness | metadata, `Security`/`Updates`/`Development` README sections, version consistency; tag `v0.2.2` |
| Wipe + restore | project dir found emptied except `node_modules`; code restored from `origin`, `SKILL.md`/`execution-plan.md`/`subagent_routers.md` rebuilt byte-exact from a session transcript, `plan.md`/`protocol .md` lost |
| Publish | 2FA-staged on first attempts; `0.2.2` burned, `0.2.3` published and approved; verified by installing the registry tarball and running `fixtures/rust-t0` (`t0 PASS $0.00245`) |

Commits: `a70edbc` `51a564c` `b19b28b` (scaffold, hygiene guard, manifest) → `053467c` (runner) → `e693957` (tests) → `8287720` (docs + skill) → `099d11a` (stats fix). Tag `v0.1.0`.

## 8. Test matrix

Unit (`npx vitest run`, 25 tests): zero exit → PASS; red baseline → PREEXISTING even on exit 0; compile/assertion → CAPABILITY_FAIL; DNS/connection/port/429/`command not found` → ENV_FAIL; null exit → ERROR; `E0597`/`TS2322`/`ERR_ASSERTION` extraction; ladder ids and order; only CAPABILITY_FAIL continues; repair vs escalation prompt wording; timeout wording; tail bounding; aggregation of first-pass/repairs/escalations; cost charged to the task not the winner; `routed` excludes PREEXISTING; stats caveat; torn-line tolerance; id uniqueness; signature grouping.

**v0.2.0/0.2.1 matrix** — one committed setup script per ladder branch under `fixtures/`, each building a throwaway repo in `/tmp/cascade-verify/<name>`. Observed rows, one machine, one night (synthetic fixtures; no benchmark):

| Fixture | Branch | Rows | Observed |
|---|---|---|---|
| `rust-t0` | `t0` first pass | 1 | `t0 PASS $0.00229`; patch applies; `cargo test` green |
| `python-repair` | `t0-repair` | 2 | `t0 CAPABILITY_FAIL $0.00270` → `t0-repair PASS $0.00293`, total `$0.00563` |
| `typescript-deps` | deps in worktree | 1 | `t0 PASS $0.00273`; gate `pass 4 / fail 0`; patch carries no `node_modules` |
| `escalation-t1` | `t1` | 3 | `t0 $0.00224` → `t0-repair $0.00328` → `t1 PASS $0.01857` on `deepseek-v4-pro`, total **`$0.02408`** |
| `env-fail` | `ENV_FAIL` | 1 | `ENV_FAIL`, `escalatedTo: null`, `$0.00194` |
| `timeout` | `TIMEOUT` | 1 | `TIMEOUT`, `escalatedTo: null`, 20.8 s wall, no orphan |
| baseline | `PREEXISTING` | 1 | refused at HEAD, `$0` |

Older v0.1.0 fixtures at `/tmp/cascade-fix/*` still hold: `easy` (T0 first pass, needs `expect:"red"`), `repair` (T0 fails, repair passes), `broken-at-head` (refuse, `$0`), `t1` (all three tiers, `$0.08412` on `kimi-k3`).

Fixture lessons, all paid for:

1. **The baseline check is a host run.** A counter gate set to "needs two host runs" let `t0` pass first try (baseline=1, t0=2); the repair fixture needs three.
2. **The child runs the gate itself.** Host runs carry `PI_CASCADE_GATE=1` so a gate can tell them apart; without it `t0-repair` passes and escalation never happens.
3. **A reasoning-heavy fixture task turns T1 into `TIMEOUT`** (two runs, `$0.034` and `$0.026`, no gate reached). The escalation fixture asks for a trivial edit; it tests the ladder, not model stamina.
4. **Build artifacts dirty the tree** — the Rust fixture was refused until `target/` and `Cargo.lock` were ignored.

Also verified: a patch from a run applies to a **fresh clone** and turns the gate green (`pass 1 / fail 0`), and the shipped skill loads via `/skill:subagent-router` (returned `SKILL_LOADED`) with the package installed from a local path.

Aggregate after a ledger reset: 2 tasks, 2 routed, 2 green, T0 first-pass 0%, repaired 2, escalated 0, `$0.01355` total, `$0.00678` per green task. n=2, synthetic tasks — a plumbing readout, not a measurement.

## 9. Fixes applied

| Symptom | Cause | Fix |
|---|---|---|
| First smoke run refused everything | baseline guard applied unconditionally | `expect` parameter (green/red) |
| `/router-stats` printed nothing under `-p` | `ctx.ui.notify` is TUI-only | stderr when `!ctx.hasUI` |
| `T0 first-pass 50%` with one routed task | denominator included PREEXISTING | `routed` counter |
| `signature("… rust …")` → `any` | regex required `.rs` | added `\brust\b`, `\bts\b`, `\bgo\b` |
| Tool result clone error | non-plain `details` payload | plain JSON only |
| Commits ignored the new hook | global `core.hooksPath=~/.githooks` | repo-scoped `~/.githooks/pre-commit` + `.hygiene-guard` marker |
| A doc leaked into a test commit | hook was in `.git/hooks`, dead on this machine | `reset --soft` + `git rm --cached`, file preserved |
| Every bare `pi` call 403'd | `defaultModel: kimi-k2.6` deprecated → vercel fallback needs a card | `defaultModel: qwen3.8-flash` (settings backed up) |
| T1 never reached in two fixtures | the child ran the gate itself, advancing the fixture counter | host gate runs now carry `PI_CASCADE_GATE=1` |
| Escalation cost 20× the task | T1 default was the priciest model in the catalog (`kimi-k3`) | T1 default is `deepseek-v4-pro`: measured `$0.08412 → $0.02703`, same `t1 PASS` |
| Unpriced provider rows looked free | Pi reports `usage.cost.total = 0` when pricing is absent, and `cost` exists with zeros | `priced` from the catalog (`cost.input > 0`); `costKnown:false` rows are counted and surfaced by `/router-stats` |
| A context overflow would have escalated | no `stopReason` handling | `CONTEXT_FAIL` outcome from `stopReason: "length"`; never escalates |
| A typo'd tier model would burn all three rungs | no model preflight | detect not-found/deprecated in child stderr → `ERROR`, stop |
| A patch could not be applied anywhere | `capturePatch` staged the linked `node_modules` symlink (mode 120000) | linked dirs excluded from the `git add` pathspec |
| A killed attempt stalled 18 minutes | SIGKILL did not close the pipes; a grandchild held stdout, so `close` never fired | both runners resolve on a 5 s grace timer after the kill |
| A green run recorded `ERR_MODULE_NOT_FOUND` | error code scraped from the child's own transcript | error codes only on non-`PASS` rows |
| `tsc --noEmit` failed on the shipped v0.2.0 | `apply` missing from the tool `Params` type; vitest strips types | field added, `npm run check` + CI |
| Escalation fixture never escalated | reasoning-heavy task → T1 died at the deadline as `TIMEOUT` (which never escalates) | fixture task is a trivial edit |
| Rust fixture refused at preflight | `cargo test` created `target/` and `Cargo.lock` | gitignored in the fixture; documented as a user trap |

## 10. Environment traps

- `core.hooksPath` is set to `~/.githooks`; anything in `.git/hooks/` never runs. The live guard is `~/.githooks/pre-commit`, inert unless the repo root has `.hygiene-guard`.
- Model availability is fragile: `opencode-go` works today (`deepseek-v4.1-flash`, `qwen3.8-flash`, `kimi-k3`), `adaption` is rate-limited, `vercel-ai-gateway` needs a card. Verify with a one-line ping before any long run.
- npm is authenticated as `vasanthsaravanan`; `npm publish` may still require a 2FA OTP, which an unattended run cannot answer.
- macOS has no `timeout` binary — use spawn timers or the tool's own timeout.
- **Ledger `ts` is UTC ISO.** Any "today's spend" filter built from `date +%F` (local) silently reads `$0.00` and disables the cost ceiling. Verified failure. Use `date -u`, or parse the timestamp.
- `ctx.modelRegistry.find(provider, id)` returns `contextWindow`, `maxTokens` and `cost`; it is the only trustworthy source for those at runtime.
- Pi's catalog fills unknown pricing with `0`, so `usage.cost.total == 0` cannot be distinguished from free without the catalog. Always cross-check `cost.input`.
- Children auto-compact at `contextWindow - 16,384` (default `reserveTokens`), emitting `compaction_start`/`compaction_end`. A compaction is normal, not a failure; only `stopReason: "length"` is terminal.
- Model availability is the most likely 3am failure: probe first, keep the `adaption` fallback, and never let a tier be hardcoded without a config-backed override.
- A **child runs the gate itself** to check its work. Any gate with mutable state must use the `PI_CASCADE_GATE=1` marker to distinguish host runs from child runs, or the fixture will lie to you (this is how two T1 fixture attempts were wasted).
- Worktrees are created under `$TMPDIR/pi-cascade/<taskId>`; stale ones are pruned on removal, but a killed run can leave directories behind.

## 11. Git and tarball boundaries

Never committed: `plan.md`, `protocol*.md`, `subagent_routers.md`, `execution-plan.md`, `docs/`, `VERSION.md`, `v[0-9]*.md`, `*.local.md`.

**Changed 27 Nov:** `SKILL.md` (this file) **is tracked**. It was excluded until a directory wipe destroyed it and the only recovery path was a pi session transcript; a design of record with no backup is a liability. It stays out of the npm tarball through the `files` whitelist in `package.json`, which is the boundary that actually matters for users. Consequence accepted: the repo is public, so this analysis is public too.

Guard before every commit and push:

```bash
git ls-files | grep -E '^(plan\.md|protocol.*\.md|subagent_routers\.md|execution-plan\.md|VERSION\.md|v[0-9][^/]*\.md|docs/)' \
  && echo "FAIL: internal doc staged" || echo "PASS: hygiene clean"
```

Tarball is governed separately by `files` in `package.json`: `["src","skills","README.md","LICENSE","CHANGELOG.md"]`. Verified: `npm pack --dry-run` ships 12 files and zero internal docs. Both boundaries must hold — a doc excluded from git can still ship, and a file excluded from npm still reaches GitHub.

## 12. Hard rules

- Never mutate the user's working tree to roll back; every attempt gets a worktree.
- Never trust a child's self-reported success; only a host-run gate counts.
- Never attribute a red baseline to a model.
- Repair before escalate; never escalate on ENV_FAIL, TIMEOUT, or PREEXISTING.
- Classifier stays ~100 lines and pure. A toolchain change needs a measurement first.
- Cost comes from the child's usage events, never from a config table.
- LEDGER: no source, no raw stderr, bounded tail only.
- `SKILL.md` is tracked and backed up; the npm tarball is governed only by `files`. Never let a design doc exist solely on one disk.
- Never publish an artifact not installed from its own tarball.
- One `subagent-router` skill in the package; design notes live in `docs/`, not a second skill.
- Keep `package.json` version, `CHANGELOG.md` heading, skill `metadata.version`, and the git tag in step.
- Do not ship a savings claim from an unrandomized ledger, and do not let fixtures become benchmarks.

## 13. v0.2.0 night — what shipped

Executed in one autonomous loop, one commit and push per verified step.

| Phase | Step | Result |
|---|---|---|
| A | `A1` gate determinism predicate | `isDeterministicGate` extracted; 13 assertions both directions |
| A | `A2` ladder loop | `runLadder(plan, attempt)` pure + fake-executor tests; live `easy` `t0 PASS $0.00231` |
| A | `A3` skill negative trigger | read-only prompt → 0 tool calls; gated repo prompt → tool called |
| B | `B0` ledger profile | `dev` rows excluded from every dollar figure; legacy rows read `prod` |
| B | `B1` model probe | refuses unpriced/8k-output primaries; a failed probe leaves config untouched |
| B | `B2` tier resolution | param → env → config → default, verified live |
| B | `B3` cost ceiling | trailing-24h UTC per repo; refusal named `$0.00684`, zero rows written |
| B | `B4` lock | live-pid refusal + dead-pid reclaim |
| B | `B5` dep dirs | `.venv` gate passes in the worktree; gitignored `.env` still absent |
| B | `B6` `apply: true` | applied in place on a clean tree; dirty-tree branch is a race guard only |
| C | `C1`–`C6` | all six ladder branches recorded with real rows (§8) |
| C | `C7` | README + CHANGELOG matrix, every number traced to `jq` |
| D | `D1`–`D4` | README truth pass, `v0.2.0` in three places, tarball round trip, tag pushed |
| D | `D5` | **HELD** — `npm publish` is a human decision |

Bugs found by running it, all fixed (details in §9): patch carried the `node_modules` symlink; killed attempt stalled 18 min on a held pipe; `PASS` rows recorded a scraped error code; escalation fixture lied twice (baseline is a host run; reasoning-heavy tasks become `TIMEOUT`); build artifacts dirtied the tree.

Non-finding: `apply: true`'s dirty-tree branch is unreachable in the normal flow, because preflight refuses a dirty tree first. The unit test proves the guard, not the live path.

## 13.1 Publish readiness (v0.2.1)

Checked against `docs/packages.md` of pi-coding-agent 1.6.0.

| Requirement | State |
|---|---|
| `pi.extensions` / `pi.skills` manifest | present; loading verified from the packed tarball |
| Host packages in `peerDependencies` `"*"`, never `dependencies` | compliant; **zero runtime deps** |
| `pi-package` keyword → gallery eligibility | present |
| `CHANGELOG.md` with `## [x.y.z]` headings | 0.1.0 / 0.2.0 / 0.2.1 |
| `files` boundary | 19 files, no internal docs |
| `npm publish --dry-run` | clean, no warnings |
| Name free on npm | 404 → unpublished; scope authenticated |
| Source visible | GitHub repo public |
| typecheck + tests in CI | `.github/workflows/check.yml`, Ubuntu + macOS |
| Version consistency | package.json, lock, CHANGELOG, skill metadata all 0.2.1 |

Distribution is Pi's own machinery: `pi-package` keyword for the gallery, install records the source in settings, and unpinned npm installs get the `Package Updates Available` notice plus `pi update --extensions` / `pi update <source>`. A version-pinned or local install is never update-checked. Changelogs show only when `package.json`'s `version` advances.

Not closable by me: `npm publish` needs a 2FA OTP, and Windows support is unclaimed rather than fixed.

## 13.2 Publish log (27 Nov 2026, UTC)

Chronological, including the failures. Everything under "Result" was observed, not intended.

| Time | Action | Result |
|---|---|---|
| 04:08–05:45 | v0.2.0 night (Phases A–D) | 78 tests, six fixtures, tag `v0.2.0`; publish held |
| 05:47 | `tsc --noEmit` on the shipped v0.2.0 | failed: `apply` missing from `Params` → fixed, tag `v0.2.1`, CI + typecheck added |
| 05:48 | `npm publish --dry-run` | clean, 19 files, no warnings |
| 05:49 | `npm whoami` | **401** — the 40-char classic token in `~/.npmrc` was rejected; the OTP cannot fix a 401 |
| 05:52 | `npm login` (human) | token replaced; `whoami` → `vasanthsaravanan` |
| 05:54 | `npm publish --otp <code>` | **403** "Two-factor authentication or granular access token with bypass 2fa enabled is required" — the code was stale |
| 05:54 | `npm publish --access public` | **403**, same reason (no OTP at all) |
| 06:00 | `npm publish --access public` (0.2.2) | **202** "being processed" — a *staged* publish, not a release. Registry created `0.0.0-stage` ("Temporary package placeholder for staged publishing") under our own account |
| 06:03 | republish 0.2.2 | **409** "Cannot publish over previously staged version \"0.2.2\"" |
| 06:05 | bump to 0.2.3, tag, publish | **202** again — staged |
| 06:07 | human approves in the npm UI | `versions: [0.0.0-stage, 0.2.2, 0.2.3]`, `latest: 0.2.3` |
| 06:09 | `npm unpublish …@0.0.0-stage` | **403** "Granular access tokens that bypass two-factor authentication may not perform this action" — needs the web UI |
| 06:10 | `npm deprecate …@0.2.2` | accepted; 0.2.2 marked deprecated |
| 06:12 | install from registry, run `fixtures/rust-t0` | `t0 PASS`, `$0.00245` — the published code works |

Findings that are product knowledge, not trivia:

1. **2FA-staged publish is a distinct state.** `202` + a `0.0.0-stage` holding version means uploaded-but-not-released. A second publish of the same version then fails `409`. Either bump the patch version or approve the stage.
2. **`npm stage list` lies to a classic token.** It returned "No staged packages found" while a stage existed; `GET /-/stage` returned `{"items":[],"total":0}`. Do not use it to decide whether a publish landed.
3. **The registry packument is CDN-cached.** `npm view` and `curl` reported only `0.0.0-stage` for ~7 minutes after approval. `curl "https://registry.npmjs.org/<pkg>?t=$(date +%s)"` showed the truth immediately. Never conclude a publish failed from a cached read.
4. **Bypass-2FA granular tokens are read/publish-only now.** They can publish but not unpublish; the error cites gh.io/npm-gat-bypass2fa-deprecation. Destructive npm operations need a browser session.
5. **A staging bug in the *pipeline*, not the product.** The 0.2.2 version number was burned by the first staged attempt, so the deprecated version and the live one differ only in changelog text. Keep the publish step separate from the version bump so a retry does not consume a number.

Artifact identity check that should be repeated every release:

```bash
npm pack --dry-run 2>&1 | grep shasum            # local
npm view @vasanthsaravanan/pi-subagent-cascade@<v> dist.shasum
# then: curl -sL "$(npm view …@<v> dist.tarball)" | shasum
```

## 14. Open items

- **Published 27 Nov:** `0.2.3` is `latest`; `0.2.2` is live but deprecated (identical code, published minutes apart while npm staged the first attempt). The `0.0.0-stage` holding version remains: `npm unpublish` is refused for bypass-2FA granular tokens, so it needs the npm web UI (Manage versions) if it should disappear.
- **Publish path that actually works:** a bypass-2FA granular token in `~/.npmrc` plus `npm publish --access public`. With 2FA enforced and no OTP, npm returns `202` and stages the publish behind a `0.0.0-stage` holding version; republishing the same version then fails with `409 Cannot publish over previously staged version`. Bump the patch version or approve the stage in the UI.
- **Registry cache:** `curl`/`npm view` kept reporting only `0.0.0-stage` for ~10 minutes after the publish was approved. A cache-busted request (`?t=<epoch>`) showed the new versions immediately; do not conclude a publish failed from a cached packument.
- **Recovery note (27 Nov):** the project directory was wiped except `node_modules` — no `.git`, no source. Code came back from `origin` (tags v0.1.0 … v0.2.3); `SKILL.md`, `execution-plan.md` and `subagent_routers.md` were reconstructed byte-exactly from a pi session transcript. `plan.md` and `protocol .md` were unrecoverable and are superseded. **`SKILL.md` is now tracked** (27 Nov) after that incident; the remaining drafts (`execution-plan.md`, `subagent_routers.md`) still have no backup and a copy lives at `~/Desktop/pi-subagent-cascade-notes/`.
- Windows is unclaimed, not fixed: `sh -c` gates and process-group SIGKILL are POSIX. Deliberately absent from CI.
- Known production gaps, in order: the lock is machine-wide rather than per repo; no stale-worktree sweep after a hard kill; the gate is an exit code, so a deleted/skipped test still passes; no steering, resume, or crash recovery.
