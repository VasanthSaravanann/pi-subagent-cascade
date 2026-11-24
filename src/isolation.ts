/**
 * Workspace isolation via `git worktree`.
 *
 * `pi-subagents` is not a dependency: after choosing the subprocess runner we
 * own isolation. Each attempt gets a detached worktree at HEAD, so a failed
 * attempt can never pollute the user's tree and never needs a rollback.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
	try {
		const { stdout, stderr } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (e) {
		const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
		return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
	}
}

export interface PreflightResult {
	ok: boolean;
	reason?: string;
	repo?: string;
}

/** The repo must exist and be clean: attempts start from a known base state. */
export async function preflight(repo: string): Promise<PreflightResult> {
	const top = await git(repo, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return { ok: false, reason: `not a git repository: ${repo}` };
	const root = top.stdout.trim();
	const status = await git(root, ["status", "--porcelain"]);
	if (status.code !== 0) return { ok: false, reason: `git status failed: ${status.stderr.trim()}` };
	const dirty = status.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	if (dirty.length > 0) {
		return {
			ok: false,
			reason: `working tree is not clean — commit or stash first:\n  ${dirty.slice(0, 10).join("\n  ")}`,
		};
	}
	return { ok: true, repo: root };
}

export interface Worktree {
	path: string;
	ok: boolean;
	error?: string;
}

export async function addWorktree(repo: string, id: string, ref = "HEAD"): Promise<Worktree> {
	const dir = path.join(os.tmpdir(), "pi-cascade", id);
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	const res = await git(repo, ["worktree", "add", "--detach", dir, ref]);
	if (res.code !== 0) return { path: dir, ok: false, error: res.stderr.trim() || `exit ${res.code}` };
	return { path: dir, ok: true };
}

/** Full patch including new files: stage everything, then diff the index. */
export async function capturePatch(worktreePath: string): Promise<string> {
	await git(worktreePath, ["add", "-A"]);
	const diff = await git(worktreePath, ["diff", "--cached", "--binary"]);
	return diff.stdout;
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
	await git(repo, ["worktree", "remove", "--force", worktreePath]);
	await git(repo, ["worktree", "prune"]);
}

/** Dependency/build dirs worth sharing with an attempt worktree when absent there. */
export const LINKED_DIRS = ["node_modules", ".venv", "venv", "target", "vendor"];

/**
 * Symlink common dependency directories from the source repo into a worktree
 * so gates that need installed deps do not fail with MODULE_NOT_FOUND.
 * Silently skips anything that cannot be linked. Gitignored plain files
 * (.env, local config, compiled artifacts) are still NOT carried over —
 * documented limitation, SKILL §5/§10.
 */
export function linkDependencyDirs(repo: string, worktree: string): string[] {
	const linked: string[] = [];
	for (const name of LINKED_DIRS) {
		try {
			const src = path.join(repo, name);
			const dst = path.join(worktree, name);
			if (fs.existsSync(src) && !fs.existsSync(dst)) {
				fs.symlinkSync(src, dst, "junction");
				linked.push(name);
			}
		} catch {
			// A missing link only matters for gates that need that dir.
		}
	}
	return linked;
}

/** Run a shell command in a directory with a hard deadline and a bounded tail. */export function runShell(
	command: string,
	cwd: string,
	timeoutMs: number,
	env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let out = "";
		const collect = (chunk: Buffer) => {
			out += chunk.toString();
			if (out.length > 8000) out = out.slice(-8000);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: timedOut ? null : code, output: out, timedOut });
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ exitCode: null, output: `${out}\n${String(e)}`, timedOut });
		});
	});
}
