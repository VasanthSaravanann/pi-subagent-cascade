import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, newTaskId, readRows, releaseLock, signature } from "../src/ledger.js";

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

describe("acquireLock / releaseLock", () => {
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cascade-lock-"));

	it("grants the first holder and refuses the second with its info", () => {
		const dir = tmp();
		const first = acquireLock("task-1", { dir });
		expect(first.ok).toBe(true);
		const second = acquireLock("task-2", { dir });
		expect(second.ok).toBe(false);
		expect(second.holder?.taskId).toBe("task-1");
		expect(second.holder?.pid).toBe(process.pid);
		expect(second.holder?.startedAt).toMatch(/Z$/);
	});

	it("reclaims a lock whose pid is dead", () => {
		const dir = tmp();
		fs.writeFileSync(
			path.join(dir, "lock"),
			JSON.stringify({ pid: 99998, taskId: "ghost", startedAt: new Date().toISOString() }),
		);
		const got = acquireLock("task-3", { dir });
		expect(got.ok).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(dir, "lock"), "utf8")).taskId).toBe("task-3");
	});

	it("reclaims a torn lock file", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "lock"), "{pi");
		expect(acquireLock("task-4", { dir }).ok).toBe(true);
	});

	it("releases so the next run gets in", () => {
		const dir = tmp();
		acquireLock("task-5", { dir });
		releaseLock({ dir });
		expect(acquireLock("task-6", { dir }).ok).toBe(true);
	});
});
