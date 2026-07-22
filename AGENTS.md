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

## Web Search and Fetch

- For web search, use the `web_search` tool directly.
- For fetching page content or GitHub repositories, use the `fetch_content` tool directly.
  - GitHub URLs are cloned locally for accurate file access, not scraped as HTML.

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
