import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgressText, buildWidgetRows } from "../render.ts";
import { computeEpicSummary } from "../selectors.ts";
import type { Task, TaskState } from "../model.ts";

function task(partial: Partial<Task> & Pick<Task, "id" | "subject">): Task {
	return { status: "pending", ...partial };
}

function state(tasks: Task[]): TaskState {
	return { tasks, nextId: tasks.length + 1 };
}

function summaryOf(tasks: Task[]) {
	return computeEpicSummary(state(tasks));
}

test("buildWidgetRows renders compact per-epic summary", () => {
	const summary = summaryOf([
		task({ id: 1, subject: "Add caching layer" }),
		task({
			id: 2,
			subject: "impl",
			status: "in_progress",
			activeForm: "designing cache key",
			metadata: { epic: 1 },
		}),
		task({
			id: 3,
			subject: "integration test",
			blockedBy: [2],
			metadata: { epic: 1 },
		}),
		task({ id: 4, subject: "docs", metadata: { epic: 1 } }),
	]);
	const { rows, hiddenEpics, hiddenTasks } = buildWidgetRows(summary, 10);
	assert.deepEqual(
		rows.map((r) => r.text),
		[
			"Add caching layer (0/3)",
			"in progress: impl (designing cache key)",
			"blocked: integration test",
			"1 pending",
		],
	);
	assert.equal(hiddenEpics, 0);
	assert.equal(hiddenTasks, 0);
});

test("buildWidgetRows caps at budget: epic headers first, surplus hidden", () => {
	const summary = summaryOf([
		task({ id: 1, subject: "Epic A" }),
		task({ id: 2, subject: "a1", metadata: { epic: 1 } }),
		task({ id: 3, subject: "Epic B" }),
		task({ id: 4, subject: "b1", metadata: { epic: 3 } }),
		task({ id: 5, subject: "Epic C" }),
		task({ id: 6, subject: "c1", metadata: { epic: 5 } }),
	]);
	// budget 3 → 3 epic ヘッダのみ (サブ行なし)
	const { rows, hiddenEpics, hiddenTasks } = buildWidgetRows(summary, 3);
	assert.deepEqual(
		rows.map((r) => r.text),
		["Epic A (0/1)", "Epic B (0/1)", "Epic C (0/1)"],
	);
	assert.equal(hiddenEpics, 0);
	assert.equal(hiddenTasks, 0);
	// budget 2 → 2 epic ヘッダ + 1 epic 隠し (残1子)
	const tight = buildWidgetRows(summary, 2);
	assert.equal(tight.rows.length, 2);
	assert.equal(tight.hiddenEpics, 1);
	assert.equal(tight.hiddenTasks, 1);
});

test("buildWidgetRows prefers in-progress subline under tight budget", () => {
	const summary = summaryOf([
		task({ id: 1, subject: "Epic A" }),
		task({ id: 2, subject: "a1", status: "in_progress", metadata: { epic: 1 } }),
		task({ id: 3, subject: "a2", metadata: { epic: 1 } }),
	]);
	const { rows, hiddenTasks } = buildWidgetRows(summary, 2);
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => r.text),
		["Epic A (0/2)", "in progress: a1"],
	);
	assert.equal(hiddenTasks, 1); // pending の a2 が省略
});

test("buildWidgetRows aggregates uncategorized into one row", () => {
	const summary = summaryOf([
		task({ id: 9, subject: "solo" }),
		task({ id: 8, subject: "orphan", metadata: { epic: 99 } }),
	]);
	const { rows } = buildWidgetRows(summary, 5);
	assert.equal(rows.length, 1);
	assert.match(rows[0].text, /2 tasks \(no epics\)/);
});

test("buildProgressText lists children with status and block links", () => {
	const summary = summaryOf([
		task({ id: 1, subject: "Add caching layer" }),
		task({
			id: 2,
			subject: "impl",
			status: "in_progress",
			activeForm: "writing tests",
			metadata: { epic: 1 },
		}),
		task({
			id: 3,
			subject: "integration test",
			blockedBy: [2],
			metadata: { epic: 1 },
		}),
	]);
	const lines = buildProgressText(summary);
	assert.deepEqual(lines, [
		"Epic #1: Add caching layer (0/2)",
		"  #2 in progress impl  (working on: writing tests)",
		"  #3 blocked     integration test",
	]);
});

test("buildProgressText filters by epicId", () => {
	const summary = summaryOf([
		task({ id: 1, subject: "Epic A" }),
		task({ id: 2, subject: "a1", metadata: { epic: 1 } }),
		task({ id: 3, subject: "Epic B" }),
		task({ id: 4, subject: "b1", metadata: { epic: 3 } }),
	]);
	const lines = buildProgressText(summary, 1);
	assert.match(lines[0], /Epic #1: Epic A \(0\/1\)$/);
	assert.ok(!lines.some((l) => l.includes("Epic B")));
});

test("buildProgressText shows uncategorized section and empty message", () => {
	const empty = buildProgressText(summaryOf([]));
	assert.deepEqual(empty, ["No tasks yet. Ask the agent to add some!"]);

	const solo = buildProgressText(
		summaryOf([task({ id: 5, subject: "solo", status: "completed" })]),
	);
	assert.deepEqual(solo, ["Uncategorized:", "  #5 completed  solo"]);
});

test("buildWidgetRows falls back to a flat summary when there are no epics", () => {
	const summary = summaryOf([
		task({ id: 1, subject: "preflight", status: "completed" }),
		task({
			id: 2,
			subject: "pilot run",
			status: "in_progress",
			activeForm: "running 3 iterations",
		}),
		task({ id: 3, subject: "docs" }),
	]);
	const { rows, hiddenEpics, hiddenTasks } = buildWidgetRows(summary, 10);
	assert.deepEqual(
		rows.map((r) => r.text),
		["3 tasks (no epics)", "in progress: pilot run (running 3 iterations)"],
	);
	assert.equal(hiddenEpics, 0);
	assert.equal(hiddenTasks, 0);
});

test("buildWidgetRows flat fallback fits one-line budget (no in-progress row)", () => {
	const summary = summaryOf([
		task({ id: 1, subject: "flat", status: "completed" }),
	]);
	const { rows } = buildWidgetRows(summary, 1);
	assert.deepEqual(
		rows.map((r) => r.text),
		["1 tasks (no epics)"],
	);
});

test("buildWidgetRows empty summary stays empty (no fallback row)", () => {
	const { rows } = buildWidgetRows(summaryOf([]), 10);
	assert.deepEqual(rows, []);
});
