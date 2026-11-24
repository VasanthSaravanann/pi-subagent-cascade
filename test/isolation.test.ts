import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINKED_DIRS, linkDependencyDirs } from "../src/isolation.js";

const dirs = () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-link-"));
	const repo = path.join(base, "repo");
	const wt = path.join(base, "wt");
	fs.mkdirSync(repo);
	fs.mkdirSync(wt);
	return { repo, wt };
};

describe("linkDependencyDirs", () => {
	it("links every known dep dir that exists in the repo and is absent in the worktree", () => {
		const { repo, wt } = dirs();
		for (const name of LINKED_DIRS) {
			fs.mkdirSync(path.join(repo, name));
			fs.writeFileSync(path.join(repo, name, "marker"), "x");
		}
		const linked = linkDependencyDirs(repo, wt);
		expect(linked.sort()).toEqual([...LINKED_DIRS].sort());
		for (const name of LINKED_DIRS) {
			expect(fs.existsSync(path.join(wt, name, "marker"))).toBe(true);
			expect(fs.lstatSync(path.join(wt, name)).isSymbolicLink()).toBe(true);
		}
	});

	it("never overwrites something already present in the worktree", () => {
		const { repo, wt } = dirs();
		fs.mkdirSync(path.join(repo, "node_modules"));
		fs.mkdirSync(path.join(wt, "node_modules"));
		fs.writeFileSync(path.join(wt, "node_modules", "own"), "x");
		expect(linkDependencyDirs(repo, wt)).toEqual([]);
		expect(fs.existsSync(path.join(wt, "node_modules", "own"))).toBe(true);
	});

	it("skips dirs the repo does not have, and plain gitignored files stay out", () => {
		const { repo, wt } = dirs();
		fs.mkdirSync(path.join(repo, ".venv"));
		fs.writeFileSync(path.join(repo, ".env"), "SECRET=1");
		const linked = linkDependencyDirs(repo, wt);
		expect(linked).toEqual([".venv"]);
		expect(fs.existsSync(path.join(wt, ".env"))).toBe(false);
	});
});
