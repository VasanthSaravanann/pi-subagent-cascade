/**
 * Child runner: `pi --mode json -p --no-session` in the attempt's worktree.
 *
 * Why a subprocess (verified): a custom tool cannot call `subagent`
 * (ctx.tools omits it), and `pi` has no `--cwd` flag, so cwd is set on the
 * spawned process. This is the same mechanism the bundled subagent uses, and
 * it gives us the full event stream: gate evidence lives in toolResult text,
 * per-attempt cost in assistant `usage.cost.total`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildResult } from "./types.js";

const PI_BIN = process.env.PI_BIN ?? "pi";
const MAX_TAIL = 4000;

const SYSTEM_PROMPT = [
	"You are a coding subagent working inside an isolated git worktree.",
	"Rules:",
	"- Work only inside the current directory.",
	"- Do not run git commands, do not create commits, do not touch files outside.",
	"- Make the smallest change that satisfies the task.",
	"- Never weaken, skip, or delete tests to make them pass.",
	"- When finished, reply with a short summary of what you changed.",
].join("\n");

function tail(current: string, addition: string): string {
	const next = current + addition;
	return next.length > MAX_TAIL ? next.slice(-MAX_TAIL) : next;
}

function writePromptFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cascade-prompt-"));
	const file = path.join(dir, "system.md");
	fs.writeFileSync(file, SYSTEM_PROMPT, "utf8");
	return file;
}

export interface RunChildOptions {
	cwd: string;
	model: string;
	task: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}

export function runChild(options: RunChildOptions): Promise<ChildResult> {
	const promptFile = writePromptFile();
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		options.model,
		"--append-system-prompt",
		promptFile,
		options.task,
	];

	const result: ChildResult = {
		exitCode: null,
		timedOut: false,
		compactions: 0,
		turns: 0,
		costUsd: 0,
		tokens: { input: 0, output: 0, cacheRead: 0 },
		text: "",
		transcriptTail: "",
		stderrTail: "",
	};

	return new Promise((resolve) => {
		const child = spawn(PI_BIN, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: { ...process.env, PI_CASCADE_CHILD: "1" },
		});

		let buffer = "";

		const handleEvent = (event: unknown) => {
			const ev = event as { type?: string; message?: any };
			if (ev.type === "compaction_start") {
				result.compactions++;
				return;
			}
			if (ev.type !== "message_end" || !ev.message) return;
			const msg = ev.message;
			if (msg.role === "assistant") {
				if (msg.stopReason) result.stopReason = msg.stopReason;
				result.turns++;
				const usage = msg.usage ?? {};
				result.costUsd += Number(usage.cost?.total ?? 0);
				result.tokens.input += Number(usage.input ?? 0);
				result.tokens.output += Number(usage.output ?? 0);
				result.tokens.cacheRead += Number(usage.cacheRead ?? 0);
				const text = (msg.content ?? [])
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text)
					.join("\n")
					.trim();
				if (text) {
					result.text = text;
					options.onProgress?.(text);
				}
			} else if (msg.role === "toolResult") {
				const text = (msg.content ?? [])
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text)
					.join("\n");
				result.transcriptTail = tail(result.transcriptTail, `\n${text}`);
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.startsWith("{")) {
					try {
						handleEvent(JSON.parse(line));
					} catch {
						// Non-JSON line from the child: keep it out of the stream parse.
					}
				}
				idx = buffer.indexOf("\n");
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			result.stderrTail = tail(result.stderrTail, chunk.toString());
		});

		let timedOut = false;
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			finish();
			resolve(result);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			result.timedOut = true;
			result.exitCode = null;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			// A killed `pi` can leave a grandchild holding stdout open, so
			// 'close' may not fire for many minutes (measured: 18 min). Resolve
			// on a short grace timer instead of waiting for the pipe to drain.
			setTimeout(settle, 5_000);
		}, options.timeoutMs);

		const onAbort = () => {
			try {
				process.kill(-child.pid!, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const finish = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			try {
				fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		};

		child.on("close", (code) => {
			result.exitCode = timedOut ? null : code;
			result.timedOut = timedOut;
			settle();
		});

		child.on("error", (error) => {
			result.spawnError = String(error);
			settle();
		});
	});
}
