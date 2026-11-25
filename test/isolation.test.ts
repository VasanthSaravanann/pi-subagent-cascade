import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINKED_DIRS, addWorktree, applyPatch, capturePatch, git, linkDependencyDirs, removeWorktree, runShell } from "../src/isolation.js";

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

describe("applyPatch", () => {
	const repoWithPatch = async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-apply-"));
		const repo = path.join(base, "repo");
		fs.mkdirSync(repo);
		await git(repo, ["init", "-q", "."]);
		await git(repo, ["config", "user.email", "t@t"]);
		await git(repo, ["config", "user.name", "t"]);
		fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-qm", "base"]);
		// Change only inside the worktree: the source tree must stay clean.
		const add = await addWorktree(repo, `apply-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		expect(add.ok).toBe(true);
		fs.writeFileSync(path.join(add.path, "a.txt"), "two\n");
		const patch = await capturePatch(add.path);
		await removeWorktree(repo, add.path);
		const file = path.join(base, "p.patch");
		fs.writeFileSync(file, patch);
		return { repo, file, base };
	};

	it("applies to a clean tree", async () => {
		const { repo, file } = await repoWithPatch();
		const res = await applyPatch(repo, file);
		expect(res.applied).toBe(true);
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("two\n");
	});

	it("refuses a dirty tree and leaves it untouched", async () => {
		const { repo, file } = await repoWithPatch();
		fs.writeFileSync(path.join(repo, "scratch.txt"), "x");
		const res = await applyPatch(repo, file);
		expect(res.applied).toBe(false);
		expect(res.reason).toContain("not clean");
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\n");
	});

	it("refuses a patch that no longer applies", async () => {
		const { repo, file, base } = await repoWithPatch();
		const bad = path.join(base, "bad.patch");
		fs.writeFileSync(bad, "diff --git a/nope.txt b/nope.txt\n--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n");
		const res = await applyPatch(repo, bad);
		expect(res.applied).toBe(false);
		expect(res.reason).toContain("does not apply");
	});
});

describe("capturePatch", () => {
	it("does not stage the linked dependency dirs as symlinks", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-capture-"));
		const repo = path.join(base, "repo");
		fs.mkdirSync(repo);
		await git(repo, ["init", "-q", "."]);
		await git(repo, ["config", "user.email", "t@t"]);
		await git(repo, ["config", "user.name", "t"]);
		fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
		fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
		fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
		fs.writeFileSync(path.join(repo, "node_modules", "dep", "index.js"), "export {};\n");
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-qm", "base"]);

		const wt = await addWorktree(repo, `capture-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		expect(wt.ok).toBe(true);
		linkDependencyDirs(repo, wt.path);
		fs.writeFileSync(path.join(wt.path, "a.txt"), "two\n");
		const patch = await capturePatch(wt.path);
		await removeWorktree(repo, wt.path);

		expect(patch).toContain("a.txt");
		expect(patch).not.toContain("node_modules");
	});

	it("still captures a brand-new file", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-capture-new-"));
		const repo = path.join(base, "repo");
		fs.mkdirSync(repo);
		await git(repo, ["init", "-q", "."]);
		await git(repo, ["config", "user.email", "t@t"]);
		await git(repo, ["config", "user.name", "t"]);
		fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-qm", "base"]);

		const wt = await addWorktree(repo, `capture-new-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.writeFileSync(path.join(wt.path, "brand-new.txt"), "hello\n");
		const patch = await capturePatch(wt.path);
		await removeWorktree(repo, wt.path);
		expect(patch).toContain("brand-new.txt");
	});
});

describe("runShell deadline", () => {
	it("resolves after the deadline even when a grandchild holds the pipe open", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-shell-"));
		const started = Date.now();
		// The background sleep inherits stdout; without the grace timer the
		// promise would wait for it (measured: an 18-minute stall on a killed child).
		const res = await runShell("sleep 30 & echo started", cwd, 300);
		const elapsed = Date.now() - started;
		expect(res.timedOut).toBe(true);
		expect(res.exitCode).toBeNull();
		expect(elapsed).toBeLessThan(8000);
	});

	it("reports an exit code for a command that finishes in time", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-shell-ok-"));
		const res = await runShell("exit 3", cwd, 5000);
		expect(res.timedOut).toBe(false);
		expect(res.exitCode).toBe(3);
	});
});
