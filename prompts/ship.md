---
description: Validate and finish the current change before handoff
argument-hint: "[extra validation]"
---
# Ship the current change

Finish the current task and prepare it for handoff. If extra validation was requested, include it: $@.

- Inspect the current diff and preserve unrelated user changes.
- Run the narrowest useful type checks, tests, and lint/format checks.
- Fix failures that are directly related to the current task; do not expand scope.
- Run `git diff --check` and report exactly what was validated.
- Do not commit, push, or reset anything unless explicitly asked.

End with a concise summary of changed files, validation commands, and remaining risks.
