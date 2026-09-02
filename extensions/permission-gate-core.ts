/**
 * Pure helpers for the permission gate's sandbox bypass.
 *
 * No pi imports — this module is deliberately standalone so the logic can be
 * unit-tested without a pi runtime (e.g. `bun run` this file's tests).
 *
 * The sandbox is a dedicated scratch directory per project:
 *   <projectRoot>/.pi/work/
 * Recursive/forced `rm` whose targets all resolve inside a sandbox is scratch
 * cleanup and is allowed without prompting (also in headless runs). Everything
 * else keeps the original gate behavior (confirm in TUI, block headless).
 */
import * as os from "node:os";
import * as path from "node:path";

/** Directory name of the per-project scratch sandbox. */
export const SANDBOX_DIR_NAME = ".pi/work";

/** `rm` must carry a recursive (-r/-R) or forced (-f) flag to be gated at all. */
export const RM_RECURSIVE_FORCE_PATTERN =
  /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf]/;

/** Shell tokens that terminate a statement or redirect (operand scan stops here). */
const SEPARATORS = new Set([
  ";",
  "&&",
  "||",
  "|",
  "&",
  "(",
  ")",
  "<",
  ">",
  ">>",
]);

/**
 * Shell-like tokenizer: collapses whitespace, strips quotes, honors backslash
 * escapes, keeps `*?[]$` literals, and emits separators as standalone tokens.
 * A quoted token with embedded spaces survives as one token.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    // `#` starts a comment when it begins a word.
    if (c === "#") {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    let token = "";
    while (i < n) {
      const ch = command[i];
      if (ch === " " || ch === "\t" || ch === "\n") break;
      if (ch === "\\" && i + 1 < n) {
        token += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === "'") {
        i++;
        while (i < n && command[i] !== "'") {
          token += command[i];
          i++;
        }
        i++; // closing quote
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < n) {
          const q = command[i];
          if (q === '"') {
            i++;
            break;
          }
          if (
            q === "\\" &&
            i + 1 < n &&
            (command[i + 1] === '"' ||
              command[i + 1] === "\\" ||
              command[i + 1] === "$" ||
              command[i + 1] === "`")
          ) {
            token += command[i + 1];
            i += 2;
            continue;
          }
          token += q;
          i++;
        }
        continue;
      }
      // Multi-char and single-char statement separators become standalone tokens.
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ">>") {
        if (token.length > 0) {
          tokens.push(token);
          token = "";
        }
        tokens.push(two);
        i += 2;
        continue;
      }
      if (";&|()<>".includes(ch)) {
        if (token.length > 0) {
          tokens.push(token);
          token = "";
        }
        tokens.push(ch);
        i++;
        continue;
      }
      token += ch;
      i++;
    }
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

/**
 * Collect the operand (target) tokens of every `rm` invocation in the command.
 * Flags are skipped (unless `--` ended flag parsing); scanning stops at
 * statement separators. Used only to decide sandbox safety, so over-collection
 * is written to fail closed (extra targets -> gate).
 */
export function extractRmTargets(command: string): string[] {
  const targets: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    const tokens = tokenizeCommand(line);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const isRm = t === "rm" || t.endsWith("/rm");
      if (!isRm) continue;
      let flagPhase = true;
      for (let j = i + 1; j < tokens.length; j++) {
        const tok = tokens[j];
        if (SEPARATORS.has(tok)) break;
        if (flagPhase && tok.startsWith("-") && tok !== "--") continue;
        if (tok === "--") {
          flagPhase = false;
          continue;
        }
        targets.push(tok);
      }
    }
  }
  return targets;
}

/** First index of a glob character (`*`, `?`, `[`) in the target, else -1. */
function firstGlobIndex(target: string): number {
  return target.search(/[*?[]/);
}

/**
 * Resolve the path head before the first glob character.
 * - No glob: the whole target.
 * - Target starts with a glob: undefined — cannot prove containment.
 * - Otherwise the leading path portion (glob expansion is confined to it).
 */
export function globHead(target: string): string | undefined {
  const idx = firstGlobIndex(target);
  if (idx < 0) return target;
  if (idx === 0) return undefined;
  const head = target.slice(0, idx);
  // Strip the trailing separator directly before the glob (`.pi/work/*` -> `.pi/work`);
  // path resolution treats both identically.
  return head.length > 1 ? head.replace(/[/\\]+$/, "") : head;
}

/**
 * True when a `..` component appears after the first glob character.
 * A glob target that then walks upward could resolve outside the sandbox after
 * shell glob expansion, so such targets must not be blindly allowed.
 */
export function hasDotDotAfterGlob(target: string): boolean {
  const idx = firstGlobIndex(target);
  if (idx < 0) return false;
  return target.slice(idx).includes("..");
}

/** Walk from cwd toward the filesystem root, yielding `<dir>/.pi/work`. */
export function sandboxCandidates(
  cwd: string,
  sandboxDir: string = SANDBOX_DIR_NAME,
): string[] {
  const out: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    out.push(path.join(dir, sandboxDir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return path.join(os.homedir(), p.slice(2));
  return p;
}

function isInsideOrEqual(p: string, root: string): boolean {
  const r = path.resolve(root);
  return p === r || p.startsWith(r + path.sep);
}

function containedInCandidates(p: string, candidates: string[]): boolean {
  return candidates.some((c) => isInsideOrEqual(p, c));
}

function targetIsInside(
  target: string,
  cwd: string,
  candidates: string[],
): boolean {
  const head = globHead(target);
  if (head === undefined) return false; // bare glob like `*` — fail closed
  if (hasDotDotAfterGlob(target)) return false;
  const resolved = path.resolve(cwd, expandTilde(head));
  return containedInCandidates(resolved, candidates);
}

/**
 * True when every `rm` target of `command` resolves inside a sandbox candidate.
 * Empty target list (e.g. `rm -rf` with no operands) fails closed.
 */
export function isSandboxSafe(
  command: string,
  cwd: string,
  sandboxDir: string = SANDBOX_DIR_NAME,
): boolean {
  const targets = extractRmTargets(command);
  if (targets.length === 0) return false;
  const candidates = sandboxCandidates(cwd, sandboxDir);
  return targets.every((t) => targetIsInside(t, cwd, candidates));
}

/**
 * No-op factory: pi auto-loads every `extensions/*.ts` and requires a
 * default-exported factory. This module exists only to be imported by
 * permission-gate.ts, so it registers nothing here.
 */
export default function (): void {}
