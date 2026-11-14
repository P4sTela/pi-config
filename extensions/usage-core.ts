/**
 * usage-core — parsing and rendering for the `/usage` extension.
 *
 * No pi imports and no I/O: this module only turns provider payloads into
 * usage windows and windows into text, so it can be unit-tested without a pi
 * runtime (`bun test`).
 */

// ─── model ───

/** One quota window of a provider, e.g. the 5-hour or the weekly limit. */
export interface UsageWindow {
	label: string;
	/** 0–100. */
	usedPercent: number;
	/** Epoch milliseconds; undefined when the provider did not report it. */
	resetsAt?: number;
	/** True when the provider blocks requests on this window. */
	limited: boolean;
}

export type ProviderUsage =
	| { kind: "ok"; name: string; windows: UsageWindow[]; note?: string }
	| { kind: "no_auth"; name: string }
	| { kind: "error"; name: string; message: string };

// ─── helpers ───

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function parseTime(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function makeWindow(
	label: string,
	percent: unknown,
	resetsAt: unknown,
	limited?: boolean,
): UsageWindow | undefined {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
	const usedPercent = clampPercent(percent);
	return {
		label,
		usedPercent,
		resetsAt: parseTime(resetsAt),
		limited: limited ?? usedPercent >= 100,
	};
}

// ─── OpenCode Go: GET https://opencode.ai/zen/go/v1/usage ───

const GO_WINDOWS: ReadonlyArray<readonly [key: string, label: string]> = [
	["rolling", "5h"],
	["weekly", "week"],
	["monthly", "month"],
];

export function parseGoUsage(payload: unknown): UsageWindow[] | undefined {
	if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
	const usage = payload.usage;
	const windows: UsageWindow[] = [];
	for (const [key, label] of GO_WINDOWS) {
		const raw = usage[key];
		if (!isRecord(raw)) continue;
		const limited =
			typeof raw.status === "string" ? raw.status !== "ok" : undefined;
		const window = makeWindow(label, raw.percent, raw.resetsAt, limited);
		if (window) windows.push(window);
	}
	return windows.length > 0 ? windows : undefined;
}

// ─── Claude: GET https://api.anthropic.com/api/oauth/usage ───

export interface ClaudeUsage {
	windows: UsageWindow[];
	extraUsageEnabled: boolean;
}

function claudeScopedWindows(limits: unknown): UsageWindow[] {
	if (!Array.isArray(limits)) return [];
	const windows: UsageWindow[] = [];
	for (const limit of limits) {
		if (!isRecord(limit) || limit.kind !== "weekly_scoped") continue;
		const model = isRecord(limit.scope) ? limit.scope.model : undefined;
		const name = isRecord(model) ? model.display_name : undefined;
		if (typeof name !== "string" || name === "") continue;
		const window = makeWindow(`week ${name}`, limit.percent, limit.resets_at);
		if (window) windows.push(window);
	}
	return windows;
}

export function parseClaudeUsage(payload: unknown): ClaudeUsage | undefined {
	if (!isRecord(payload)) return undefined;
	const windows: UsageWindow[] = [];
	for (const [key, label] of [
		["five_hour", "5h"],
		["seven_day", "week"],
	] as const) {
		const raw = payload[key];
		if (!isRecord(raw)) continue;
		const window = makeWindow(label, raw.utilization, raw.resets_at);
		if (window) windows.push(window);
	}
	windows.push(...claudeScopedWindows(payload.limits));
	if (windows.length === 0) return undefined;
	const extra = payload.extra_usage;
	return {
		windows,
		extraUsageEnabled: isRecord(extra) && extra.is_enabled === true,
	};
}

// ─── rendering ───

function bar(percent: number, width = 20): string {
	const filled = Math.round((clampPercent(percent) / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function duration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
	return `${(seconds / 86400).toFixed(1)}d`;
}

function footerSegment(usage: ProviderUsage): string {
	switch (usage.kind) {
		case "no_auth":
			return `${usage.name} —`;
		case "error":
			return `${usage.name} ⚠`;
		case "ok": {
			const percents = usage.windows
				.map((w) => w.usedPercent.toFixed(0))
				.join("/");
			const limited = usage.windows.some((w) => w.limited) ? " ⏳" : "";
			return `${usage.name} ${percents}%${limited}`;
		}
	}
}

/** Compact one-line status, or undefined when there is nothing to show. */
export function footerLine(usages: ProviderUsage[]): string | undefined {
	if (usages.length === 0) return undefined;
	return usages.map(footerSegment).join(" · ");
}

function detailBlock(usage: ProviderUsage, nowMs: number): string {
	switch (usage.kind) {
		case "no_auth":
			return `${usage.name} — not logged in`;
		case "error":
			return `${usage.name} — error: ${usage.message.slice(0, 100)}`;
		case "ok": {
			const width = Math.max(...usage.windows.map((w) => w.label.length));
			const lines = [usage.name];
			for (const w of usage.windows) {
				const reset =
					w.resetsAt === undefined
						? ""
						: ` · resets in ${duration((w.resetsAt - nowMs) / 1000)}`;
				const limited = w.limited ? " · limited" : "";
				lines.push(
					`  ${w.label.padEnd(width)} ${bar(w.usedPercent)} ${w.usedPercent.toFixed(0)}% used${reset}${limited}`,
				);
			}
			if (usage.note) lines.push(`  ${usage.note}`);
			return lines.join("\n");
		}
	}
}

/** Multi-line report for the `/usage` command. */
export function detailText(usages: ProviderUsage[], nowMs: number): string {
	return usages.map((u) => detailBlock(u, nowMs)).join("\n\n");
}

/** False when a provider errored or blocks requests; missing auth is fine. */
export function isHealthy(usages: ProviderUsage[]): boolean {
	return usages.every((u) => {
		if (u.kind === "error") return false;
		if (u.kind === "ok") return !u.windows.some((w) => w.limited);
		return true;
	});
}

/**
 * No-op factory: pi auto-loads every `extensions/*.ts` and requires a
 * default-exported factory. This module exists only to be imported by
 * usage.ts, so it registers nothing here.
 */
export default function (): void {}
