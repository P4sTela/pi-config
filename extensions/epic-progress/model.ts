/**
 * model.ts — rpiv-todo 互換のタスクモデルと、セッション履歴からの復元 (replay)。
 *
 * 実行時依存なしの純粋ロジック。`tool_execution_end` イベントの
 * `event.result.details` (TaskDetails) と、`ctx.sessionManager.getBranch()` の
 * 履歴からタスク状態を再構築する。rpiv-todo の `state/replay.ts` と同一の
 * last-write-wins 方式。
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/** rpiv-todo の `todo` ツール成功時の details ペイロード (互換形状)。 */
export interface TaskDetails {
	action: string;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/** details エンベロープが TaskDetails 形状か (brunch の古い/破損エントリを弾く)。 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Branch を時系列順に走査し、最後の `todo` toolResult の details を返す。
 * 該当なしは EMPTY_STATE。
 */
export function replayFromBranch(branch: Iterable<unknown>): TaskState {
	let result: TaskState = { tasks: [], nextId: EMPTY_STATE.nextId };
	for (const entry of branch) {
		const e = entry as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e?.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		result = {
			tasks: msg.details.tasks.map((t) => ({ ...t })),
			nextId: msg.details.nextId,
		};
	}
	return result;
}

/** 可視タスク (deleted tombstone を除く)。 */
export function visibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}
