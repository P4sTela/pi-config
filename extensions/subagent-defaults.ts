import * as os from "node:os";
import * as path from "node:path";

type ToolCallEvent = {
	toolName: string;
	input: unknown;
};

type ExtensionAPI = {
	on(event: "tool_call", handler: (event: ToolCallEvent) => void): void;
};

const OUTPUT_AGENTS = new Set([
	"scout",
	"planner",
	"researcher",
	"context-builder",
]);
const DEFAULT_CHAIN_DIR = path.join(os.tmpdir(), "pi-subagent-chain-runs");

/**
 * Keep subagent bookkeeping out of project roots by default. Explicit artifact,
 * chain, and output paths remain authoritative for callers that need persistence.
 */
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;

		const input = event.input as Record<string, unknown>;
		const isSingle =
			typeof input.agent === "string" && typeof input.task === "string";
		const hasChain = Array.isArray(input.chain) && input.chain.length > 0;
		const tasks = Array.isArray(input.tasks)
			? (input.tasks as Array<Record<string, unknown>>)
			: undefined;
		if (hasChain) {
			if (input.chainDir === undefined) input.chainDir = DEFAULT_CHAIN_DIR;
			if (input.artifacts === undefined) input.artifacts = false;
			return;
		}
		if (input.artifacts !== undefined) return;

		if (tasks?.length) {
			const hasExplicitTaskArtifacts = tasks.some(
				(task) => task.output !== undefined || task.progress !== undefined,
			);
			if (hasExplicitTaskArtifacts) return;

			input.artifacts = false;
			for (const task of tasks) {
				task.output = false;
				task.progress = false;
			}
			return;
		}

		if (!isSingle) return;

		input.artifacts = false;
		if (
			input.output === undefined &&
			OUTPUT_AGENTS.has(input.agent as string)
		) {
			input.output = false;
		}
	});
}
