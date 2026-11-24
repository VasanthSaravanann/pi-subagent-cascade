/**
 * Shared types.
 *
 * Architecture note (verified 25 Nov, pi 1.6.0): a custom tool cannot call
 * `subagent` (ctx.tools = read, bash, edit, write, subagent_launch, bg_wait),
 * and `pi` has no `--cwd` flag — cwd is set on the spawned process. So this
 * extension runs each attempt as `pi --mode json -p --no-session --model <tier>`
 * inside its own `git worktree`, then runs the gate itself on the host.
 */

export type Outcome =
	| "PASS"
	| "CAPABILITY_FAIL"
	| "ENV_FAIL"
	| "PREEXISTING"
	| "TIMEOUT"
	| "ERROR";

export interface Tier {
	id: string;
	model: string;
}

/** One line in ~/.pi/agent/cascade/ledger.jsonl. Never contains source or raw stderr. */
export interface AttemptRow {
	ts: string;
	taskId: string;
	repo: string;
	sig: string;
	tier: string;
	attempt: number;
	model: string;
	outcome: Outcome;
	gate: string;
	gateExit: number | null;
	errCode?: string;
	errTail?: string;
	baselineGreen: boolean;
	durationMs: number;
	costUsd: number;
	tokens: { input: number; output: number; cacheRead: number };
	patchFile?: string | null;
	escalatedTo?: string | null;
}

export interface ChildResult {
	exitCode: number | null;
	timedOut: boolean;
	turns: number;
	costUsd: number;
	tokens: { input: number; output: number; cacheRead: number };
	text: string;
	transcriptTail: string;
	stderrTail: string;
	spawnError?: string;
}

export interface GateResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}
