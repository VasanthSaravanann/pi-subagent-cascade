/**
 * routed_subagent — gate-verified cheap-to-frontier escalation for Pi children.
 *
 * Loop: preflight → baseline gate at HEAD → T0 → T0-repair → T1.
 * Every attempt runs in its own `git worktree` (so a failed attempt is simply
 * discarded) and every attempt is recorded in the JSONL ledger with its real
 * cost from the child's own usage events.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyChildSignal, classifyGate, extractErrCode, isDeterministicGate } from "./classify.js";
import {
	addWorktree,
	applyPatch,
	capturePatch,
	linkDependencyDirs,
	preflight,
	removeWorktree,
	runShell,
} from "./isolation.js";
import { LEDGER_DIR, acquireLock, appendRow, newTaskId, readConfig, readRows, releaseLock, resetLedger, signature } from "./ledger.js";
import { DEFAULT_TIER0, DEFAULT_TIER1, aggregate, attemptTask, errTail, formatStats, planAttempts, resolveCostCeiling, resolveProfile, resolveTier, runLadder, spendInWindow } from "./policy.js";
import { runChild } from "./runner.js";
import type { AttemptRow, Outcome } from "./types.js";

const PATCH_DIR = path.join(LEDGER_DIR, "patches");

const parameters = Type.Object({
	task: Type.String({ description: "What the child should do. Be concrete and bounded." }),
	gate: Type.String({
		description: "Deterministic shell command that proves the task is done, e.g. `node --test` or `cargo test`.",
	}),
	tier0: Type.Optional(Type.String({ description: `Cheap model, default ${DEFAULT_TIER0}` })),
	tier1: Type.Optional(Type.String({ description: `Frontier model, default ${DEFAULT_TIER1}` })),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-attempt deadline in ms. Default 480000 (8 min)." })),
	expect: Type.Optional(
		Type.String({
			description:
				'Whether the gate is expected to be green at HEAD. "green" (default) for changes that must not break anything, "red" when the task is to make a currently failing gate pass.',
		}),
	),
	profile: Type.Optional(
		Type.String({
			description: 'Spend pool: "dev" (credit-funded fixtures), "prod" (default, paid), "max" (opt-in strongest). Recorded on every ledger row; dev rows never enter dollar stats.',
		}),
	),
	maxCostUsd: Type.Optional(
		Type.Number({
			description: "Dollar ceiling for this repo over the trailing 24h UTC. Default: env PI_CASCADE_MAX_COST_USD, else 1.00. Refuses dispatch when already exceeded.",
		}),
	),
});

type Params = {
	task: string;
	gate: string;
	tier0?: string;
	tier1?: string;
	timeoutMs?: number;
	expect?: string;
	profile?: string;
	maxCostUsd?: number;
};

function writePatch(taskId: string, tier: string, patch: string): string | null {
	if (!patch.trim()) return null;
	fs.mkdirSync(PATCH_DIR, { recursive: true, mode: 0o700 });
	const file = path.join(PATCH_DIR, `${taskId}-${tier}.patch`);
	fs.writeFileSync(file, patch, "utf8");
	return file;
}

export default function subagentCascade(pi: ExtensionAPI) {
	pi.registerTool({
		name: "routed_subagent",
		label: "Routed Subagent",
		description:
			"Run a delegated coding task through a cheap-to-frontier model cascade, verified by a deterministic gate. Tries the cheap tier, one repair on the same tier, then the frontier tier. Each attempt runs in an isolated git worktree; the successful change is returned as a patch. Use when the task has a runnable verification command. Do not use for read-only exploration or tasks without a gate.",
		parameters,
		annotations: { destructiveHint: true },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input = params as Params;
			const repoInput = ctx.cwd ?? process.cwd();
			const timeoutMs = input.timeoutMs ?? 8 * 60 * 1000;
			const expect = (input.expect ?? "green").toLowerCase();
			if (expect !== "green" && expect !== "red") {
				throw new Error(`expect must be "green" or "red", got "${input.expect}"`);
			}

			if (!isDeterministicGate(input.gate)) {
				throw new Error(
					`refusing gate \`${input.gate}\`: it looks non-deterministic (watch/serve/network). A cascade needs a gate that fails deterministically.`,
				);
			}

			const pre = await preflight(repoInput);
			if (!pre.ok || !pre.repo) throw new Error(`preflight failed: ${pre.reason}`);
			const repo = pre.repo;
			const config = readConfig();
			const profile = resolveProfile(input.profile, typeof config?.profile === "string" ? config.profile : undefined);

			// Cost ceiling for unattended runs: refuse before spending anything,
			// on the observed 24h UTC total for this repo. Never write a row.
			const ceiling = resolveCostCeiling(input.maxCostUsd, process.env.PI_CASCADE_MAX_COST_USD);
			const spent24h = spendInWindow(readRows(), repo, Date.now());
			if (spent24h >= ceiling) {
				throw new Error(
					`refusing to dispatch: $${spent24h.toFixed(5)} spent on ${repo} in the last 24h, ceiling $${ceiling} (maxCostUsd / PI_CASCADE_MAX_COST_USD). Nothing was spent and no row was written.`,
				);
			}
			const taskId = newTaskId();
			const sig = signature(input.task, repo);
			// param > env > probed config > compiled default (SKILL §6 resolution order).
			const tier0Model = resolveTier(input.tier0, process.env.PI_CASCADE_TIER0, typeof config?.tier0 === "string" ? config.tier0 : undefined, DEFAULT_TIER0);
			const tier1Model = resolveTier(input.tier1, process.env.PI_CASCADE_TIER1, typeof config?.tier1 === "string" ? config.tier1 : undefined, DEFAULT_TIER1);
			const tiers = planAttempts(tier0Model, tier1Model);

			// Single-flight: one cascade at a time per machine, so two runs
			// cannot fight over the same repo or the same probe budget.
			const lock = acquireLock(taskId);
			if (!lock.ok) {
				throw new Error(
					`another cascade holds the run lock: pid ${lock.holder?.pid}, task ${lock.holder?.taskId}, started ${lock.holder?.startedAt}. This call spent nothing; retry after it finishes or remove ${lock.path}.`,
				);
			}
			try {

			// A tier that cannot hold a repo-sized context (or has no catalog entry)
			// is a configuration error, not a model failure. Fail before spending.
			const tierInfo = tiers.map((tier) => {
				const [provider, rest] = tier.model.split("/");
				const id = (rest ?? "").split(":")[0];
				const model = provider && id ? (ctx.modelRegistry?.find?.(provider, id) as any) : undefined;
				if (!model) {
					throw new Error(`tier ${tier.id}: model "${tier.model}" is not in the catalog. Run the probe or pass a valid provider/id.`);
				}
				const contextWindow = Number(model.contextWindow ?? 0);
				if (contextWindow > 0 && contextWindow < 64_000) {
					throw new Error(
						`tier ${tier.id}: model "${tier.model}" has a ${contextWindow} token context window; below the 64000 minimum for repo work.`,
					);
				}
				return {
					tier: tier.id,
					model: tier.model,
					contextWindow,
					maxTokens: Number(model.maxTokens ?? 0),
					// Pi defaults unknown pricing to 0, so a zero input rate is
					// "unpriced", not "free". Never let it read as a real cost.
					priced: Number(model.cost?.input ?? 0) > 0,
				};
			});
			const windows = tierInfo.map((t) => `${t.tier} ${t.contextWindow || "?"}ctx/${t.maxTokens || "?"}out`).join(", ");

			onUpdate?.({
				content: [{ type: "text", text: `baseline gate at HEAD…` }],
				details: { phase: "baseline" },
			});

			const base = await addWorktree(repo, `${taskId}-base`);
			if (!base.ok) throw new Error(`cannot create worktree: ${base.error}`);
			linkDependencyDirs(repo, base.path);
			const baseGate = await runShell(input.gate, base.path, timeoutMs, { PI_CASCADE_GATE: "1" });
			await removeWorktree(repo, base.path);
			const baselineGreen = baseGate.exitCode === 0;

			// A red gate is the target for fix-the-failing-test work, so the guard
			// must be opt-in per task, not blanket.
			if (expect === "red" && baselineGreen) {
				return {
					content: [
						{
							type: "text",
							text: `Nothing to fix: the gate \`${input.gate}\` already passes at HEAD. No model was dispatched and nothing was spent.`,
						},
					],
					details: { outcome: "PASS", taskId, baselineGreen, alreadyGreen: true },
				};
			}

			if (expect === "green" && !baselineGreen) {
				const row: AttemptRow = {
					ts: new Date().toISOString(),
					taskId,
					repo,
					sig,
					tier: "baseline",
					attempt: 0,
					model: "-",
					outcome: "PREEXISTING",
					gate: input.gate,
					gateExit: baseGate.exitCode,
					baselineGreen: false,
					durationMs: 0,
					costUsd: 0,
					costKnown: true,
					profile,
					tokens: { input: 0, output: 0, cacheRead: 0 },
					errTail: errTail(baseGate.output, 200),
				};
				appendRow(row);
				return {
					content: [
						{
							type: "text",
							text: `Refusing to route: the gate \`${input.gate}\` already fails at HEAD.\n\n${errTail(baseGate.output, 800)}\n\nFix or commit the baseline first — a red baseline cannot be attributed to a model.`,
						},
					],
					details: { outcome: "PREEXISTING", taskId, baseline: errTail(baseGate.output, 400) },
				};
			}

			const rows: AttemptRow[] = [];
			let patchFile: string | null = null;

			const steps = await runLadder(tiers, async (tier, i, previous) => {
				const attemptNo = i + 1;
				onUpdate?.({
					content: [{ type: "text", text: `attempt ${attemptNo}/${tiers.length} on ${tier.id} (${tier.model})…` }],
					details: { phase: "attempt", attempt: attemptNo, tier: tier.id },
				});

				const started = Date.now();
				const priced = tierInfo.find((t) => t.tier === tier.id)?.priced ?? true;
				const wt = await addWorktree(repo, `${taskId}-${tier.id}`);
				if (!wt.ok) throw new Error(`cannot create worktree for ${tier.id}: ${wt.error}`);
				linkDependencyDirs(repo, wt.path);

				const taskText = attemptTask(input.task, input.gate, previous, tier.id);
				const child = await runChild({ cwd: wt.path, model: tier.model, task: taskText, timeoutMs, signal });

				let outcome: Outcome;
				let gateOutput = "";
				let gateExit: number | null = null;

				const signalOutcome = classifyChildSignal({
					timedOut: child.timedOut,
					spawnError: child.spawnError,
					stopReason: child.stopReason,
					compactions: child.compactions,
				});

				if (signalOutcome) {
					outcome = signalOutcome;
					gateOutput = `${child.stderrTail}\n${child.text}`.slice(-2000);
				} else if (/Model\b.*(not found|deprecated)|ModelDeprecated|not found for provider/i.test(child.stderrTail)) {
					outcome = "ERROR";
					gateOutput = `tier ${tier.id} model "${tier.model}" is not usable:\n${child.stderrTail}`;
				} else {
					const gate = await runShell(input.gate, wt.path, timeoutMs, { PI_CASCADE_GATE: "1" });
					gateExit = gate.exitCode;
					gateOutput = `${gate.output}\n${child.transcriptTail}`.slice(-8000);
					// For expect:"red" a red baseline is the goal, so classify normally.
					outcome = classifyGate({
						gateExit,
						gateOutput,
						baselineGreen: expect === "red" ? true : baselineGreen,
					});
				}

				if (outcome === "PASS") {
					patchFile = writePatch(taskId, tier.id, await capturePatch(wt.path));
				}
				await removeWorktree(repo, wt.path);

				const row: AttemptRow = {
					ts: new Date().toISOString(),
					taskId,
					repo,
					sig,
					tier: tier.id,
					attempt: attemptNo,
					model: tier.model,
					outcome,
					gate: input.gate,
					gateExit,
					errCode: extractErrCode(gateOutput),
					errTail: outcome === "PASS" ? undefined : errTail(gateOutput, 300),
					baselineGreen,
					durationMs: Date.now() - started,
					costUsd: priced ? child.costUsd : 0,
					costKnown: priced,
					profile,
					tokens: child.tokens,
					patchFile,
					escalatedTo: outcome === "CAPABILITY_FAIL" ? (tiers[i + 1]?.id ?? null) : null,
				};
				appendRow(row);
				rows.push(row);
				return { outcome, output: gateOutput };
			});

			// Same feedback the old inline loop carried: the output of the last
			// rung that failed with a capability problem, for the summary tail.
			const fedBack = steps.filter((s) => s.outcome === "CAPABILITY_FAIL").pop();
			const totalCost = rows.reduce((sum, r) => sum + r.costUsd, 0);
			const last = rows[rows.length - 1];
			const succeeded = last?.outcome === "PASS";
			const lines = rows.map(
				(r) =>
					`  ${r.tier.padEnd(10)} ${r.outcome.padEnd(16)} $${r.costUsd.toFixed(5)}  ${r.errCode ?? ""}`,
			);

			// Optional in-place apply: only when the user's tree is still clean.
			let applied: { applied: boolean; reason?: string } | null = null;
			if (succeeded && input.apply && patchFile) applied = await applyPatch(repo, patchFile);

			const applyLine = applied
				? [`Applied in place: ${applied.applied ? `yes (${repo})` : `no — ${applied.reason}`}`]
				: [];

			const body = succeeded
				? [
						`Task ${taskId} passed the gate on ${last.tier} after ${rows.length} attempt(s); total $${totalCost.toFixed(5)}.`,
						`Tiers: t0=${tier0Model} t1=${tier1Model} (profile ${profile}).`,
						"",
						...lines,
						"",
						patchFile ? `Patch: ${patchFile}\nApply with: git apply ${patchFile}` : "No file changes were produced.",
						...applyLine,
					]
				: [
						`Task ${taskId} did not pass the gate after ${rows.length} attempt(s); total $${totalCost.toFixed(5)}.`,
						`Tiers: t0=${tier0Model} t1=${tier1Model} (profile ${profile}).`,
						"",
						...lines,
						"",
						`Last gate output (tail):\n${errTail(fedBack?.output ?? "", 800)}`,
					];

			return {
				content: [{ type: "text", text: body.join("\n") }],
				details: {
					taskId,
					outcome: last?.outcome ?? "ERROR",
					attempts: rows.map((r) => ({
						tier: r.tier,
						model: r.model,
						outcome: r.outcome,
						costUsd: r.costUsd,
						gateExit: r.gateExit,
						errCode: r.errCode,
					})),
					totalCostUsd: totalCost,
					patchFile,
					applied: applied?.applied ?? null,
					applyNote: applied?.reason,
					baselineGreen,
					profile,
					tiers: tierInfo,
					windows,
				},
			};
		} finally {
			releaseLock();
		}
		},
	});

	pi.registerCommand("router-stats", {
		description: "Show cascade ledger stats. Use `router-stats reset` to clear.",
		handler: async (args, ctx) => {
			// notify() only renders in the TUI; print for scripted runs so the
			// command is verifiable from `pi -p` and CI.
			const emit = (text: string) => {
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				else process.stderr.write(`${text}\n`);
			};
			if (args.trim() === "reset") {
				resetLedger();
				emit("Cascade ledger cleared.");
				return;
			}
			const rows = readRows();
			if (rows.length === 0) {
				emit("No cascade runs recorded yet.");
				return;
			}
			emit(formatStats(aggregate(rows)));
		},
	});
}
