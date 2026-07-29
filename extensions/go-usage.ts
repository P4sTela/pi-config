/**
 * usage — Codex と OpenCode Go の軽量 usage checker
 *
 * Codex は ChatGPT OAuth の usage endpoint、OpenCode Go は
 * ダッシュボードをスクレイピングして確認する。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── config ───

const TIMEOUT_MS = 15_000;
const REFRESH_MIN =
	parseInt(process.env.GO_USAGE_REFRESH_MIN ?? "15", 10) || 15;

// ─── constants ───

const RE_ROLLING = /rollingUsage:\$R\[\d+\]=\{([^}]*)\}/;
const RE_WEEKLY = /weeklyUsage:\$R\[\d+\]=\{([^}]*)\}/;
const RE_MONTHLY = /monthlyUsage:\$R\[\d+\]=\{([^}]*)\}/;

const KEY_TO_RE: Record<string, RegExp> = {
	rolling: RE_ROLLING,
	weekly: RE_WEEKLY,
	monthly: RE_MONTHLY,
};

// ─── helpers ───

function clamp(v: number): number {
	return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

function bar(pct: number, w = 20): string {
	const f = Math.round((clamp(pct) / 100) * w);
	return "█".repeat(f) + "░".repeat(w - f);
}

function dur(sec: number): string {
	if (sec <= 0) return "now";
	if (sec < 60) return `${Math.round(sec)}s`;
	if (sec < 3600) return `${Math.round(sec / 60)}m`;
	if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
	return `${(sec / 86400).toFixed(1)}d`;
}

function readAuth(): Record<string, any> | undefined {
	try {
		const p = path.join(os.homedir(), ".pi/agent/auth.json");
		if (!fs.existsSync(p)) return;
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return;
	}
}

// ─── quota config ───

interface QuotaConfig {
	workspaceId: string;
	authCookie: string;
}

function getQuotaConfig(): { config?: QuotaConfig; error?: string } {
	const wid = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const ck = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (wid && ck) return { config: { workspaceId: wid, authCookie: ck } };
	if (wid || ck)
		return {
			error: "need both OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE",
		};

	const home = os.homedir();
	const candidates = [
		process.env.OPENCODE_GO_QUOTA_CONFIG?.trim(),
		process.env.XDG_CONFIG_HOME
			? path.join(
					process.env.XDG_CONFIG_HOME,
					"opencode",
					"opencode-quota",
					"opencode-go.json",
				)
			: undefined,
		path.join(
			home,
			".config",
			"opencode",
			"opencode-quota",
			"opencode-go.json",
		),
		process.platform === "darwin"
			? path.join(
					home,
					"Library",
					"Application Support",
					"opencode",
					"opencode-quota",
					"opencode-go.json",
				)
			: undefined,
	].filter(Boolean) as string[];

	for (const p of [...new Set(candidates)]) {
		if (!fs.existsSync(p)) continue;
		try {
			const j = JSON.parse(fs.readFileSync(p, "utf8"));
			if (j.workspaceId && j.authCookie)
				return {
					config: {
						workspaceId: j.workspaceId,
						authCookie: j.authCookie,
					},
				};
			return { error: `${p}: need workspaceId and authCookie` };
		} catch (e: any) {
			return { error: `${p}: ${e.message}` };
		}
	}
	return {};
}

// ─── dashboard scrape ───

interface QuotaWindow {
	used: number;
	remaining: number;
	resetSec: number;
	resetAt: number;
}

function parseWindow(html: string, key: string): QuotaWindow | undefined {
	const re = KEY_TO_RE[key];
	if (!re) return;
	const m = re.exec(html);
	if (!m) return;
	const u = /usagePercent:(\d+(?:\.\d+)?)/.exec(m[1]);
	if (!u) return;
	const used = clamp(Number(u[1]));
	const rs = /resetInSec:(\d+(?:\.\d+)?)/.exec(m[1]);
	const resetSec = rs ? Math.max(0, Math.round(Number(rs[1]))) : 0;
	return {
		used,
		remaining: clamp(100 - used),
		resetSec,
		resetAt: resetSec > 0 ? Math.floor(Date.now() / 1000) + resetSec : 0,
	};
}

function isWindowExhausted(w: QuotaWindow | undefined): boolean {
	return w !== undefined && w.used >= 100;
}

async function scrapeQuota(cfg: QuotaConfig): Promise<{
	rolling?: QuotaWindow;
	weekly?: QuotaWindow;
	monthly?: QuotaWindow;
	error?: string;
}> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(
			`https://opencode.ai/workspace/${encodeURIComponent(cfg.workspaceId)}/go`,
			{
				headers: {
					Accept: "text/html",
					Cookie: `auth=${cfg.authCookie}`,
					"User-Agent": `go-usage`,
				},
				signal: ctrl.signal,
			},
		);
		if (!res.ok) return { error: `HTTP ${res.status}` };
		const html = await res.text();
		const r = parseWindow(html, "rolling");
		const w = parseWindow(html, "weekly");
		const m = parseWindow(html, "monthly");
		const hasAnyWindow = r || w || m;
		if (!hasAnyWindow) return { error: "no quota data in dashboard" };
		return { rolling: r, weekly: w, monthly: m };
	} catch (e: any) {
		return { error: e.message };
	} finally {
		clearTimeout(t);
	}
}

// ─── aggregate check ───

interface GoUsage {
	available: boolean;
	status: "available" | "rate_limited" | "error";
	errorMessage?: string;

	rolling?: QuotaWindow;
	weekly?: QuotaWindow;
	monthly?: QuotaWindow;
}

async function checkGo(): Promise<GoUsage> {
	const qc = getQuotaConfig();
	if (!qc.config) {
		return {
			available: false,
			status: "error",
			errorMessage: qc.error ?? "quota config not found",
		};
	}

	const scraped = await scrapeQuota(qc.config);
	if (scraped.rolling || scraped.weekly || scraped.monthly) {
		const exhausted =
			isWindowExhausted(scraped.rolling) ||
			isWindowExhausted(scraped.weekly) ||
			isWindowExhausted(scraped.monthly);
		return {
			available: !exhausted,
			status: exhausted ? "rate_limited" : "available",
			rolling: scraped.rolling,
			weekly: scraped.weekly,
			monthly: scraped.monthly,
		};
	}

	return {
		available: false,
		status: "error",
		errorMessage: scraped.error ?? "no quota data in dashboard",
	};
}

// ─── Codex usage ───

interface CodexWindow {
	usedPercent: number;
	resetAfterSec: number;
	resetAt: number;
}

interface CodexUsage {
	status: "available" | "rate_limited" | "error" | "no_auth";
	planType?: string;
	primary?: CodexWindow;
	secondary?: CodexWindow;
	errorMessage?: string;
}

interface Usage {
	go: GoUsage;
	codex: CodexUsage;
}

function getCodexAuth():
	| { accessToken: string; accountId?: string }
	| undefined {
	const auth = readAuth()?.["openai-codex"];
	if (auth?.type !== "oauth" || typeof auth.access !== "string") return;
	return {
		accessToken: auth.access,
		accountId: typeof auth.accountId === "string" ? auth.accountId : undefined,
	};
}

function parseCodexWindow(value: unknown): CodexWindow | undefined {
	if (!value || typeof value !== "object") return;
	const w = value as Record<string, unknown>;
	const usedPercent = Number(w.used_percent);
	if (!Number.isFinite(usedPercent)) return;
	return {
		usedPercent: Math.max(0, Math.min(100, usedPercent)),
		resetAfterSec: Math.max(0, Number(w.reset_after_seconds) || 0),
		resetAt: Math.max(0, Number(w.reset_at) || 0),
	};
}

async function fetchCodexUsage(): Promise<CodexUsage> {
	const auth = getCodexAuth();
	if (!auth) return { status: "no_auth" };

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${auth.accessToken}`,
			"User-Agent": "codex-cli",
		};
		if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

		const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers,
			signal: ctrl.signal,
		});
		if (!res.ok) return { status: "error", errorMessage: `HTTP ${res.status}` };

		const payload = (await res.json()) as {
			plan_type?: unknown;
			rate_limit?: {
				limit_reached?: unknown;
				primary_window?: unknown;
				secondary_window?: unknown;
			};
		};
		const primary = parseCodexWindow(payload.rate_limit?.primary_window);
		const secondary = parseCodexWindow(payload.rate_limit?.secondary_window);
		if (!primary && !secondary) {
			return { status: "error", errorMessage: "no rate-limit data" };
		}
		return {
			status:
				payload.rate_limit?.limit_reached === true
					? "rate_limited"
					: "available",
			planType:
				typeof payload.plan_type === "string" ? payload.plan_type : undefined,
			primary,
			secondary,
		};
	} catch (e: unknown) {
		return {
			status: "error",
			errorMessage: e instanceof Error ? e.message : String(e),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function checkAll(): Promise<Usage> {
	const [go, codex] = await Promise.all([checkGo(), fetchCodexUsage()]);
	return { go, codex };
}

// ─── footer (compact one-liner) ───

function codexFooter(u: CodexUsage): string {
	if (u.status === "no_auth") return "Codex —";
	if (u.status === "error") return "Codex ⚠";
	const windows = [u.primary, u.secondary].filter(Boolean) as CodexWindow[];
	const usage = windows.map((w) => `${w.usedPercent.toFixed(0)}%`).join("/");
	return `Codex ${usage || (u.status === "rate_limited" ? "⏳" : "?")}`;
}

function goFooter(u: GoUsage): string {
	const parts: string[] = [];
	if (u.rolling) parts.push(`${u.rolling.used.toFixed(0)}%r`);
	if (u.weekly) parts.push(`${u.weekly.used.toFixed(0)}%w`);
	if (u.monthly) parts.push(`${u.monthly.used.toFixed(0)}%m`);
	const icons: Record<string, string> = {
		available: "✓",
		rate_limited: "⏳",
		error: "⚠",
	};
	const s = parts.length > 0 ? parts.join("/") : (icons[u.status] ?? "?");
	return `Go ${s}`;
}

function footerLine(u: Usage | undefined): string | undefined {
	if (!u) return;
	return `${codexFooter(u.codex)} · ${goFooter(u.go)}`;
}

// ─── detailed notification (for /usage) ───

function detailGoText(u: GoUsage): string {
	const lines: string[] = [];
	const labels: Record<string, string> = {
		available: "available",
		rate_limited: "rate limited",
		error: "error",
	};

	lines.push(`OpenCode Go — ${labels[u.status] ?? u.status}`);

	for (const win of [
		{ label: "rolling", w: u.rolling },
		{ label: "week", w: u.weekly },
		{ label: "month", w: u.monthly },
	]) {
		if (!win.w) continue;
		const b = bar(win.w.used);
		const rst = win.w.resetAt
			? ` resets ${dur(win.w.resetAt - Date.now() / 1000)}`
			: win.w.resetSec > 0
				? ` resets in ${dur(win.w.resetSec)}`
				: "";
		lines.push(
			`  ${win.label.padEnd(7)} ${b} ${win.w.used.toFixed(0)}% used / ${win.w.remaining.toFixed(0)}% left${rst}`,
		);
	}

	if (u.errorMessage) lines.push(`  ${u.errorMessage.substring(0, 100)}`);

	return lines.join("\n");
}

function detailCodexText(u: CodexUsage): string {
	const labels: Record<CodexUsage["status"], string> = {
		available: "available",
		rate_limited: "rate limited",
		error: "error",
		no_auth: "no auth",
	};
	const lines = [
		`Codex (${u.planType ?? "unknown plan"}) — ${labels[u.status]}`,
	];
	for (const [label, window] of [
		["primary", u.primary],
		["secondary", u.secondary],
	] as const) {
		if (!window) continue;
		const reset = window.resetAt
			? ` resets ${dur(window.resetAt - Date.now() / 1000)}`
			: window.resetAfterSec > 0
				? ` resets in ${dur(window.resetAfterSec)}`
				: "";
		lines.push(
			`  ${label.padEnd(9)} ${bar(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used / ${(100 - window.usedPercent).toFixed(0)}% left${reset}`,
		);
	}
	if (u.errorMessage) lines.push(`  ${u.errorMessage.substring(0, 100)}`);
	return lines.join("\n");
}

function detailText(u: Usage): string {
	return `${detailCodexText(u.codex)}\n\n${detailGoText(u.go)}`;
}

// ─── extension ───

export default function (pi: ExtensionAPI) {
	let usage: Usage | undefined;
	let loading = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ctx: any;

	async function refresh(c: any, showDetail = false) {
		if (loading) return;
		loading = true;
		ctx = c;

		try {
			usage = await checkAll();
		} catch (e: any) {
			const message = e instanceof Error ? e.message : String(e);
			usage = {
				go: { available: false, status: "error", errorMessage: message },
				codex: { status: "error", errorMessage: message },
			};
		}

		loading = false;

		if (c.hasUI) {
			c.ui.setStatus("go-usage", footerLine(usage));
			if (showDetail && usage) {
				const healthy =
					usage.codex.status === "available" && usage.go.status === "available";
				c.ui.notify(detailText(usage), healthy ? "info" : "warning");
			}
		}
	}

	pi.on("session_start", (ev, c) => {
		if (ev.reason === "startup" || ev.reason === "reload") {
			setTimeout(() => refresh(c), 500);
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
		description: "Show Codex and OpenCode Go usage details",
		handler: async (_args: any, c: any) => {
			await refresh(c, true);
		},
	});
}
