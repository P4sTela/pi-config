// Standalone tests for usage-core — run with: bun test
import { expect, test } from "bun:test";
import {
	type ProviderUsage,
	detailText,
	footerLine,
	isHealthy,
	parseClaudeUsage,
	parseGoUsage,
} from "../extensions/usage-core";

const NOW = Date.parse("2026-11-14T07:00:00.000Z");

// --- OpenCode Go -----------------------------------------------------------
const GO_PAYLOAD = {
	usage: {
		rolling: { status: "ok", percent: 3, resetsAt: "2026-11-14T10:55:59.000Z" },
		weekly: { status: "ok", percent: 16, resetsAt: "2026-11-16T00:00:00.000Z" },
		monthly: { status: "ok", percent: 17, resetsAt: "2026-12-01T04:17:31.000Z" },
	},
};

test("go: parses the three windows in order", () => {
	const windows = parseGoUsage(GO_PAYLOAD);
	expect(windows?.map((w) => [w.label, w.usedPercent])).toEqual([
		["5h", 3],
		["week", 16],
		["month", 17],
	]);
	expect(windows?.[0].resetsAt).toBe(Date.parse("2026-11-14T10:55:59.000Z"));
	expect(windows?.every((w) => !w.limited)).toBe(true);
});

test("go: a non-ok status marks the window as limited", () => {
	const windows = parseGoUsage({
		usage: { rolling: { status: "exceeded", percent: 100 } },
	});
	expect(windows).toEqual([
		{ label: "5h", usedPercent: 100, resetsAt: undefined, limited: true },
	]);
});

test("go: clamps percent and skips malformed windows", () => {
	const windows = parseGoUsage({
		usage: { rolling: { percent: 140 }, weekly: { percent: "x" }, monthly: null },
	});
	expect(windows?.map((w) => [w.label, w.usedPercent])).toEqual([["5h", 100]]);
});

test("go: returns undefined when there is no usable window", () => {
	expect(parseGoUsage({})).toBeUndefined();
	expect(parseGoUsage(null)).toBeUndefined();
	expect(parseGoUsage({ usage: {} })).toBeUndefined();
});

// --- Claude ----------------------------------------------------------------
const CLAUDE_PAYLOAD = {
	five_hour: { utilization: 37.0, resets_at: "2026-11-14T11:09:59.699276+00:00" },
	seven_day: { utilization: 5.0, resets_at: "2026-11-20T13:59:59.699293+00:00" },
	seven_day_opus: null,
	extra_usage: { is_enabled: false },
	limits: [
		{ kind: "session", percent: 37, resets_at: "2026-11-14T11:09:59.699276+00:00" },
		{ kind: "weekly_all", percent: 5, resets_at: "2026-11-20T13:59:59.699293+00:00" },
		{
			kind: "weekly_scoped",
			percent: 10,
			resets_at: "2026-11-20T13:59:59.699540+00:00",
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
	],
};

test("claude: parses session, weekly and model-scoped weekly windows", () => {
	const parsed = parseClaudeUsage(CLAUDE_PAYLOAD);
	expect(parsed?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
		["5h", 37],
		["week", 5],
		["week Fable", 10],
	]);
	expect(parsed?.extraUsageEnabled).toBe(false);
});

test("claude: works without the limits array and reports extra usage", () => {
	const parsed = parseClaudeUsage({
		five_hour: { utilization: 100, resets_at: null },
		extra_usage: { is_enabled: true },
	});
	expect(parsed?.windows).toEqual([
		{ label: "5h", usedPercent: 100, resetsAt: undefined, limited: true },
	]);
	expect(parsed?.extraUsageEnabled).toBe(true);
});

test("claude: returns undefined when there is no usable window", () => {
	expect(parseClaudeUsage({ extra_usage: { is_enabled: false } })).toBeUndefined();
	expect(parseClaudeUsage("nope")).toBeUndefined();
});

// --- rendering -------------------------------------------------------------
const CLAUDE: ProviderUsage = {
	kind: "ok",
	name: "Claude",
	windows: parseClaudeUsage(CLAUDE_PAYLOAD)?.windows ?? [],
};
const GO: ProviderUsage = {
	kind: "ok",
	name: "Go",
	windows: parseGoUsage(GO_PAYLOAD) ?? [],
};

test("footer: one compact segment per provider", () => {
	expect(footerLine([CLAUDE, GO])).toBe("Claude 37/5/10% · Go 3/16/17%");
});

test("footer: shows auth and error states without windows", () => {
	expect(
		footerLine([
			{ kind: "no_auth", name: "Claude" },
			{ kind: "error", name: "Go", message: "HTTP 500" },
		]),
	).toBe("Claude — · Go ⚠");
	expect(footerLine([])).toBeUndefined();
});

test("detail: lists each window with a bar and time to reset", () => {
	const text = detailText([GO], NOW);
	const lines = text.split("\n");
	expect(lines[0]).toBe("Go");
	expect(lines[1]).toContain("5h");
	expect(lines[1]).toContain("3% used");
	expect(lines[1]).toContain("resets in 3.9h");
	expect(lines[3]).toContain("resets in 16.9d");
});

test("detail: includes notes and error messages", () => {
	const text = detailText(
		[
			{ ...CLAUDE, note: "extra usage: off" },
			{ kind: "error", name: "Go", message: "HTTP 401" },
			{ kind: "no_auth", name: "Other" },
		],
		NOW,
	);
	expect(text).toContain("extra usage: off");
	expect(text).toContain("Go — error: HTTP 401");
	expect(text).toContain("Other — not logged in");
});

test("health: unhealthy when any provider errored or a window is limited", () => {
	expect(isHealthy([CLAUDE, GO])).toBe(true);
	expect(isHealthy([CLAUDE, { kind: "no_auth", name: "Go" }])).toBe(true);
	expect(isHealthy([{ kind: "error", name: "Go", message: "x" }])).toBe(false);
	expect(
		isHealthy([
			{
				kind: "ok",
				name: "Go",
				windows: [{ label: "5h", usedPercent: 100, limited: true }],
			},
		]),
	).toBe(false);
});
