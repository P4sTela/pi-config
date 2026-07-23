import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExecResult = {
	stdout: string;
	code: number;
};

const WIDGET_KEY = "pi-repo-status";
const COMMAND_TIMEOUT_MS = 3000;

async function git(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
): Promise<ExecResult | undefined> {
	try {
		return await pi.exec("git", ["-C", cwd, ...args], {
			timeout: COMMAND_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let refreshInFlight = false;

	const refresh = async (
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	) => {
		if (refreshInFlight || ctx.mode !== "tui") return;
		refreshInFlight = true;

		try {
			const root = await git(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]);
			if (!root || root.code !== 0) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}

			const [branch, status] = await Promise.all([
				git(pi, ctx.cwd, ["branch", "--show-current"]),
				git(pi, ctx.cwd, ["status", "--porcelain=v1"]),
			]);
			const branchName = branch?.stdout.trim() || "detached";
			const changed = status?.stdout.split("\n").filter(Boolean) ?? [];
			const staged = changed.filter(
				(line) => line[0] !== " " && line[0] !== "?",
			).length;
			const unstaged = changed.filter(
				(line) => line[1] !== " " && line[0] !== "?",
			).length;
			const untracked = changed.filter((line) => line.startsWith("??")).length;
			const summary =
				changed.length === 0
					? "clean"
					: `${changed.length} changed (staged ${staged}, unstaged ${unstaged}, untracked ${untracked})`;
			const theme = ctx.ui.theme;
			ctx.ui.setWidget(WIDGET_KEY, [
				theme.fg("muted", `repo ${branchName}`),
				theme.fg(changed.length === 0 ? "success" : "warning", summary),
			]);
		} finally {
			refreshInFlight = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		void refresh(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		void refresh(ctx);
	});
}
