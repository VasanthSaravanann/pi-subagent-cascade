import { describe, expect, it } from "vitest";
import {
	classifyChildSignal,
	classifyGate,
	extractErrCode,
	isEnvironmentFailure,
	looksLikeCapabilityFailure,
} from "../src/classify.js";
import { shouldContinue } from "../src/policy.js";

describe("classifyGate", () => {
	it("passes on a zero exit", () => {
		expect(classifyGate({ gateExit: 0, gateOutput: "", baselineGreen: true })).toBe("PASS");
	});

	it("never attributes a red baseline to the model", () => {
		expect(classifyGate({ gateExit: 0, gateOutput: "", baselineGreen: false })).toBe("PREEXISTING");
		expect(classifyGate({ gateExit: 1, gateOutput: "boom", baselineGreen: false })).toBe("PREEXISTING");
	});

	it("calls a compile/assert failure a capability failure", () => {
		expect(classifyGate({ gateExit: 1, gateOutput: "error[E0597]: borrowed value", baselineGreen: true })).toBe(
			"CAPABILITY_FAIL",
		);
		expect(classifyGate({ gateExit: 1, gateOutput: "AssertionError: 2 == 3", baselineGreen: true })).toBe(
			"CAPABILITY_FAIL",
		);
	});

	it("does not escalate on infrastructure", () => {
		expect(classifyGate({ gateExit: 1, gateOutput: "getaddrinfo ENOTFOUND registry", baselineGreen: true })).toBe(
			"ENV_FAIL",
		);
		expect(classifyGate({ gateExit: 127, gateOutput: "sh: cargo: command not found", baselineGreen: true })).toBe(
			"ENV_FAIL",
		);
		expect(classifyGate({ gateExit: 1, gateOutput: "429 rate limit", baselineGreen: true })).toBe("ENV_FAIL");
	});

	it("treats a missing exit code as an error, not a retry", () => {
		expect(classifyGate({ gateExit: null, gateOutput: "", baselineGreen: true })).toBe("ERROR");
	});
});

describe("errCode extraction", () => {
	it("pulls rustc and tsc codes", () => {
		expect(extractErrCode("error[E0597]: x")).toBe("E0597");
		expect(extractErrCode("src/a.ts(3,1): error TS2322: Type 'x'")).toBe("TS2322");
		expect(extractErrCode("code: 'ERR_ASSERTION'")).toBe("ERR_ASSERTION");
	});

	it("returns undefined when there is no code", () => {
		expect(extractErrCode("something went wrong")).toBeUndefined();
	});
});

describe("signal helpers", () => {
	it("detects environment failures", () => {
		expect(isEnvironmentFailure("ECONNREFUSED 127.0.0.1:5432")).toBe(true);
		expect(isEnvironmentFailure("error[E0308]: mismatched types")).toBe(false);
	});

	it("requires a real code pattern for capability", () => {
		expect(looksLikeCapabilityFailure("error[E0308]: mismatched types")).toBe(true);
		expect(looksLikeCapabilityFailure("ENOTFOUND")).toBe(false);
		expect(looksLikeCapabilityFailure("tests failed")).toBe(false);
	});
});

describe("child signal classification", () => {
	const base = { timedOut: false, compactions: 0 };

	it("treats length as a context failure, not a capability failure", () => {
		expect(classifyChildSignal({ ...base, stopReason: "length" })).toBe("CONTEXT_FAIL");
	});

	it("does not retry a timeout or a spawn error", () => {
		expect(classifyChildSignal({ ...base, timedOut: true })).toBe("TIMEOUT");
		expect(classifyChildSignal({ ...base, spawnError: "ENOENT pi" })).toBe("ERROR");
	});

	it("defers to the gate when the child finished normally", () => {
		expect(classifyChildSignal({ ...base, stopReason: "stop", compactions: 2 })).toBeNull();
	});
});

describe("context budget", () => {
	it("keeps escalation out of the context-failure path", () => {
		// T1 does not buy a meaningfully larger window than T0, so only
		// CAPABILITY_FAIL may continue the ladder.
		expect(shouldContinue("CONTEXT_FAIL")).toBe(false);
	});
});
