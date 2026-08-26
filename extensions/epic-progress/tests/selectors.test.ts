import { test } from "node:test";
import assert from "node:assert/strict";
import {
	EPIC_META_KEY,
	computeEpicSummary,
	epicIdOf,
	findEpicId,
	isBlocked,
} from "../selectors.ts";
import type { Task, TaskState } from "../model.ts";

function task(partial: Partial<Task> & Pick<Task, "id" | "subject">): Task {
	return { status: "pending", ...partial };
}

function state(tasks: Task[]): TaskState {
	return { tasks, nextId: tasks.length + 1 };
}

test("epicIdOf reads metadata.epic only when numeric", () => {
	assert.equal(epicIdOf(task({ id: 1, subject: "a" })), undefined);
	assert.equal(epicIdOf(task({ id: 1, subject: "a", metadata: { [EPIC_META_KEY]: 3 } })), 3);
	assert.equal(epicIdOf(task({ id: 1, subject: "a", metadata: { [EPIC_META_KEY]: "3" } })), undefined);
});

test("isBlocked: blocked by any non-completed dependency", () => {
	const byId = new Map<number, Task>();
	byId.set(1, task({ id: 1, subject: "dep pending", status: "pending" }));
	byId.set(2, task({ id: 2, subject: "dep done", status: "completed" }));

	assert.ok(isBlocked(task({ id: 9, subject: "t", blockedBy: [1] }), byId));
	assert.ok(!isBlocked(task({ id: 9, subject: "t", blockedBy: [2] }), byId));
	assert.ok(isBlocked(task({ id: 9, subject: "t", blockedBy: [2, 1] }), byId));
	assert.ok(!isBlocked(task({ id: 9, subject: "t" }), byId));
	// 存在しない依存 id もブロック扱い
	assert.ok(isBlocked(task({ id: 9, subject: "t", blockedBy: [999] }), byId));
});

test("computeEpicSummary groups children under epic and computes progress", () => {
	const s = state([
		task({ id: 1, subject: "Epic A" }),
		task({ id: 2, subject: "child1", status: "completed", metadata: { [EPIC_META_KEY]: 1 } }),
		task({ id: 3, subject: "child2", status: "in_progress", activeForm: "working", metadata: { [EPIC_META_KEY]: 1 } }),
		task({ id: 4, subject: "child3", metadata: { [EPIC_META_KEY]: 1 } }),
	]);
	const summary = computeEpicSummary(s);
	assert.equal(summary.epics.length, 1);
	const group = summary.epics[0];
	assert.equal(group.epic.id, 1);
	assert.equal(group.children.length, 3);
	assert.equal(group.done, 1);
	assert.equal(group.inProgress?.id, 3);
	assert.equal(group.pending.map((t) => t.id).join(","), "4");
	assert.equal(summary.total, 3);
	assert.equal(summary.done, 1);
	assert.deepEqual(summary.uncategorized, []);
});

test("epic itself is excluded from uncategorized when it has no children", () => {
	const s = state([
		task({ id: 1, subject: "solo task" }),
		task({ id: 2, subject: "child", metadata: { [EPIC_META_KEY]: 1 } }),
	]);
	const summary = computeEpicSummary(s);
	assert.equal(summary.epics.length, 1); // 1 は子を持つので epic
	assert.deepEqual(summary.uncategorized.map((t) => t.id), []);
});

test("orphan children (metadata.epic points to missing id) are separated", () => {
	const s = state([
		task({ id: 2, subject: "orphan", metadata: { [EPIC_META_KEY]: 99 } }),
		task({ id: 3, subject: "normal" }),
	]);
	const summary = computeEpicSummary(s);
	assert.equal(summary.epics.length, 0);
	assert.equal(summary.orphanChildren.length, 1);
	assert.deepEqual(summary.uncategorized.map((t) => t.id), [3]);
});

test("blocked children are counted as blocked, not pending", () => {
	const s = state([
		task({ id: 1, subject: "Epic A" }),
		task({ id: 2, subject: "prereq", status: "in_progress", metadata: { [EPIC_META_KEY]: 1 } }),
		task({ id: 3, subject: "waiting", blockedBy: [2], metadata: { [EPIC_META_KEY]: 1 } }),
	]);
	const summary = computeEpicSummary(s);
	const group = summary.epics[0];
	assert.equal(group.blocked.length, 1);
	assert.equal(group.blocked[0].id, 3);
	assert.equal(group.pending.length, 0);
});

test("epics sort: in_progress first, then pending, then completed", () => {
	const s = state([
		task({ id: 1, subject: "done epic", status: "completed" }),
		task({ id: 2, subject: "child of done", status: "completed", metadata: { [EPIC_META_KEY]: 1 } }),
		task({ id: 3, subject: "active epic", status: "in_progress" }),
		task({ id: 4, subject: "child of active", status: "pending", metadata: { [EPIC_META_KEY]: 3 } }),
	]);
	const summary = computeEpicSummary(s);
	assert.deepEqual(summary.epics.map((g) => g.epic.id), [3, 1]);
});

test("findEpicId matches epic or child subject substring", () => {
	const s = state([
		task({ id: 1, subject: "Add caching layer" }),
		task({ id: 2, subject: "impl", metadata: { [EPIC_META_KEY]: 1 } }),
	]);
	const summary = computeEpicSummary(s);
	assert.equal(findEpicId(summary, "caching"), 1);
	assert.equal(findEpicId(summary, "impl"), 1);
	assert.equal(findEpicId(summary, "nothing"), undefined);
});

test("deleted children are excluded from counts", () => {
	const s = state([
		task({ id: 1, subject: "Epic A" }),
		task({ id: 2, subject: "gone", status: "deleted", metadata: { [EPIC_META_KEY]: 1 } }),
		task({ id: 3, subject: "alive", status: "completed", metadata: { [EPIC_META_KEY]: 1 } }),
	]);
	const summary = computeEpicSummary(s);
	const group = summary.epics[0];
	assert.equal(group.children.length, 1);
	assert.equal(group.done, 1);
});