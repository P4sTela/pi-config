/**
 * go-usage — OpenCode Go 専用の軽量 usage checker
 *
 * pi-usage から Codex 部分を削ぎ落とし、OpenCode Go の使用量だけを表示する。
 * ダッシュボードスクレイピング + モデルプローブのフォールバック。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { getModels } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── config ───

const TIMEOUT_MS = 15_000;
const REFRESH_MIN =
	parseInt(process.env.GO_USAGE_REFRESH_MIN ?? "15", 10) || 15;

// ─── constants ───

const API_OPENAI = "openai" as const;
const API_ANTHROPIC = "anthropic" as const;

const BASE_OPENAI = "https://opencode.ai/zen/go/v1/chat/completions";
const BASE_ANTHROPIC = "https://opencode.ai/zen/go/v1/messages";

const RE_ROLLING = /rollingUsage:\$R\[\d+\]=\{([^}]*)\}/;
const RE_WEEKLY = /weeklyUsage:\$R\[\d+\]=\{([^}]*)\}/;
const RE_MONTHLY = /monthlyUsage:\$R\[\d+\]=\{([^}]*)\}/;

const KEY_TO_RE: Record<string, RegExp> = {
	rolling: RE_ROLLING,
	weekly: RE_WEEKLY,
	monthly: RE_MONTHLY,
};

const CREDIT_EXHAUSTED_RE = /insufficient|credit|balance|quota|exhausted/i;
const CREDIT_RE = /credit|balance|quota/i;

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

function resolveConfig(v: string): string | undefined {
	if (v.startsWith("!")) {
		try {
			return (
				execSync(v.slice(1), {
					encoding: "utf8",
					timeout: 10_000,
					stdio: ["ignore", "pipe", "ignore"],
				}).trim() || undefined
			);
		} catch {
			return;
		}
	}
	return process.env[v] || v;
}

function getApiKey(): string | undefined {
	const auth = readAuth();
	for (const provider of ["opencode-go", "opencode"]) {
		const c = auth?.[provider];
		if (c?.type === "api_key" && c.key) return resolveConfig(c.key);
	}
	return process.env.OPENCODE_API_KEY;
}

// ─── quota config ───

interface QuotaConfig {
	workspaceId: string;
	authCookie: string;
	source: string;
}

function getQuotaConfig(): { config?: QuotaConfig; error?: string } {
	const wid = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const ck = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (wid && ck)
		return { config: { workspaceId: wid, authCookie: ck, source: "env" } };
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
						source: p,
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

// ─── model probe ───

interface ModelEntry {
	id: string;
	api: typeof API_OPENAI | typeof API_ANTHROPIC;
	endpoint: string;
	rank: number;
}

const BENCH_MODELS: ModelEntry[] = [
	{ id: "qwen3.5-plus", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 1 },
	{ id: "minimax-m2.5", api: API_ANTHROPIC, endpoint: BASE_ANTHROPIC, rank: 2 },
	{ id: "minimax-m2.7", api: API_ANTHROPIC, endpoint: BASE_ANTHROPIC, rank: 3 },
	{ id: "qwen3.6-plus", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 4 },
	{ id: "mimo-v2-omni", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 5 },
	{ id: "kimi-k2.5", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 6 },
	{ id: "glm-5", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 7 },
	{ id: "kimi-k2.6", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 8 },
	{ id: "mimo-v2-pro", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 9 },
	{ id: "glm-5.1", api: API_OPENAI, endpoint: BASE_OPENAI, rank: 10 },
];

function buildModelList(): ModelEntry[] {
	const byId = new Map<string, ModelEntry>();

	for (const m of BENCH_MODELS) {
		byId.set(m.id, { ...m });
	}
	for (const m of getModels("opencode-go")) {
		if (byId.has(m.id)) continue;
		const api = m.api === "anthropic-messages" ? API_ANTHROPIC : API_OPENAI;
		const ep = api === API_ANTHROPIC ? BASE_ANTHROPIC : BASE_OPENAI;
		byId.set(m.id, {
			id: m.id,
			api,
			endpoint: ep,
			rank: m.cost.input + m.cost.output + 99,
		});
	}
	return [...byId.values()].sort(
		(a, b) => a.rank - b.rank || a.id.localeCompare(b.id),
	);
}

// ─── probe helpers (extracted from loop to avoid function-in-loop) ───

function makeAbortTimer(ctrl: AbortController): ReturnType<typeof setTimeout> {
	return setTimeout(() => ctrl.abort(), TIMEOUT_MS);
}

async function drainBody(res: Response): Promise<void> {
	await res.text().catch(() => {});
}

function parseErrorMessage(errBody: string, status: number): string {
	try {
		return JSON.parse(errBody)?.error?.message ?? `HTTP ${status}`;
	} catch {
		return `HTTP ${status}`;
	}
}

interface ProbeResult {
	available: boolean;
	status: "available" | "rate_limited" | "credits_error" | "error";
	workingModel?: string;
	rateLimitedModel?: string;
	checked: number;
	total: number;
	errorMessage?: string;
}

function earlyExitResult(
	status: ProbeResult["status"],
	model: string,
	checked: number,
	total: number,
	errorMessage?: string,
	rateLimitedModel?: string,
): ProbeResult {
	return {
		available: status === "available",
		status,
		workingModel: status === "available" ? model : undefined,
		rateLimitedModel:
			rateLimitedModel ?? (status === "rate_limited" ? model : undefined),
		checked,
		total,
		errorMessage,
	};
}

async function tryProbeModel(
	m: ModelEntry,
	apiKey: string,
): Promise<{ res: Response; errBody: string }> {
	const ctrl = new AbortController();
	const t = makeAbortTimer(ctrl);
	try {
		if (m.api === API_ANTHROPIC) {
			const res = await fetch(m.endpoint, {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"anthropic-dangerous-direct-browser-access": "true",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: m.id,
					messages: [{ role: "user", content: "hi" }],
					max_tokens: 1,
					stream: false,
				}),
				signal: ctrl.signal,
			});
			return { res, errBody: "" };
		}
		const res = await fetch(m.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: m.id,
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 1,
			}),
			signal: ctrl.signal,
		});
		return { res, errBody: "" };
	} finally {
		clearTimeout(t);
	}
}

function readTextSafe(res: Response): Promise<string> {
	return res.text().catch(() => "");
}

function shouldSkipStatus(status: number): boolean {
	return status === 400 || status === 404 || status === 422;
}

async function probeModels(apiKey: string): Promise<ProbeResult> {
	const models = buildModelList();
	let last429: { model: string; msg: string } | undefined;

	for (let i = 0; i < models.length; i++) {
		const m = models[i];
		const { res } = await tryProbeModel(m, apiKey);

		if (res.ok) {
			await drainBody(res);
			return earlyExitResult(
				"available",
				m.id,
				i + 1,
				models.length,
				undefined,
				last429?.model,
			);
		}

		const errBody = await readTextSafe(res);
		const errMsg = parseErrorMessage(errBody, res.status);

		if (res.status === 429) {
			last429 = { model: m.id, msg: errMsg };
			if (CREDIT_EXHAUSTED_RE.test(errMsg)) {
				return earlyExitResult(
					"rate_limited",
					m.id,
					i + 1,
					models.length,
					errMsg,
				);
			}
			continue;
		}

		if (res.status === 401 || res.status === 403) {
			return earlyExitResult(
				CREDIT_RE.test(errMsg) ? "credits_error" : "error",
				m.id,
				i + 1,
				models.length,
				errMsg,
			);
		}

		if (shouldSkipStatus(res.status)) continue;

		return earlyExitResult("error", m.id, i + 1, models.length, errMsg);
	}

	if (last429) {
		return earlyExitResult(
			"rate_limited",
			last429.model,
			models.length,
			models.length,
			last429.msg,
		);
	}
	return earlyExitResult(
		"error",
		"",
		models.length,
		models.length,
		"no Go model responded",
	);
}

// ─── aggregate check ───

interface GoUsage {
	available: boolean;
	status: "available" | "rate_limited" | "credits_error" | "error" | "no_key";
	workingModel?: string;
	rateLimitedModel?: string;
	checked?: number;
	total?: number;
	errorMessage?: string;

	rolling?: QuotaWindow;
	weekly?: QuotaWindow;
	monthly?: QuotaWindow;
}

async function checkAll(): Promise<GoUsage> {
	const apiKey = getApiKey();
	if (!apiKey) return { available: false, status: "no_key" };

	const qc = getQuotaConfig();
	if (qc.config) {
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
	}

	// fallback: model probe
	const probe = await probeModels(apiKey);
	return { ...probe };
}

// ─── footer (compact one-liner) ───

function footerLine(u: GoUsage | undefined): string | undefined {
	if (!u) return;
	const parts: string[] = [];
	if (u.rolling) parts.push(`${u.rolling.used.toFixed(0)}%r`);
	if (u.weekly) parts.push(`${u.weekly.used.toFixed(0)}%w`);
	if (u.monthly) parts.push(`${u.monthly.used.toFixed(0)}%m`);
	const icons: Record<string, string> = {
		available: "✓",
		rate_limited: "⏳",
		credits_error: "✗",
		error: "⚠",
	};
	const s = parts.length > 0 ? parts.join("/") : (icons[u.status] ?? "?");
	return `Go ${s}`;
}

// ─── detailed notification (for /usage) ───

function detailText(u: GoUsage): string {
	const lines: string[] = [];
	const labels: Record<string, string> = {
		available: "available",
		rate_limited: "rate limited",
		credits_error: "credits exhausted",
		error: "error",
		no_key: "no key",
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

	if (u.workingModel) lines.push(`  working: ${u.workingModel}`);
	if (u.checked) lines.push(`  checked: ${u.checked}/${u.total} models`);
	if (u.errorMessage) lines.push(`  ${u.errorMessage.substring(0, 100)}`);

	return lines.join("\n");
}

// ─── extension ───

export default function (pi: ExtensionAPI) {
	let usage: GoUsage | undefined;
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
			usage = { available: false, status: "error", errorMessage: e.message };
		}

		loading = false;

		if (c.hasUI) {
			c.ui.setStatus("go-usage", footerLine(usage));
			if (showDetail && usage) {
				c.ui.notify(
					detailText(usage),
					usage.status === "available" ? "info" : "warning",
				);
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
		description: "Show OpenCode Go usage details",
		handler: async (_args: any, c: any) => {
			await refresh(c, true);
		},
	});
}
