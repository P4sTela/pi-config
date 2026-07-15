# OKF v0.1 Spec Summary

Reference card for [Open Knowledge Format v0.1](https://okf.md/spec/). Detail needed only when authoring non-trivial concepts.

## Bundle

Directory tree of markdown files. Distributed as git repo / subdir / tarball.

Reserved filenames (MUST NOT be concept docs):
- `index.md` — directory listing (progressive disclosure), no frontmatter except root `okf_version`
- `log.md` — chronological update history

All other `*.md` = concept documents.

## Concept Frontmatter

```yaml
---
type: <Type>                       # REQUIRED — producer-chosen, not centrally registered
title: <display name>              # recommended; derived from filename if absent
description: <one-line summary>    # recommended; for index/search previews
resource: <URI of underlying asset> # optional
tags: [t1, t2]                     # optional
timestamp: <ISO 8601 datetime>    # optional
# … arbitrary extension keys allowed
---
```

Conformance (§9): concept ⟺ markdown + parseable frontmatter + non-empty `type`. Everything else is soft. Unknown frontmatter keys MUST be preserved. Broken links MUST be tolerated.

## Cross-links

- Absolute (`/...`): bundle-relative — **recommended** (stable under file moves)
- Relative: standard markdown
- Links are untyped edges; relationship meaning conveyed by surrounding prose

## index.md

No frontmatter (root may carry `okf_version: "0.1"`). Sections under `#` headings, entries:
```
* [Title](file.md) - description
```
Should include the linked concept's `description`.

## log.md (optional)

Flat list grouped by `## YYYY-MM-DD` (most recent first). Bold first word convention: `**Update**` / `**Create**` / `**Deprecation**`. Not a git-log replacement.

## Body Conventions

No mandatory sections. Conventional headings:
- `# Schema` — structured field/column descriptions
- `# Examples` — concrete usage
- `# Citations` — numbered external sources backing claims

## Versioning

Minor bump = backward-compatible additions. Major bump = breaking. Root `index.md` may declare `okf_version: "0.1"`; unknown-version consumers MUST best-effort consume.

## Consumer Agent Notes (meta)

OKF's permissive model rewards a **navigator agent** that:
1. scans frontmatter to build a cheap index
2. filters by `type`/`tags`/`timestamp` without reading bodies
3. traverses `related` as a graph
4. reads only the specific 1-2 bodies the question needs

This is exactly what `okf-query.sh` does.