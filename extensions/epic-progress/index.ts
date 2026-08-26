/**
 * epic-progress — pi extension.
 *
 * 「大きめのタスク → 細分化 → 実行」の AI 駆動開発ワークフローで、
 * 現在の進行状況を把握する画面を提供する。
 *
 * - エディタ上部ウィジェット: epic (親タスク) 単位の進捗サマリ (常時表示)
 * - /progress コマンド: 詳細一覧 (status / activeForm / blockedBy)
 *
 * データ統合: rpiv-todo の `todo` ツールと互換。タスク状態は
 * `tool_execution_end` イベントの `result.details` (TaskDetails) から読み、
 * セッション再開時は `ctx.sessionManager.getBranch()` の履歴から
 * last-write-wins で復元する。rpiv-todo のモジュールには実行時依存しない。
 *
 * epic の紐付け規約: 子タスクは `metadata: { epic: <親タスク id> }` を持つ。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { isTaskDetails, replayFromBranch, type TaskState } from "./model.ts";
import { computeEpicSummary, findEpicId } from "./selectors.ts";
import {
	buildProgressText,
	buildWidgetRows,
	type WidgetRow,
} from "./render.ts";

const WIDGET_KEY = "epic-progress";
/** ウィジェットのコンテンツ行予算 (ヘッダ含む)。 */
const DEFAULT_WIDGET_LINES = 12;

// ---------------------------------------------------------------------------
// セッション分離 state (モジュールスコープ — extension はセッション切替時に
// 再ロードされるので、session_start の replay で毎回再構築される)。
// ---------------------------------------------------------------------------

const states = new Map<string, TaskState>();
/** フォアグラウンド (UI) セッション。タスク widget はこのセッションの state を表示する。 */
let activeSession = "";
let uiCtx: ExtensionUIContext | undefined;
let tui: TUI | undefined;
let widgetRegistered = false;

function sessionId(ctx: {
	sessionManager: { getSessionId(): string };
}): string {
	try {
		return ctx.sessionManager.getSessionId() ?? "";
	} catch {
		return "";
	}
}

function getState(s: string): TaskState {
	return states.get(s) ?? { tasks: [], nextId: 1 };
}

function isEmptySummary(state: TaskState): boolean {
	const summary = computeEpicSummary(state);
	return (
		summary.epics.length === 0 &&
		summary.uncategorized.length === 0 &&
		summary.orphanChildren.length === 0
	);
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

function renderWidget(theme: Theme, width: number): string[] {
	const summary = computeEpicSummary(getState(activeSession));
	const { rows, hiddenEpics, hiddenTasks } = buildWidgetRows(
		summary,
		DEFAULT_WIDGET_LINES - 1,
	);
	const truncate = (line: string): string => truncateToWidth(line, width, "…");

	const hasActive = summary.total > summary.done;
	const headingColor = hasActive ? "accent" : "dim";
	const headingIcon = hasActive ? "●" : "○";
	const lines: string[] = [
		truncate(
			`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `Progress (${summary.done}/${summary.total})`)}`,
		),
	];
	for (const r of rows) {
		lines.push(truncate(renderRow(theme, r)));
	}
	if (hiddenEpics > 0 || hiddenTasks > 0) {
		const parts: string[] = [];
		if (hiddenEpics > 0) parts.push(`+${hiddenEpics} epics`);
		if (hiddenTasks > 0) parts.push(`+${hiddenTasks} tasks`);
		lines.push(
			truncate(
				`${theme.fg("dim", "└─")} ${theme.fg("dim", `${parts.join(", ")} more`)}`,
			),
		);
	}
	// 末尾スペーサ (rpiv-todo と同じく最下行がインプットボックスにくっつかないように)
	lines.push("");
	return lines;
}

function renderRow(theme: Theme, r: WidgetRow): string {
	const icon = r.icon ?? "▣";
	const color = r.color as "accent" | "dim" | "warning" | "success";
	return `${theme.fg(color, icon)} ${theme.fg(color, r.text)}`;
}

function updateWidget(): void {
	if (!uiCtx) return;
	if (isEmptySummary(getState(activeSession))) {
		if (widgetRegistered) {
			uiCtx.setWidget(WIDGET_KEY, undefined);
			widgetRegistered = false;
			tui = undefined;
		}
		return;
	}
	if (widgetRegistered) {
		tui?.requestRender();
	} else {
		uiCtx.setWidget(
			WIDGET_KEY,
			(t, factoryTheme) => {
				tui = t;
				return {
					render: (width: number) =>
						renderWidget(uiCtx?.theme ?? factoryTheme, width),
					invalidate: () => {
						/* キャッシュなし — 毎 render で uiCtx.theme を読む */
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		widgetRegistered = true;
	}
}

function disposeWidget(): void {
	if (uiCtx) uiCtx.setWidget(WIDGET_KEY, undefined);
	widgetRegistered = false;
	tui = undefined;
	uiCtx = undefined;
}

export default function (pi: ExtensionAPI): void {
	// セッション開始/復元: branch 履歴からタスク状態を再構築。
	pi.on("session_start", async (_event, ctx) => {
		const id = sessionId(ctx);
		states.set(id, replayFromBranch(ctx.sessionManager.getBranch()));
		if (!ctx.hasUI) return;
		activeSession = id;
		uiCtx = ctx.ui;
		updateWidget();
	});

	// セッション切替/終了: state 破棄。フォアグラウンドだったら widget を畳む。
	pi.on("session_shutdown", async (_event, ctx) => {
		const id = sessionId(ctx);
		states.delete(id);
		if (id !== activeSession) return;
		activeSession = "";
		disposeWidget();
	});

	// コンパクト / ツリー化: branch が変わるので replay し直す。
	const replayAndRefresh = async (
		ctx: Parameters<typeof sessionId>[0] & {
			sessionManager: { getBranch(): Iterable<unknown> };
		},
	) => {
		const id = sessionId(ctx);
		states.set(id, replayFromBranch(ctx.sessionManager.getBranch()));
		if (id === activeSession) updateWidget();
	};
	pi.on("session_compact", (_event, ctx) => replayAndRefresh(ctx));
	pi.on("session_tree", (_event, ctx) => replayAndRefresh(ctx));

	// todo ツール実行後: 結果の TaskDetails で state を更新。
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "todo" || event.isError) return;
		const details = (event as { result?: { details?: unknown } }).result?.details;
		if (!isTaskDetails(details)) return;
		const id = sessionId(ctx);
		states.set(id, {
			tasks: details.tasks.map((t) => ({ ...t })),
			nextId: details.nextId,
		});
		if (id === activeSession) updateWidget();
	});

	// /progress — epic 詳細一覧。引数で epic を subject 部分一致フィルタ。
	pi.registerCommand("progress", {
		description:
			"Show epic task progress breakdown (epic = tasks referenced via metadata.epic)",
		handler: async (args, ctx: ExtensionContext) => {
			const summary = computeEpicSummary(getState(sessionId(ctx)));
			const arg = (args ?? "").trim();
			const epicId = arg ? findEpicId(summary, arg) : undefined;
			const lines = buildProgressText(summary, epicId);
			const output = lines.join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(output, "info");
			} else {
				console.log(`[epic-progress] ${output}`);
			}
		},
	});
}
