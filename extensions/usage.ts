/**
 * usage — Claude と OpenCode Go の軽量 usage checker
 *
 * どちらも公式の JSON エンドポイントを auth.json の認証情報で叩く。
 * パースと表示は usage-core.ts にあり、このファイルは I/O と pi への配線だけを持つ。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ProviderUsage,
	detailText,
	footerLine,
	isHealthy,
	parseClaudeUsage,
	parseGoUsage,
} from "./usage-core.ts";

// ─── config ───

const TIMEOUT_MS = 15_000;
const REFRESH_MIN = parseInt(process.env.PI_USAGE_REFRESH_MIN ?? "15", 10) || 15;
const STATUS_KEY = "usage";

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// ─── auth ───

function agentDir(): string {
	return (
		process.env.PI_CODING_AGENT_DIR?.trim() ||
		path.join(os.homedir(), ".pi", "agent")
	);
}

function readAuth(provider: string): Record<string, unknown> | undefined {
	try {
		const raw = fs.readFileSync(path.join(agentDir(), "auth.json"), "utf8");
		const entry = JSON.parse(raw)?.[provider];
		return typeof entry === "object" && entry !== null ? entry : undefined;
	} catch {
		return undefined;
	}
}

// ─── fetch ───

type JsonResult =
	| { ok: true; payload: unknown }
	| { ok: false; message: string };

async function getJson(
	url: string,
	headers: Record<string, string>,
): Promise<JsonResult> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { Accept: "application/json", ...headers },
			signal: ctrl.signal,
		});
		if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
		return { ok: true, payload: await res.json() };
	} catch (e: unknown) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	} finally {
		clearTimeout(timer);
	}
}

async function fetchGoUsage(): Promise<ProviderUsage> {
	const name = "Go";
	const auth = readAuth("opencode-go");
	if (auth?.type !== "api_key" || typeof auth.key !== "string") {
		return { kind: "no_auth", name };
	}
	const res = await getJson(GO_USAGE_URL, {
		Authorization: `Bearer ${auth.key}`,
		"User-Agent": "pi-usage/1.0",
	});
	if (!res.ok) return { kind: "error", name, message: res.message };
	const windows = parseGoUsage(res.payload);
	if (!windows) return { kind: "error", name, message: "no usage data" };
	return { kind: "ok", name, windows };
}

async function fetchClaudeUsage(): Promise<ProviderUsage> {
	const name = "Claude";
	const auth = readAuth("anthropic");
	if (auth?.type !== "oauth" || typeof auth.access !== "string") {
		return { kind: "no_auth", name };
	}
	// トークンの更新は pi 本体に任せる（ここで refresh すると pi 側のトークンと競合する）。
	const res = await getJson(CLAUDE_USAGE_URL, {
		Authorization: `Bearer ${auth.access}`,
		"anthropic-beta": "oauth-2025-04-20",
	});
	if (!res.ok) {
		const message =
			res.message === "HTTP 401"
				? "HTTP 401 (token expired; use a Claude model once to refresh)"
				: res.message;
		return { kind: "error", name, message };
	}
	const parsed = parseClaudeUsage(res.payload);
	if (!parsed) return { kind: "error", name, message: "no usage data" };
	return {
		kind: "ok",
		name,
		windows: parsed.windows,
		note: `extra usage: ${parsed.extraUsageEnabled ? "on" : "off"}`,
	};
}

function fetchAll(): Promise<ProviderUsage[]> {
	return Promise.all([fetchClaudeUsage(), fetchGoUsage()]);
}

// ─── extension ───

export default function (pi: ExtensionAPI) {
	let loading = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ctx: any;

	async function refresh(c: any, showDetail = false) {
		if (loading) return;
		loading = true;
		ctx = c;
		try {
			const usages = await fetchAll();
			if (!c.hasUI) return;
			c.ui.setStatus(STATUS_KEY, footerLine(usages));
			if (showDetail) {
				c.ui.notify(
					detailText(usages, Date.now()),
					isHealthy(usages) ? "info" : "warning",
				);
			}
		} finally {
			loading = false;
		}
	}

	pi.on("session_start", (ev, c) => {
		if (ev.reason === "startup" || ev.reason === "reload") {
			setTimeout(() => refresh(c).catch(() => {}), 500);
		}
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (ctx) refresh(ctx).catch(() => {});
		}, REFRESH_MIN * 60_000);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	pi.registerCommand("usage", {
		description: "Show Claude and OpenCode Go usage details",
		handler: async (_args: any, c: any) => {
			await refresh(c, true);
		},
	});
}
