# AGENTS.md (User Scoped)

## Communication and Language

- User communication: Japanese (日本語)
- Documentation and code comments: Preserve the existing language; do not translate them.

## Skills Guidelines

- AGENTS.md assumes progressive disclosure: it contains only the minimum information needed, while task-specific knowledge and guidelines live elsewhere.
- Select and load the necessary skills as needed for each task.

## Coding Style

- Maintain separation of concerns.
- Separate state from logic.
- Prioritize readability and maintainability.
- Follow t-wada-style TDD: implement while continuously verifying behavior with type checking and tests.
- Define contract layers (APIs/types) rigorously using ADTs, and keep implementation layers regenerable.
- Rules that can be checked statically should be expressed with the environment's linter or ast-grep, not in prompts.

## Agent Delegation

- To keep context clean and preserve accuracy, speed, and cost efficiency, proactively delegate yak shaving and work outside the current focus to an appropriate model agent.
  - Good example: When asked to implement something, delegate design, review, or behavior verification to other agents.
  - Bad example: When encountering a deep-rooted error, trying to solve it yourself without launching a debugging agent.
- How to call an agent: `pi --model <provider/model:effort> -p '<instructions>'`
  - NOTE (re-verified 2026-11-14 on pi 1.5.2): `--fallback-models` is NOT a pi option (`Unknown option`). For fallback, retry in a wrapper: `pi --model A -p '...' </dev/null || pi --model B -p '...' </dev/null`. Re-add this flag only after verifying it exists in the installed pi (`pi --help | grep fallback`).
  - When a delegated task needs a specific skill, specify it in the prompt: `pi ... -p '/skill:<skill-name> <instructions>'`
- Model selection — decide by task type. Do not hardcode prices or version-dated capability claims in this file; they decay. Resolve model availability and pricing from `settings.json` (`enabledModels`, `subagents`) and the live catalog (`models-store.json`). The names below are current picks per role, not constants.
  - Judgment-type (high confidence, few output tokens): architecture/design decisions, hard-debugging root-cause analysis, code reviews you must trust, unfamiliar exploration.
    - Current pick: `opencode-go/hy4:high` (reviews, routine judgment). Option: `--model 'opencode-go/hy4:high'`
    - Hardest calls only (small monthly allowance, a few tasks per month each): `opencode-go/gemini-4-argon:high`, `opencode-go/kimi-k3.1-pro:high`.
  - Work-type (high tokens, low unit cost): mechanical implementation from a fixed design, cross-file bulk edits / boilerplate, log or investigation summarization, lint/test fix loops.
    - Current pick: `opencode-go/deepseek-v4.1-flash:max` (also the session default; largest allowance; startup level set via `modelThinkingLevels`)
    - Cheap exploration / summarization on a separate allowance: `opencode-go/gpt-6-luna:max`
    - Re-check the catalog periodically for the best entry in this lane (newer/cheaper candidates appear over time).
  - Subagents: defaults come from `settings.json` (`subagents.defaultModel` / `defaultThinking` / `agentOverrides`). Do not state model advice here that contradicts them.
  - OpenCode Go allowances are per model (5-hour 20% / weekly 50% of the monthly limit). When one model is exhausted, switch to another model in the same lane rather than waiting.
  - `anthropic/*` draws from the Claude Pro plan limits (5-hour session and weekly; verified 2026-11-14 via the OAuth usage endpoint with extra usage disabled). The allowance is small, so do not delegate to it unless the user asks.

- When calling an agent, clearly communicate the background, goal, expected output, and what not to do.

## Environment

- This Mac environment is built with **Nix**. Prefer Nix-managed toolchains over ad-hoc global installs.
- Per-project environments are normally activated via **direnv** (`.envrc`, typically `use flake` / `use nix`), so tools are usually already on `PATH` inside a project directory.
- When a needed tool is missing or you must work outside an activated project, use `nix-shell` / `nix develop` (e.g. `nix-shell -p <pkg>` or `nix develop` for a flake) instead of installing packages globally.
- If a command fails with "command not found", first check whether the project's direnv environment is active before assuming the tool is absent.

## Sandbox (scratch / tmp cleanup)

- Scratch files and build artifacts belong under `<project>/.pi/work/`. `rm -rf` confined to that directory is allowed silently by the permission gate (`extensions/permission-gate.ts`), including headless runs. To relocate it for a run, set `PI_SANDBOX_DIR` (e.g. `PI_SANDBOX_DIR=scratch pi …`) — the gate then allows `rm -rf` under `<project>/$PI_SANDBOX_DIR`.
- Do not clean shared temporary areas (`/tmp`, `$TMPDIR`, system dirs): the gate still confirms/blocks there so temp files of other processes or users are not nuked by glob overreach.
- Add `.pi/work/` to the project `.gitignore`.

## Web Search and Fetch

- For web search, use the `web_search` tool directly.
- For fetching page content or GitHub repositories, use the `fetch_content` tool directly.
  - GitHub URLs are cloned locally for accurate file access, not scraped as HTML.

## Tool Selection

- Prefer the standard `read` / `bash` / `edit` / `write` tools for file reading, shell commands, and editing.
- Search files with `rg` (content) and `fd` (paths) via `bash`. After 1-2 searches, read the top match instead of searching more.
- For subagent supervisor coordination, prefer `subagent_supervisor` (the native pi-subagents channel). The `intercom` tool is only a compatibility fallback for the separate `pi-intercom` package and should not be used unless something explicitly depends on that name.

## Pi Extension Workflow

- Use `pi-subagents` for independent research, implementation, or review work; keep one clear owner per mutable workspace.
- Use `ask_user_question` whenever requirements are ambiguous and you cannot proceed without a concrete decision — ask up to 4 structured questions with 2-4 options instead of guessing on material decisions.
- Use `pi-lens` diagnostics and project tests after edits. Do not consider a task complete while blocking diagnostics or test failures remain.
- Prefer small, reviewable Git checkpoints for long tasks. Keep unrelated pre-existing changes separate from task commits.
- Treat third-party extensions as code with full user-level access; review permissions and source before adding new packages. Prefer existing extensions over adding overlapping orchestration or permission layers.

## Long-running Tasks and Development Servers

- Do not start long-running processes such as development servers, watchers, or daemons directly from the CLI; use **`pueue`** instead.
- Start them with `pueue add -- <command>`, and use `pueue status` / `pueue log` / `pueue follow` / `pueue kill` / `pueue remove` to check status or manage them.
- For parallel agent delegation, queue tasks via pueue:

  ```bash
  pueue add -i --print-task-id -- "pi ... -p '<instruction>' < /dev/null"
  ```

  ```bash
  pueue status
  pueue wait <task-id> # blocks when there is no other parallel work
  pueue log <task-id>  # check results/status
  ```

## ブラウザ操作（browser-use）

- `~/.agents/skills/browser-use` にスキルあり（CLI は `browser-use`、Python を stdin に流す方式）
- 実行前に専用 Chromium を起動する: `chromium-agents`（CDP `http://127.0.0.1:9334`、headless、プロファイルは `~/.local/state/chromium-agents`）
- 対話シェルから起動していれば `~/.secrets` の `BU_CDP_URL` / `BU_NAME=agents` が効く。効いていない環境では明示的に:
  `BU_NAME=agents BU_CDP_URL=http://127.0.0.1:9334 browser-use <<'PY' ... PY`
- ユーザーの普段使い Chrome は remote debugging が無効なので、そのままでは繋がらない（`chrome://inspect` で許可するか、クラウドブラウザを使う）
