/**
 * selectors.ts — todo タスクから epic (親タスク) 単位の進捗構造を集計する純ロジック。
 *
 * 規約: 子タスクは `metadata.epic` に親タスクの id (number) を持つ。
 * epic = 子タスク (metadata.epic) から参照されているタスク。
 */

import { visibleTasks, type Task, type TaskState } from "./model.ts";

/** epic 参照キー。rpiv-todo の Task.metadata に書くキー名。 */
export const EPIC_META_KEY = "epic";

export function epicIdOf(task: Task): number | undefined {
	const v = task.metadata?.[EPIC_META_KEY];
	return typeof v === "number" ? v : undefined;
}

/** このタスクがまだブロックされているか (未完了の依存が存在する)。 */
export function isBlocked(task: Task, byId: Map<number, Task>): boolean {
	if (!task.blockedBy || task.blockedBy.length === 0) return false;
	return task.blockedBy.some((depId) => {
		const dep = byId.get(depId);
		// 依存が存在しない (削除済み・迷子) もブロック扱い。完了済み依存はブロック解除。
		return !dep || dep.status === "pending" || dep.status === "in_progress";
	});
}

export interface EpicGroup {
	/** 親タスク本体。 */
	epic: Task;
	/** metadata.epic = epic.id の可視タスク。 */
	children: Task[];
	/** completed 子タスク数。 */
	done: number;
	/** 進行中 (in_progress) の子タスク。先頭 1 件のみ。 */
	inProgress: Task | undefined;
	/** ブロック中の子タスク (依存未完了)。 */
	blocked: Task[];
	/** 待ち (pending) かつブロックされていない子タスク。 */
	pending: Task[];
}

export interface EpicSummary {
	/** 子を持つタスクのグループ。未完了 epic が先 (in_progress > pending > completed)。 */
	epics: EpicGroup[];
	/** epic 参照も子タスクも持たない通常タスク。 */
	uncategorized: Task[];
	/** metadata.epic が存在しない id を指す孤立子タスク。 */
	orphanChildren: Task[];
	/** 進捗合計 (epic の子のみ対象)。 */
	total: number;
	done: number;
}

const STATUS_RANK: Record<Task["status"], number> = {
	in_progress: 0,
	pending: 1,
	completed: 2,
	deleted: 3,
};

export function computeEpicSummary(state: TaskState): EpicSummary {
	const tasks = visibleTasks(state);
	const byId = new Map<number, Task>(tasks.map((t) => [t.id, t]));

	const children = new Map<number, Task[]>();
	const uncategorized: Task[] = [];
	const orphanChildren: Task[] = [];

	for (const t of tasks) {
		const parentId = epicIdOf(t);
		if (parentId === undefined) {
			uncategorized.push(t);
			continue;
		}
		const parent = byId.get(parentId);
		if (!parent) {
			orphanChildren.push(t);
			continue;
		}
		const arr = children.get(parentId) ?? [];
		arr.push(t);
		children.set(parentId, arr);
	}

	// epic 本体は uncategorized に含まれている (子参照がないから)。
	// 子を持つタスクだけ epic になるので、epic 判定後に uncategorized から除く。
	const epicIds = new Set(children.keys());
	const finalUncategorized = uncategorized.filter((t) => !epicIds.has(t.id));
	const epics: EpicGroup[] = [];
	for (const id of epicIds) {
		const epic = byId.get(id);
		if (!epic) continue; // 子がいるが epic 本体が deleted 等
		const kids = children.get(id)!;
		const done = kids.filter((k) => k.status === "completed").length;
		const inProgress = kids.find((k) => k.status === "in_progress");
		const blocked = kids.filter(
			(k) =>
				(k.status === "pending" || k.status === "in_progress") &&
				isBlocked(k, byId),
		);
		const pending = kids.filter(
			(k) => k.status === "pending" && !blocked.some((b) => b.id === k.id),
		);
		epics.push({ epic, children: kids, done, inProgress, blocked, pending });
	}

	epics.sort(
		(a, b) =>
			STATUS_RANK[a.epic.status] - STATUS_RANK[b.epic.status] ||
			(a.epic.id ?? 0) - (b.epic.id ?? 0),
	);

	const total = epics.reduce((n, g) => n + g.children.length, 0);
	const done = epics.reduce((n, g) => n + g.done, 0);

	return {
		epics,
		uncategorized: finalUncategorized,
		orphanChildren,
		total,
		done,
	};
}

/** ある epic を subject 部分一致で探す (epic 本体と子を subject 検索して id 返却)。 */
export function findEpicId(
	summary: EpicSummary,
	subject: string,
): number | undefined {
	for (const g of summary.epics) {
		if (
			g.epic.subject.includes(subject) ||
			g.children.some((c) => c.subject.includes(subject))
		) {
			return g.epic.id;
		}
	}
	return undefined;
}
