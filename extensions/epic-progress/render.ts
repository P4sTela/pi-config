/**
 * render.ts — タスク進捗の表示行生成 (純関数・色情報なし)。
 *
 * - buildWidgetRows: エディタ上部ウィジェット用のコンパクトな epic サマリ
 * - buildProgressText: /progress コマンド用の詳細一覧
 *
 * ウィジェットの予算配分:
 *   1. すべての epic ヘッダを優先表示 (budget まで)
 *   2. 残り行数でサブ行 (in progress → blocked → pending) を追加
 *   3. 未分類・孤立タスクの集約行
 */

import { isBlocked, type EpicGroup, type EpicSummary } from "./selectors.ts";
import type { Task } from "./model.ts";

/** ウィジェット行。色/アイコンは呼び出し側 (index.ts) で theme を適用する。 */
export type WidgetRow = {
	text: string;
	color: "accent" | "dim" | "warning" | "success";
	icon?: string;
};

export interface WidgetRowsResult {
	rows: WidgetRow[];
	/** 予算超過で省略された epic 数。 */
	hiddenEpics: number;
	/** 予算超過で省略された子タスク数。 */
	hiddenTasks: number;
}

const STATUS_LABEL: Record<string, string> = {
	completed: "completed",
	in_progress: "in progress",
	pending: "pending",
	blocked: "blocked",
};

function buildById(summary: EpicSummary): Map<number, Task> {
	const m = new Map<number, Task>();
	for (const g of summary.epics) {
		m.set(g.epic.id, g.epic);
		for (const c of g.children) m.set(c.id, c);
	}
	for (const t of summary.uncategorized) m.set(t.id, t);
	for (const t of summary.orphanChildren) m.set(t.id, t);
	return m;
}

/** 子タスク 1 行。blockedBy があって未完了なら blocked 表示。 */
function childLine(t: Task, byId: Map<number, Task>): string {
	const blocked = t.status !== "completed" && isBlocked(t, byId);
	const label = blocked ? "blocked" : (STATUS_LABEL[t.status] ?? t.status);
	let line = `#${t.id} ${label.padEnd(11)} ${t.subject}`;
	if (t.status === "in_progress" && t.activeForm)
		line += `  (working on: ${t.activeForm})`;
	if (!blocked) {
		const blocks = (t.blockedBy ?? []).map((id) => `#${id}`).join(",");
		if (blocks) line += `  ⛓ ${blocks}`;
	}
	return line;
}

interface SubUnit {
	row: WidgetRow;
	tasks: number;
}

function buildSubUnits(g: EpicGroup): SubUnit[] {
	const units: SubUnit[] = [];
	if (g.inProgress) {
		const t = g.inProgress;
		units.push({
			row: {
				text: `in progress: ${t.subject}${t.activeForm ? ` (${t.activeForm})` : ""}`,
				color: "accent",
				icon: "●",
			},
			tasks: 1,
		});
	}
	for (const b of g.blocked) {
		units.push({
			row: { text: `blocked: ${b.subject}`, color: "warning", icon: "⛓" },
			tasks: 1,
		});
	}
	if (g.pending.length > 0) {
		units.push({
			row: { text: `${g.pending.length} pending`, color: "dim", icon: "·" },
			tasks: g.pending.length,
		});
	}
	return units;
}

export function buildWidgetRows(
	summary: EpicSummary,
	budget: number,
): WidgetRowsResult {
	const rows: WidgetRow[] = [];
	let hiddenEpics = 0;
	let hiddenTasks = 0;
	if (budget < 1) {
		return {
			rows,
			hiddenEpics: summary.epics.length,
			hiddenTasks: summary.total - summary.done,
		};
	}

	// フォールバック: epic が無いフラットリスト → 全体を 1 行に集約。
	// (ヘッダの Progress (done/total) は index.ts 側で visibleCount/doneCount
	// を使うので、ここではタスク数と進行中タスクの行のみ生成する)
	if (summary.epics.length === 0 && summary.visibleCount > 0) {
		rows.push({
			text: `${summary.visibleCount} tasks (no epics)`,
			color: "dim",
			icon: "○",
		});
		const inProgress = [...summary.uncategorized, ...summary.orphanChildren].find(
			(t) => t.status === "in_progress",
		);
		if (inProgress && budget >= 2) {
			rows.push({
				text: `in progress: ${inProgress.subject}${inProgress.activeForm ? ` (${inProgress.activeForm})` : ""}`,
				color: "accent",
				icon: "●",
			});
		}
		return { rows, hiddenEpics: 0, hiddenTasks: 0 };
	}

	// フェーズ 1: epic ヘッダ (budget まで全件)
	const shown: EpicGroup[] = [];
	for (const g of summary.epics) {
		if (shown.length < budget) {
			rows.push({
				text: `${g.epic.subject} (${g.done}/${g.children.length})`,
				color: "accent",
			});
			shown.push(g);
		} else {
			hiddenEpics++;
			hiddenTasks += Math.max(0, g.children.length - g.done);
		}
	}

	// フェーズ 2: 残り予算でサブ行
	let rest = budget - rows.length;
	for (const g of shown) {
		if (rest <= 0) break;
		for (const unit of buildSubUnits(g)) {
			if (rest > 0) {
				rows.push(unit.row);
				rest--;
			} else {
				hiddenTasks += unit.tasks;
			}
		}
	}
	// shown のうち rest 耗尽後に残ったサブ行タスク
	for (const g of shown) {
		if (rest >= 0) continue;
		for (const unit of buildSubUnits(g)) {
			if (rest < 0) {
				hiddenTasks += unit.tasks;
			}
		}
	}

	// フェーズ 3: 未分類・孤立タスクの集約行
	const extraTasks =
		summary.uncategorized.length + summary.orphanChildren.length;
	if (extraTasks > 0 && rest > 0) {
		rows.push({ text: `${extraTasks} uncategorized`, color: "dim", icon: "○" });
	} else if (extraTasks > 0) {
		hiddenTasks += extraTasks;
	}

	return { rows, hiddenEpics, hiddenTasks };
}

/** /progress コマンド出力。epicId が指定されていればその epic のみ。 */
export function buildProgressText(
	summary: EpicSummary,
	epicId?: number,
): string[] {
	const lines: string[] = [];
	const byId = buildById(summary);
	let epics = summary.epics;
	if (epicId !== undefined) epics = epics.filter((g) => g.epic.id === epicId);

	for (const g of epics) {
		lines.push(
			`Epic #${g.epic.id}: ${g.epic.subject} (${g.done}/${g.children.length})`,
		);
		if (g.epic.activeForm) lines.push(`  · working on: ${g.epic.activeForm}`);
		for (const c of g.children) {
			lines.push(`  ${childLine(c, byId)}`);
		}
		lines.push("");
	}

	if (epicId === undefined) {
		if (summary.orphanChildren.length > 0) {
			lines.push("Orphan children (epic not found):");
			for (const t of summary.orphanChildren)
				lines.push(`  ${childLine(t, byId)}`);
			lines.push("");
		}
		if (summary.uncategorized.length > 0) {
			lines.push("Uncategorized:");
			for (const t of summary.uncategorized) {
				lines.push(
					`  #${t.id} ${STATUS_LABEL[t.status] ?? t.status}  ${t.subject}${t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : ""}`,
				);
			}
			lines.push("");
		}
	}

	if (lines.length === 0) lines.push("No tasks yet. Ask the agent to add some!");

	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}
