/**
 * Pure policy: the ladder and the reporting math. No I/O, fully unit-tested.
 *
 * Ladder rationale (SKILL.md §5.1): repair on the same cheap tier before
 * escalating. Most gate failures are fixable by the same model once it sees the
 * error, and an escalation costs 8x more than a repair attempt.
 */
import type { AttemptRow, Outcome, Tier } from "./types.js";

export const DEFAULT_TIER0 = "opencode-go/deepseek-v4.1-flash";
// kimi-k3 ($3/$15 per 1M) is 20x T0 and only 5% more context; the pro tier of the
// same family escalates capability at ~4x T0 instead. kimi stays opt-in.
export const DEFAULT_TIER1 = "opencode-go/deepseek-v4-pro";

/** T0 once, T0 once more with the error, then T1. Never more than three attempts. */
export function planAttempts(tier0 = DEFAULT_TIER0, tier1 = DEFAULT_TIER1): Tier[] {
	return [
		{ id: "t0", model: tier0 },
		{ id: "t0-repair", model: tier0 },
		{ id: "t1", model: tier1 },
	];
}

/** Only a capability failure earns another attempt. ENV/PREEXISTING/TIMEOUT stop. */
export function shouldContinue(outcome: Outcome): boolean {
	return outcome === "CAPABILITY_FAIL";
}

export interface LadderAttemptResult {
	outcome: Outcome;
	/** Gate/child output to hand to the next rung as feedback. */
	output: string;
}

export interface LadderStep extends LadderAttemptResult {
	tier: Tier;
}

export type LadderAttempt = (
	tier: Tier,
	index: number,
	previous: { outcome: Outcome; output: string } | null,
) => Promise<LadderAttemptResult>;

/**
 * Sequencing of the ladder, free of I/O: run each rung through the injected
 * `attempt`, stop on PASS, stop on any outcome that is not CAPABILITY_FAIL,
 * and pass {outcome, output} forward as the next rung's feedback.
 */
export async function runLadder(plan: Tier[], attempt: LadderAttempt): Promise<LadderStep[]> {
	const steps: LadderStep[] = [];
	let previous: { outcome: Outcome; output: string } | null = null;
	for (let i = 0; i < plan.length; i++) {
		const tier = plan[i];
		const result = await attempt(tier, i, previous);
		steps.push({ tier, ...result });
		if (result.outcome === "PASS" || !shouldContinue(result.outcome)) break;
		previous = { outcome: result.outcome, output: result.output };
	}
	return steps;
}

export function escalationTarget(attempts: Tier[], index: number): string | null {
	return attempts[index + 1]?.id ?? null;
}

export function errTail(text: string, max = 1200): string {
	const t = text.trim();
	return t.length <= max ? t : `…${t.slice(t.length - max)}`;
}

/** Task text for attempt N: base task first, then the distilled gate error. */
export function attemptTask(originalTask: string, gate: string, previous: { outcome: Outcome; output: string } | null, tierId: string): string {
	if (!previous) return originalTask;
	const why = previous.outcome === "TIMEOUT" ? "the previous attempt timed out" : `the gate \`${gate}\` failed`;
	const label =
		tierId === "t0-repair"
			? `A previous attempt at this task (same model) failed: ${why}.`
			: `A cheaper model already failed this task: ${why}.`;
	return [
		label,
		"Fix it cleanly from the current base state. Do not weaken, skip, or delete tests.",
		"",
		"Gate output (tail):",
		"```",
		errTail(previous.output),
		"```",
		"",
		`Original task: ${originalTask}`,
	].join("\n");
}

export interface Aggregated {
	tasks: number;
	/** Tasks that actually reached a model (excludes PREEXISTING-only tasks). */
	routed: number;
	green: number;
	t0FirstPass: number;
	repairs: number;
	escalations: number;
	preexisting: number;
	totalCostUsd: number;
	costPerGreenUsd: number;
	unknownCost: number;
	byTier: Record<string, { attempts: number; passes: number; costUsd: number }>;
}

/**
 * One task = one `taskId`. Cost per green task sums every attempt spent on it,
 * which is the only number the cascade claim can be built on.
 */
export function aggregate(rows: AttemptRow[]): Aggregated {
	const byTask = new Map<string, AttemptRow[]>();
	for (const r of rows) {
		const list = byTask.get(r.taskId) ?? [];
		list.push(r);
		byTask.set(r.taskId, list);
	}

	const out: Aggregated = {
		tasks: byTask.size,
		routed: 0,
		green: 0,
		t0FirstPass: 0,
		repairs: 0,
		escalations: 0,
		preexisting: 0,
		totalCostUsd: 0,
		costPerGreenUsd: 0,
		unknownCost: 0,
		byTier: {},
	};

	for (const r of rows) {
		out.totalCostUsd += r.costUsd;
		if (r.costKnown === false) out.unknownCost++;
		const t = (out.byTier[r.tier] ??= { attempts: 0, passes: 0, costUsd: 0 });
		t.attempts++;
		t.costUsd += r.costUsd;
		if (r.outcome === "PASS") t.passes++;
	}

	for (const attempts of byTask.values()) {
		const sorted = [...attempts].sort((a, b) => a.attempt - b.attempt);
		const first = sorted[0];
		const last = sorted[sorted.length - 1];
		if (last?.outcome === "PASS") out.green++;
		if (first?.outcome === "PASS" && first.tier === "t0") out.t0FirstPass++;
		if (sorted.some((a) => a.tier === "t0-repair")) out.repairs++;
		if (sorted.some((a) => a.tier === "t1")) out.escalations++;
		if (first?.outcome === "PREEXISTING") out.preexisting++;
		if (sorted.some((a) => a.tier !== "baseline")) out.routed++;
	}

	out.costPerGreenUsd = out.green > 0 ? out.totalCostUsd / out.green : 0;
	return out;
}

function pct(n: number, d: number): string {
	return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

export function formatStats(a: Aggregated): string {
	const tiers = Object.keys(a.byTier)
		.sort()
		.map((k) => `${k}: ${a.byTier[k].attempts} attempts, ${pct(a.byTier[k].passes, a.byTier[k].attempts)} pass, $${a.byTier[k].costUsd.toFixed(5)}`);
	return [
		`tasks            ${a.tasks} (${a.routed} routed)`,
		`green            ${a.green}`,
		`T0 first-pass    ${pct(a.t0FirstPass, a.routed)}`,
		`repaired at T0   ${a.repairs}`,
		`escalated to T1  ${a.escalations}`,
		`gate red at HEAD ${a.preexisting}`,
		`total spend      $${a.totalCostUsd.toFixed(5)}`,
		`$ / green task   $${a.costPerGreenUsd.toFixed(5)}`,
		...(a.unknownCost > 0 ? [`cost unknown     ${a.unknownCost} attempt(s) — provider publishes no pricing; those rows count as $0`] : []),
		"",
		...tiers,
		"",
		"caveat: these are observed runs, not a controlled benchmark.",
	].join("\n");
}
