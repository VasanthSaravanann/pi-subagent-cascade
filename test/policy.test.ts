import { describe, expect, it } from "vitest";
import { aggregate, attemptTask, errTail, formatStats, planAttempts, shouldContinue } from "../src/policy.js";
import type { AttemptRow } from "../src/types.js";

const row = (over: Partial<AttemptRow>): AttemptRow => ({
	ts: "2026-01-01T00:00:00.000Z",
	taskId: "t",
	repo: "/repo",
	sig: "repo:ts:fix",
	tier: "t0",
	attempt: 1,
	model: "m",
	outcome: "PASS",
	gate: "node --test",
	gateExit: 0,
	baselineGreen: true,
	durationMs: 1,
	costUsd: 0.01,
	costKnown: true,
	tokens: { input: 1, output: 1, cacheRead: 0 },
	...over,
});

describe("ladder", () => {
	it("is T0, T0-repair, T1", () => {
		const tiers = planAttempts("a/b", "c/d");
		expect(tiers.map((t) => t.id)).toEqual(["t0", "t0-repair", "t1"]);
		expect(tiers.map((t) => t.model)).toEqual(["a/b", "a/b", "c/d"]);
	});

	it("continues only on capability failures", () => {
		expect(shouldContinue("CAPABILITY_FAIL")).toBe(true);
		for (const o of ["PASS", "ENV_FAIL", "PREEXISTING", "TIMEOUT", "ERROR"] as const) {
			expect(shouldContinue(o)).toBe(false);
		}
	});
});

describe("attemptTask", () => {
	it("passes the original task on the first attempt", () => {
		expect(attemptTask("fix it", "npm test", null, "t0")).toBe("fix it");
	});

	it("distils the gate error for the repair attempt", () => {
		const text = attemptTask("fix it", "npm test", { outcome: "CAPABILITY_FAIL", output: "AssertionError: 2 == 3" }, "t0-repair");
		expect(text).toContain("same model");
		expect(text).toContain("AssertionError");
		expect(text).toContain("Do not weaken");
		expect(text).toContain("fix it");
	});

	it("labels an escalation differently from a repair", () => {
		const text = attemptTask("fix it", "npm test", { outcome: "CAPABILITY_FAIL", output: "x" }, "t1");
		expect(text).toContain("cheaper model already failed");
	});

	it("reports a timeout as such", () => {
		expect(attemptTask("t", "g", { outcome: "TIMEOUT", output: "" }, "t1")).toContain("timed out");
	});

	it("bounds the error tail", () => {
		expect(errTail("a".repeat(2000), 100).length).toBeLessThanOrEqual(101);
	});
});

describe("aggregate", () => {
	const rows: AttemptRow[] = [
		row({ taskId: "a", tier: "t0", attempt: 1, costUsd: 0.01 }),
		row({ taskId: "b", tier: "t0", attempt: 1, outcome: "CAPABILITY_FAIL", costUsd: 0.02 }),
		row({ taskId: "b", tier: "t0-repair", attempt: 2, costUsd: 0.02 }),
		row({ taskId: "c", tier: "t0", attempt: 1, outcome: "CAPABILITY_FAIL", costUsd: 0.01 }),
		row({ taskId: "c", tier: "t0-repair", attempt: 2, outcome: "CAPABILITY_FAIL", costUsd: 0.01 }),
		row({ taskId: "c", tier: "t1", attempt: 3, costUsd: 0.05 }),
	];

	it("counts tasks, first-pass, repairs and escalations", () => {
		const a = aggregate(rows);
		expect(a.tasks).toBe(3);
		expect(a.routed).toBe(3);
		expect(a.green).toBe(3);
		expect(a.t0FirstPass).toBe(1);
		expect(a.repairs).toBe(2);
		expect(a.escalations).toBe(1);
	});

	it("charges every attempt to the task, not the winner only", () => {
		const a = aggregate(rows);
		expect(a.totalCostUsd).toBeCloseTo(0.12, 6);
		expect(a.costPerGreenUsd).toBeCloseTo(0.04, 6);
	});

	it("counts a task as green only when the last attempt passed", () => {
		const a = aggregate([row({ taskId: "x", outcome: "CAPABILITY_FAIL" })]);
		expect(a.green).toBe(0);
		expect(a.costPerGreenUsd).toBe(0);
	});

	it("separates preexisting from capability", () => {
		const a = aggregate([row({ taskId: "p", tier: "baseline", attempt: 0, outcome: "PREEXISTING", costUsd: 0 })]);
		expect(a.preexisting).toBe(1);
		expect(a.routed).toBe(0);
		expect(a.t0FirstPass).toBe(0);
	});

	it("renders a caveat with the stats", () => {
		expect(formatStats(aggregate(rows))).toContain("caveat");
	});
});

describe("unknown provider pricing", () => {
	it("counts unpriced attempts instead of reporting them as free", () => {
		const a = aggregate([
			row({ taskId: "a", costUsd: 0, costKnown: false }),
			row({ taskId: "b", costUsd: 0.01, costKnown: true }),
		]);
		expect(a.unknownCost).toBe(1);
		expect(formatStats(a)).toContain("cost unknown");
	});

	it("stays quiet when every attempt is priced", () => {
		expect(formatStats(aggregate([row({ taskId: "a" })])).includes("cost unknown")).toBe(false);
	});
});
