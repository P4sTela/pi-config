/**
 * Permission gate helpers — sandbox rules for the recursive/forced `rm` bypass.
 *
 * No pi imports — this module is deliberately standalone so the logic can be
 * unit-tested without a pi runtime (e.g. `bun run` this file's tests).
 *
 * The sandbox is a dedicated scratch directory per project:
 *   <projectRoot>/.pi/work/  (override: PI_SANDBOX_DIR env var)
 * Recursive/forced `rm` whose targets all resolve inside a sandbox is scratch
 * cleanup and is allowed without prompting (also in headless runs). Everything
 * else keeps the original gate behavior (confirm in TUI, block headless).
 *
 * Sandbox candidates are computed by walking from cwd toward the filesystem
 * root — every `<ancestor>/.pi/work` is a valid sandbox, so cleanup typed from
 * a nested working directory resolves correctly. `isSandboxSafeHardened`
 * additionally resolves symlinks (fs.realpath) so `rm -rf .pi/work/link/`
 * cannot follow a link out of the sandbox.
 *
 * This is a cooperative guard, not a security boundary: deletion paths that
 * bypass `rm` (e.g. `find -delete`, shutil.rmtree) are gated by the gate's
 * pattern list, never silently allowed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Directory name of the per-project scratch sandbox (env PI_SANDBOX_DIR overrides). */
export const SANDBOX_DIR_NAME = ".pi/work";

/** Effective sandbox directory name for this run (env override wins). */
export function sandboxDirName(): string {
  const v = process.env.PI_SANDBOX_DIR?.trim();
  return v && v.length > 0 ? v : SANDBOX_DIR_NAME;
}

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
 * Real path of the deepest EXISTING ancestor of `p`, with the not-yet-existing
 * remainder re-appended. A symlink in the existing part is resolved, so an
 * `rm` that would follow a link out of the sandbox is caught.
 * Returns undefined when even the filesystem root cannot be resolved.
 */
export function realTargetPath(p: string): string | undefined {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return undefined;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Lexical sandbox candidates plus the realpath of the ones that already exist
 * (so a project reached through a symlinked path still matches its own
 * <project>/.pi/work).
 */
export function realCandidates(
  cwd: string,
  sandboxDir: string = SANDBOX_DIR_NAME,
): string[] {
  const lexical = sandboxCandidates(cwd, sandboxDir);
  const out = [...lexical];
  for (const c of lexical) {
    try {
      out.push(fs.realpathSync(c));
    } catch {
      // not created yet — lexical form stays
    }
  }
  return out;
}

/**
 * Fs-hardened sandbox check: the pure containment test plus symlink-safe
 * realpath verification of every target. This is what the gate calls.
 */
export function isSandboxSafeHardened(
  command: string,
  cwd: string,
  sandboxDir: string = SANDBOX_DIR_NAME,
): boolean {
  if (!isSandboxSafe(command, cwd, sandboxDir)) return false;
  const targets = extractRmTargets(command);
  const cands = realCandidates(cwd, sandboxDir);
  for (const t of targets) {
    const head = globHead(t);
    if (head === undefined) return false; // bare glob
    if (hasDotDotAfterGlob(t)) return false;
    const resolved = path.resolve(cwd, expandTilde(head));
    const hasGlob = firstGlobIndex(t) >= 0;
    let real: string | undefined;
    if (!hasGlob && !/[\\/]$/.test(t)) {
      // Plain target, no trailing separator: when the final component is a
      // symlink, `rm` removes the LINK itself (safe) — resolve the parent.
      // With a trailing slash or a glob, `rm` follows the link, so the link
      // target must stay inside the sandbox.
      let isLink = false;
      try {
        isLink = fs.lstatSync(resolved).isSymbolicLink();
      } catch {
        // not present yet — parent resolution below handles it
      }
      real = isLink
        ? realTargetPath(path.dirname(resolved))
        : realTargetPath(resolved);
    } else {
      real = realTargetPath(resolved);
    }
    if (real === undefined || !containedInCandidates(real, cands)) {
      return false;
    }
  }
  return true;
}

/**
 * No-op factory: pi auto-loads every `extensions/*.ts` and requires a
 * default-exported factory. This module exists only to be imported by
 * permission-gate.ts, so it registers nothing here.
 */
export default function (): void {}
