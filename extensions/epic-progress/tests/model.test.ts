import { test } from "node:test";
import assert from "node:assert/strict";
import {
	EMPTY_STATE,
	isTaskDetails,
	replayFromBranch,
	visibleTasks,
	type TaskState,
} from "../model.ts";

test("replayFromBranch returns EMPTY_STATE when branch has no todo results", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", content: "ok" } },
	];
	const state = replayFromBranch(branch);
	assert.deepEqual(state, EMPTY_STATE);
});

test("replayFromBranch picks the LAST matching todo toolResult (last-write-wins)", () => {
	const branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "create",
					params: {},
					tasks: [{ id: 1, subject: "first", status: "pending" }],
					nextId: 2,
				},
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "update",
					params: {},
					tasks: [
						{ id: 1, subject: "first", status: "completed" },
						{ id: 2, subject: "second", status: "in_progress" },
					],
					nextId: 3,
				},
			},
		},
	];
	const state = replayFromBranch(branch);
	assert.equal(state.nextId, 3);
	assert.equal(state.tasks.length, 2);
	assert.equal(state.tasks[0].status, "completed");
});

test("replayFromBranch ignores non-todo toolResults and malformed details", () => {
	const branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "bash",
				details: { anything: true },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { not: "a details shape" },
			},
		},
	];
	const state = replayFromBranch(branch);
	assert.deepEqual(state, EMPTY_STATE);
});

test("replayFromBranch deep-copies tasks (no aliasing)", () => {
	const branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "create",
					params: {},
					tasks: [{ id: 1, subject: "s", status: "pending" }],
					nextId: 2,
				},
			},
		},
	];
	const state = replayFromBranch(branch);
	state.tasks[0].status = "completed";
	assert.equal(
		(branch[0] as { message: { details: { tasks: Array<{ status: string }> } } })
			.message.details.tasks[0].status,
		"pending",
	);
});

test("isTaskDetails validates the envelope shape", () => {
	assert.ok(
		isTaskDetails({ action: "create", params: {}, tasks: [], nextId: 1 }),
	);
	assert.ok(!isTaskDetails(null));
	assert.ok(!isTaskDetails({ tasks: [] }));
	assert.ok(!isTaskDetails({ tasks: "nope", nextId: 1 }));
	assert.ok(!isTaskDetails({ tasks: [], nextId: "1" }));
});

test("visibleTasks excludes deleted tombstones", () => {
	const state: TaskState = {
		nextId: 4,
		tasks: [
			{ id: 1, subject: "a", status: "completed" },
			{ id: 2, subject: "b", status: "deleted" },
			{ id: 3, subject: "c", status: "pending" },
		],
	};
	const visible = visibleTasks(state);
	assert.deepEqual(
		visible.map((t) => t.id),
		[1, 3],
	);
});
