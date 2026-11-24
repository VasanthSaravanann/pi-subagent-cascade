/**
 * Append-only JSONL ledger at ~/.pi/agent/cascade/ledger.jsonl.
 *
 * Lives outside the repo so stats survive project switches. Never records raw
 * stderr or source — only an error code and a bounded tail.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttemptRow } from "./types.js";

export const LEDGER_DIR = path.join(os.homedir(), ".pi", "agent", "cascade");
export const LEDGER_PATH = path.join(LEDGER_DIR, "ledger.jsonl");
export const CONFIG_PATH = path.join(LEDGER_DIR, "config.json");

/** Written by scripts/probe-models.mjs; absent config is normal, not an error. */
export function readConfig(file = CONFIG_PATH): Record<string, unknown> | null {
	try {
		if (!fs.existsSync(file)) return null;
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function ensureDir(): void {
	fs.mkdirSync(LEDGER_DIR, { recursive: true, mode: 0o700 });
}

export function appendRow(row: AttemptRow): void {
	ensureDir();
	fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(row)}\n`, "utf8");
}

export function readRows(file = LEDGER_PATH): AttemptRow[] {
	if (!fs.existsSync(file)) return [];
	const rows: AttemptRow[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			rows.push(JSON.parse(trimmed) as AttemptRow);
		} catch {
			// Skip a torn line rather than losing the whole ledger.
		}
	}
	return rows;
}

export function resetLedger(): void {
	ensureDir();
	fs.writeFileSync(LEDGER_PATH, "", "utf8");
}

export interface LockHolder {
	pid: number;
	taskId: string;
	startedAt: string;
}

const LOCK_NAME = "lock";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means the pid exists and belongs to someone else: still alive.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Single-flight lock per cascade run. Created with `wx` so two dispatchers
 * cannot both win. A live holder's pid refuses with its info; a dead pid
 * (killed run) is reclaimed. Guards against two cascades fighting over the
 * same repo — worktree names are already unique per task.
 */
export function acquireLock(
	taskId: string,
	opts: { pid?: number; dir?: string } = {},
): { ok: boolean; holder?: LockHolder; path: string } {
	const dir = opts.dir ?? LEDGER_DIR;
	const pid = opts.pid ?? process.pid;
	const file = path.join(dir, LOCK_NAME);
	const write = () => {
		fs.writeFileSync(
			file,
			`${JSON.stringify({ pid, taskId, startedAt: new Date().toISOString() } satisfies LockHolder)}\n`,
			{ mode: 0o600 },
		);
	};
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, "", { flag: "wx" });
		write();
		return { ok: true, path: file };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	let holder: LockHolder | undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (parsed && typeof parsed.pid === "number") holder = parsed as LockHolder;
	} catch {
		// Torn or empty lock file: treat as stale.
	}
	if (holder && pidAlive(holder.pid)) return { ok: false, holder, path: file };
	try {
		fs.rmSync(file, { force: true });
		fs.writeFileSync(file, "", { flag: "wx" });
		write();
		return { ok: true, path: file };
	} catch {
		// Lost the reclaim race: report whoever holds it now.
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			return { ok: false, holder: parsed as LockHolder, path: file };
		} catch {
			return { ok: false, holder, path: file };
		}
	}
}

export function releaseLock(opts: { dir?: string } = {}): void {
	try {
		fs.rmSync(path.join(opts.dir ?? LEDGER_DIR, LOCK_NAME), { force: true });
	} catch {
		/* best effort */
	}
}

export function newTaskId(now = Date.now(), rand = Math.random): string {
	return `${now.toString(36)}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, "0")}`;
}

/** Cheap task signature for grouping: language + verb, not a full fingerprint. */
export function signature(task: string, repo: string): string {
	const langs: Array<[RegExp, string]> = [
		[/\.rs\b|rustc|cargo|\brust\b/i, "rust"],
		[/\.py\b|pytest|\bpython\b/i, "python"],
		[/\.tsx?\b|\btsc\b|typescript|\bnpm\b|\bnode\b|\bts\b/i, "ts"],
		[/\.go\b|\bgo test\b|\bgolang\b/i, "go"],
	];
	const lang = langs.find(([re]) => re.test(task))?.[1] ?? "any";
	const verbs: Array<[RegExp, string]> = [
		[/\b(fix|bug|failing|broken)\b/i, "fix"],
		[/\b(refactor|rename|extract|move)\b/i, "refactor"],
		[/\b(test|spec|coverage)\b/i, "test"],
		[/\b(add|implement|create|feature)\b/i, "feat"],
	];
	const verb = verbs.find(([re]) => re.test(task))?.[1] ?? "task";
	return `${path.basename(repo)}:${lang}:${verb}`;
}
