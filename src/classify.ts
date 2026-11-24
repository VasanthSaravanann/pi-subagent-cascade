/**
 * Deterministic outcome classification.
 *
 * Keys off the gate's exit code first and a bounded output tail second.
 * Deliberately small: ~100 lines, no WASM, no LLM. Seed signals from the
 * original proposal are kept only as secondary regexes.
 */
import type { Outcome } from "./types.js";

/** Environment problems: do not escalate the model, the machine is at fault. */
const ENV_PATTERNS: RegExp[] = [
	/\bENOTFOUND\b/,
	/\bECONNREFUSED\b/,
	/\bECONNRESET\b/,
	/\bEADDRINUSE\b/,
	/\bETIMEDOUT\b/,
	/\b429\b|rate.?limit/i,
	/could not resolve host/i,
	/network is unreachable/i,
	/command not found/i,
	/No such file or directory: '?(cargo|node|npm|pnpm|yarn|python3?|pytest|go|rustc)'/i,
	/lock ?file .*(exists|held)/i,
];

/** Capability failures worth an escalated retry. Secondary to the exit code. */
const CODE_PATTERNS: RegExp[] = [
	/\bE\d{4}\b/, // rustc
	/\bTS\d{4}\b/, // tsc
	/ERR_ASSERTION/,
	/AssertionError/,
	/TypeError/,
	/SyntaxError/,
	/error\[E\d+\]/,
];

export function isEnvironmentFailure(output: string): boolean {
	return ENV_PATTERNS.some((re) => re.test(output));
}

/** Most specific error identifier found in the tail, e.g. `E0597`, `TS2322`. */
export function extractErrCode(output: string): string | undefined {
	const m = output.match(/\b(E\d{4}|TS\d{4}|ERR_[A-Z_]+)\b/);
	return m?.[1];
}

export interface ClassifyInput {
	gateExit: number | null;
	gateOutput: string;
	baselineGreen: boolean;
}

/**
 * PASS            gate exited 0
 * PREEXISTING     the gate was already red at HEAD — never attribute to the model
 * ENV_FAIL        machine/infrastructure, retrying on a stronger model is waste
 * CAPABILITY_FAIL everything else: worth one repair, then escalation
 */
export function classifyGate(input: ClassifyInput): Outcome {
	if (!input.baselineGreen) return "PREEXISTING";
	if (input.gateExit === 0) return "PASS";
	if (input.gateExit === null) return "ERROR";
	if (isEnvironmentFailure(input.gateOutput)) return "ENV_FAIL";
	return "CAPABILITY_FAIL";
}

/** Does this output look like a model mistake rather than a broken environment? */
export function looksLikeCapabilityFailure(output: string): boolean {
	if (isEnvironmentFailure(output)) return false;
	return CODE_PATTERNS.some((re) => re.test(output));
}
