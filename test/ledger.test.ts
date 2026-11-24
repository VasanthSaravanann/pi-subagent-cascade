import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newTaskId, readRows, signature } from "../src/ledger.js";

describe("readRows", () => {
	it("skips torn lines instead of losing the ledger", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ledger-")), "l.jsonl");
		fs.writeFileSync(
			file,
			[
				JSON.stringify({ taskId: "a", tier: "t0", attempt: 1, outcome: "PASS", costUsd: 0.01 }),
				'{"taskId":"b","tier":"t0"',
				"",
				JSON.stringify({ taskId: "c", tier: "t1", attempt: 1, outcome: "PASS", costUsd: 0.02 }),
			].join("\n"),
		);
		expect(readRows(file).map((r) => r.taskId)).toEqual(["a", "c"]);
	});

	it("returns empty for a missing file", () => {
		expect(readRows(path.join(os.tmpdir(), "definitely-not-here.jsonl"))).toEqual([]);
	});
});

describe("ids and signatures", () => {
	it("makes unique task ids", () => {
		expect(newTaskId(1000, () => 0.5)).toMatch(/^rs-[0-9a-f]{4}$/);
		expect(newTaskId()).not.toBe(newTaskId());
	});

	it("groups by language and verb, not by repo path noise", () => {
		expect(signature("fix the failing rust test", "/src/api")).toBe("api:rust:fix");
		expect(signature("refactor this TS module", "/work/web")).toBe("web:ts:refactor");
		expect(signature("do something vague", "/x/y")).toBe("y:any:task");
	});
});
