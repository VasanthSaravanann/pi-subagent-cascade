#!/usr/bin/env node
/**
 * probe-models.mjs — pick tiers that are actually alive and actually usable.
 *
 * For every candidate `provider/id` this spawns a one-line ping through pi
 * (`pi -ne -p 'Reply with exactly: PING_OK' --model <id>`, 60 s deadline),
 * records per candidate `contextWindow`, `maxTokens` and `priced` (catalog
 * `cost.input > 0`), then writes ~/.pi/agent/cascade/config.json (mode 0600)
 * with the first working *eligible* cheap model as tier0 and the first
 * working eligible frontier model as tier1.
 *
 * A model with `maxTokens < 16384` or no published pricing is a LAST RESORT,
 * never a primary: `adaption/*` is credit-funded dev capacity, not a silent
 * production swap. It is recorded in `results` with `primary: false` and a
 * reason, and only promoted when --profile dev says so explicitly.
 *
 * Exit non-zero only when no provider yields BOTH a tier0 and a tier1; a good
 * config is never overwritten by a failed probe.
 *
 * Usage:
 *   node scripts/probe-models.mjs
 *   node scripts/probe-models.mjs --profile dev
 *   node scripts/probe-models.mjs --candidates opencode-go/x,adaption/y
 *   node scripts/probe-models.mjs --skip-ping        (offline: eligibility only)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".pi", "agent", "cascade");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const MIN_PRIMARY_OUTPUT = 16384;

/** Default candidate order: cheap first, then frontier, then last resorts. */
const DEFAULT_CANDIDATES = {
	cheap: [
		"opencode-go/deepseek-v4.1-flash",
		"opencode-go/mimo-v2.6-flash",
		"opencode-go/minimax-m3.1-flash",
		"opencode-go/qwen3.8-flash",
		"opencode-go/glm-5.3-flash",
		"adaption/deepseek-v4-flash",
	],
	frontier: [
		"opencode-go/deepseek-v4-pro",
		"opencode-go/glm-5.3",
		"adaption/glm-5.2",
	],
};

function readCatalog() {
	const byKey = new Map();
	const add = (provider, m) => {
		if (!m || !m.id) return;
		const cost = m.cost ?? {};
		byKey.set(`${provider}/${m.id}`, {
			contextWindow: Number(m.contextWindow ?? 0),
			maxTokens: Number(m.maxTokens ?? 0),
			// Pi fills unknown pricing with 0/null: that is "unpriced", not free.
			priced: Number(cost.input ?? 0) > 0,
		});
	};
	for (const file of [
		path.join(HOME, ".pi", "agent", "models-store.json"),
		path.join(HOME, ".pi", "agent", "models.json"),
	]) {
		try {
			const j = JSON.parse(fs.readFileSync(file, "utf8"));
			if (file.endsWith("models-store.json")) {
				for (const [provider, entry] of Object.entries(j)) {
					if (Array.isArray(entry?.models)) for (const m of entry.models) add(provider, m);
				}
			} else {
				for (const [provider, entry] of Object.entries(j?.providers ?? {})) {
					if (Array.isArray(entry?.models)) for (const m of entry.models) add(provider, m);
				}
			}
		} catch {
			/* a missing store just means fewer known models */
		}
	}
	return byKey;
}

function ping(model, deadlineMs = 60_000) {
	return new Promise((resolve) => {
		const child = spawn("pi", ["-ne", "-p", "Reply with exactly: PING_OK", "--model", model], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout?.on("data", (c) => (out += c));
		child.stderr?.on("data", (c) => (out += c));
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, deadlineMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0 && /PING_OK/.test(out) });
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ ok: false });
		});
	});
}

function eligibility(meta, profile) {
	if (!meta) return "not in the catalog";
	if (meta.contextWindow > 0 && meta.contextWindow < 64_000) return `context ${meta.contextWindow} < 64000`;
	if (profile === "prod" || profile === "max") {
		// Paid profiles never promote credit-funded or tiny-output models.
		if (!meta.priced) return "unpriced (credit-funded last resort)";
		if (meta.maxTokens > 0 && meta.maxTokens < MIN_PRIMARY_OUTPUT) return `max output ${meta.maxTokens} < ${MIN_PRIMARY_OUTPUT}`;
	}
	return null;
}

async function main() {
	const argv = process.argv.slice(2);
	const arg = (name) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const profile = arg("profile") ?? "prod";
	if (!["dev", "prod", "max"].includes(profile)) {
		console.error(`unknown profile ${profile}`);
		process.exit(2);
	}
	const skipPing = argv.includes("--skip-ping");
	const only = arg("candidates");

	const catalog = readCatalog();
	const lists = only
		? { cheap: only.split(",").map((s) => s.trim()).filter(Boolean), frontier: only.split(",").map((s) => s.trim()).filter(Boolean) }
		: DEFAULT_CANDIDATES;

	const results = [];
	const probed = new Map();
	const probe = async (model) => {
		if (probed.has(model)) return probed.get(model);
		const meta = catalog.get(model) ?? null;
		const blocked = eligibility(meta, profile);
		let ok = false;
		if (meta && !blocked) ok = skipPing ? true : (await ping(model)).ok;
		const row = {
			model,
			inList: Object.values(lists).flat().includes(model),
			contextWindow: meta?.contextWindow ?? null,
			maxTokens: meta?.maxTokens ?? null,
			priced: meta?.priced ?? false,
			alive: skipPing ? null : ok,
			primary: !blocked && ok,
			reason: blocked ?? (ok ? null : "no PING_OK inside 60s"),
		};
		probed.set(model, row);
		results.push(row);
		console.log(`  ${model.padEnd(40)} ${row.primary ? "PRIMARY" : "reject"}  ${row.reason ?? ""}`);
		return row;
	};

	console.log(`probing profile=${profile}${skipPing ? " (metadata only)" : ""}`);
	let tier0 = null;
	let tier1 = null;
	for (const m of lists.cheap) {
		if ((await probe(m)).primary) {
			tier0 = m;
			break;
		}
	}
	for (const m of lists.frontier) {
		if ((await probe(m)).primary) {
			tier1 = m;
			break;
		}
	}

	if (!tier0 || !tier1) {
		console.error(`FAIL: no ${tier0 ? "" : "tier0 "}${tier1 ? "" : "tier1"} from the probed candidates; config not touched.`);
		process.exit(1);
	}

	const config = {
		probedAt: new Date().toISOString(),
		profile,
		tier0,
		tier1,
		candidates: lists,
		results,
	};
	fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	const tmp = `${CONFIG_PATH}.new`;
	fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, CONFIG_PATH);
	console.log(`OK: ${CONFIG_PATH} → tier0=${tier0} tier1=${tier1}`);
}

main().catch((e) => {
	console.error(String(e?.stack ?? e));
	process.exit(2);
});
