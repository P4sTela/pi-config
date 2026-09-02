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
- How to call an agent: `pi --model <provider/model:effort> --fallback-models <provider/model:effort>,... -p '<instructions>'` (left-priority fallback)
  - When a delegated task needs a specific skill, specify it in the prompt: `pi ... -p '/skill:<skill-name> <instructions>'`
- Default model: `openai-codex/gpt-5.6-terra:high`
- Model selection:
  - Difficulty: high
    - Option: `--model 'openai-codex/gpt-5.6-terra:high'`
    - Use for design, difficult debugging, and code reviews requiring high confidence.
  - Difficulty: medium
    - Option: `--model 'opencode-go/deepseek-v4-pro:medium'`
    - Use for general coding tasks such as implementation from an existing design.
  - Difficulty: low
    - Option: `--model 'opencode-go/deepseek-v4-flash:low'`
    - Use for summarizing or extracting data that is too voluminous to handle in a main session with high/medium models.
  - GPT vs DeepSeek V4 Flash — 判断か作業かで選ぶ:
    - **GPT (gpt-5.6-terra) を優先** — 判断型・低トークン・高信頼:
      - アーキテクチャ/設計判断、トレードオフの決定
      - 難解バグの根本原因解析
      - 高信頼が必要なコードレビュー
      - 未経験領域の探索的判断
    - **Flash を優先** — 作業型・高トークン・低コスト:
      - 設計確定後の機械的実装・リファクタ
      - ファイル横断の大量変更、ボイラープレート生成
      - ログ/調査の要約、一次パス
      - lint/テスト修正などの反復ループ(0731 でエージェント性能が大幅強化)
    - **gpt-5.6-luna クラスのタスクは flash で代替する**(flash 0731 は luna の仕事を十分こなす)
    - コスト目安(出力 $/M tokens): terra $12 ≫ luna $0.6〜1.2 ≥ flash $0.28。出力トークンが多いタスクほど flash が有利。
  - Specialty:

    | Model | Best for |
    | ------- | ---------- |
    | `opencode-go/kimi-k2.7-code` | Complex autonomous coding tasks |
    | `opencode-go/glm-5.2` | Front-end / web development |
    | `opencode-go/qwen3.7-max` | High-difficulty reasoning (alt. to Codex) |

- When calling an agent, clearly communicate the background, goal, expected output, and what not to do.

## Environment

- This Mac environment is built with **Nix**. Prefer Nix-managed toolchains over ad-hoc global installs.
- Per-project environments are normally activated via **direnv** (`.envrc`, typically `use flake` / `use nix`), so tools are usually already on `PATH` inside a project directory.
- When a needed tool is missing or you must work outside an activated project, use `nix-shell` / `nix develop` (e.g. `nix-shell -p <pkg>` or `nix develop` for a flake) instead of installing packages globally.
- If a command fails with "command not found", first check whether the project's direnv environment is active before assuming the tool is absent.

## Sandbox (scratch / tmp cleanup)

- Scratch files and build artifacts belong under `<project>/.pi/work/`. `rm -rf` confined to that directory is allowed silently by the permission gate (`extensions/permission-gate.ts`), including headless runs.
- Do not clean shared temporary areas (`/tmp`, `$TMPDIR`, system dirs): the gate still confirms/blocks there so temp files of other processes or users are not nuked by glob overreach.
- Add `.pi/work/` to the project `.gitignore`.

## Web Search and Fetch

- For web search, use the `web_search` tool directly.
- For fetching page content or GitHub repositories, use the `fetch_content` tool directly.
  - GitHub URLs are cloned locally for accurate file access, not scraped as HTML.

## Tool Selection (pi-fff / pi-subagents)

- Prefer the standard `read` / `bash` / `edit` / `write` tools for file reading, shell commands, and editing.
- File search is provided by **pi-fff** (Rust-native, SIMD-accelerated, pre-indexed with frecency ranking):
  - `fffind` — fuzzy path/file search, git-aware, frecency-ranked. Use it first whenever the user names a concept, feature, or symbol to surface the relevant files in one call. Keep queries to 1-2 terms; use it for paths, not content.
  - `ffgrep` — SIMD-accelerated content search. Prefer bare identifiers as patterns (literal queries are most efficient); use `path` for include and `exclude` for noise. Use it for content, not paths.
  - After 1-2 greps, read the top match instead of running more greps.
- For subagent supervisor coordination, prefer `subagent_supervisor` (the native pi-subagents channel). The `intercom` tool is only a compatibility fallback for the separate `pi-intercom` package and should not be used unless something explicitly depends on that name.

## Pi Extension Workflow

- Use `rpiv-todo` as the source of truth for multi-step work: define concrete completion criteria, dependencies, and verification commands before implementation.
- Use `epic-progress` (local extension, integrated with rpiv-todo tasks) when breaking a large goal into subtasks: **create an epic task first, then mark every child with `metadata: { epic: <id> }`**. Tasks created without `metadata.epic` are not counted by the board — they only appear as flat "uncategorized" and the widget falls back to overall progress. This applies to delegated agents too: tell them to attach the epic link when creating tasks. Track `status` / `activeForm` / `blockedBy`; the editor widget and `/progress` show progress (done/total, in-progress, blocked) at a glance.
- Use `pi-subagents` for independent research, implementation, or review work; keep one clear owner per mutable workspace.
- Use `pi-plan` (`/plan`) for read-only exploration and structured plans before implementing. Bind the plan file to the session with `bind_plan` so the dashboard can render it.
- Use `checkpoint-pi` (enabled): it snapshots the full worktree (tracked + untracked) as Git refs at every turn start, creating an automatic "before restore" checkpoint, so you can restore code when a conversation forks and you want to go back.
- Use `pi-review` (`/review`) for a strict maintainer review of the work before considering it done; add focus text to scope it (`/review focus on <area>`).
- Use `ask_user_question` whenever requirements are ambiguous and you cannot proceed without a concrete decision — ask up to 4 structured questions with 2-4 options instead of guessing on material decisions.
- Use `context-mode` when command output, logs, or documentation may be large; summarize or query the data instead of loading it wholesale into the conversation.
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
