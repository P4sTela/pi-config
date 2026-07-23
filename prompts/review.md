---
description: Review the current worktree for concrete issues without editing
argument-hint: "[focus]"
---
# Review the current worktree

Review the current worktree and diff. If a focus was provided, prioritize it: $@.

Do not modify project files. Inspect the actual diff and relevant callers/tests. Look for:

- correctness bugs and regressions
- missing or misleading tests
- security and data-loss risks
- type, error-handling, and edge-case problems
- unnecessary complexity or scope creep

Return only evidence-backed findings, ranked by severity, with file and line references. If there are no actionable findings, say so clearly.
