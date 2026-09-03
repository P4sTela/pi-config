// Standalone tests for permission-gate-core — run with: bun test
import { test, expect } from "bun:test";
import {
  RM_RECURSIVE_FORCE_PATTERN,
  extractRmTargets,
  globHead,
  hasDotDotAfterGlob,
  isSandboxSafe,
  tokenizeCommand,
} from "../extensions/permission-gate-core";

const CWD = "/Users/p4stela/repos/luna-editor";

// --- tokenizer -------------------------------------------------------------
test("tokenizer strips quotes and keeps spaces inside quotes", () => {
  expect(tokenizeCommand('rm -rf ".pi/work/foo bar"')).toEqual([
    "rm",
    "-rf",
    ".pi/work/foo bar",
  ]);
  expect(tokenizeCommand("rm -rf 'a b' c")).toEqual(["rm", "-rf", "a b", "c"]);
  expect(tokenizeCommand("echo $HOME && rm -rf x")).toEqual([
    "echo",
    "$HOME",
    "&&",
    "rm",
    "-rf",
    "x",
  ]);
  expect(tokenizeCommand("rm -rf \\*.log")).toEqual(["rm", "-rf", "*.log"]);
});

test("tokenizer emits separators standalone and skips comments", () => {
  expect(tokenizeCommand("rm -rf a; echo hi # note")).toEqual([
    "rm",
    "-rf",
    "a",
    ";",
    "echo",
    "hi",
  ]);
});

// --- rm target extraction --------------------------------------------------
test("extractRmTargets collects operands and skips flags", () => {
  expect(extractRmTargets("rm -rf .pi/work/build-1")).toEqual([
    ".pi/work/build-1",
  ]);
  expect(extractRmTargets("rm -rf .pi/work/*")).toEqual([".pi/work/*"]);
  expect(extractRmTargets("rm --recursive --force .pi/work/x")).toEqual([
    ".pi/work/x",
  ]);
  expect(extractRmTargets("/bin/rm -rf .pi/work/x")).toEqual([".pi/work/x"]);
  expect(extractRmTargets("rm -rf a b c")).toEqual(["a", "b", "c"]);
  expect(extractRmTargets("rm -rf .pi/work/a; git clean -fdx")).toEqual([
    ".pi/work/a",
  ]);
  expect(extractRmTargets("rm -rf .pi/work/a && rm -rf /tmp/x")).toEqual([
    ".pi/work/a",
    "/tmp/x",
  ]);
  expect(extractRmTargets("rm -rf -- .pi/work/x")).toEqual([".pi/work/x"]);
  expect(extractRmTargets("rm .pi/work/x stale.txt")).toEqual([
    ".pi/work/x",
    "stale.txt",
  ]);
});

// --- glob helpers ----------------------------------------------------------
test("globHead resolves the confinable prefix", () => {
  expect(globHead(".pi/work/*")).toBe(".pi/work");
  expect(globHead(".pi/work/**/x")).toBe(".pi/work");
  expect(globHead(".pi/work/foo/*.log")).toBe(".pi/work/foo");
  expect(globHead(".pi/work/x")).toBe(".pi/work/x");
  expect(globHead("*.log")).toBeUndefined(); // bare glob — cannot prove
});

test("hasDotDotAfterGlob catches upward walks after a glob", () => {
  expect(hasDotDotAfterGlob(".pi/work/*/../../etc")).toBe(true);
  expect(hasDotDotAfterGlob(".pi/work/**")).toBe(false);
  expect(hasDotDotAfterGlob(".pi/work/../x")).toBe(false); // no glob — resolve handles it
});

// --- sandbox verdict -------------------------------------------------------
test("allows rm confined to .pi/work", () => {
  expect(isSandboxSafe("rm -rf .pi/work/build-1", CWD)).toBe(true);
  expect(isSandboxSafe("rm -rf .pi/work/*", CWD)).toBe(true);
  expect(isSandboxSafe("rm -rf .pi/work/**/*", CWD)).toBe(true);
  expect(isSandboxSafe("rm -rf .pi/work", CWD)).toBe(true);
  expect(isSandboxSafe("rm -rf ./.pi/work/tmp/x", CWD)).toBe(true);
  expect(isSandboxSafe("rm -rf .pi/work/a .pi/work/b", CWD)).toBe(true);
  expect(isSandboxSafe("rm -rf .pi/work/*; echo done", CWD)).toBe(true);
});

test("allows rm from a nested cwd (walk-up candidates)", () => {
  expect(isSandboxSafe("rm -rf .pi/work/x", `${CWD}/packages/foo`)).toBe(true);
});

test("gates rm touching anything outside sandbox", () => {
  expect(isSandboxSafe("rm -rf /tmp/npm-*", CWD)).toBe(false); // shared tmp — never allow
  expect(isSandboxSafe("rm -rf /etc/ssl/x", CWD)).toBe(false);
  expect(isSandboxSafe("rm -rf ../other/tmp", CWD)).toBe(false);
  expect(isSandboxSafe("rm -rf .pi/work/a /etc/x", CWD)).toBe(false); // mixed
  expect(isSandboxSafe("rm -rf *", CWD)).toBe(false); // bare glob
  expect(isSandboxSafe("rm -rf .pi/work/*/../../etc", CWD)).toBe(false); // upward glob
  expect(isSandboxSafe("rm -rf .pi/work/../etc", CWD)).toBe(false); // .. escape
  expect(isSandboxSafe("rm -rf $TMPDIR/x", CWD)).toBe(false); // env var — cannot prove
  expect(isSandboxSafe("rm -rf", CWD)).toBe(false); // no targets — fail closed
  expect(isSandboxSafe('rm -rf ""', CWD)).toBe(false);
  expect(isSandboxSafe("rmdir .pi/work/x", CWD)).toBe(false); // not recursive/forced rm (gate via pattern anyway)
});

// --- gate pattern parity ---------------------------------------------------
test("RM_RECURSIVE_FORCE_PATTERN matches what the old gate flagged", () => {
  expect(RM_RECURSIVE_FORCE_PATTERN.test("rm -rf /tmp/x")).toBe(true);
  expect(RM_RECURSIVE_FORCE_PATTERN.test("rm -r .pi/work")).toBe(true);
  expect(RM_RECURSIVE_FORCE_PATTERN.test("rm -f x")).toBe(true);
  expect(RM_RECURSIVE_FORCE_PATTERN.test("rm x")).toBe(false);
  expect(RM_RECURSIVE_FORCE_PATTERN.test("rmdir x")).toBe(false);
  expect(RM_RECURSIVE_FORCE_PATTERN.test("rm -d x")).toBe(false);
  expect(RM_RECURSIVE_FORCE_PATTERN.test("npm clean x")).toBe(false);
});

// --- hardened (fs) checks --------------------------------------------------
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  isSandboxSafeHardened,
  realCandidates,
  realTargetPath,
  sandboxDirName,
} from "../extensions/permission-gate-core";

const fixture = (() => {
  const root = mkdtempSync(path.join(tmpdir(), "pg-hardened-"));
  const project = path.join(root, "repo");
  const sandbox = path.join(project, ".pi", "work");
  mkdirSync(path.join(sandbox, "sub"), { recursive: true });
  mkdirSync(path.join(sandbox, "keep"), { recursive: true });
  // symlink INSIDE the sandbox pointing outside it
  symlinkSync(root, path.join(sandbox, "escape"));
  return { root, project, sandbox };
})();

// NOTE: tests only exercise the resolver, never an actual `rm` on the fixture.

test("hardened: real dir inside the sandbox is allowed", () => {
  expect(isSandboxSafeHardened("rm -rf .pi/work/sub/*", fixture.project)).toBe(
    true,
  );
  expect(isSandboxSafeHardened("rm -rf .pi/work/keep", fixture.project)).toBe(
    true,
  );
  expect(isSandboxSafeHardened("rm -rf .pi/work/*", fixture.project)).toBe(
    true,
  );
  expect(isSandboxSafeHardened("rm -rf .pi/work", fixture.project)).toBe(true);
});

test("hardened: symlink escape is NOT allowed (trailing slash / glob through link)", () => {
  // `rm -rf .pi/work/escape/` follows the link and deletes the target's contents
  expect(
    isSandboxSafeHardened("rm -rf .pi/work/escape/", fixture.project),
  ).toBe(false);
  // glob through the link would resolve outside the sandbox
  expect(
    isSandboxSafeHardened("rm -rf .pi/work/escape/*", fixture.project),
  ).toBe(false);
  // removing the LINK itself (no trailing slash) is safe and allowed
  expect(isSandboxSafeHardened("rm -rf .pi/work/escape", fixture.project)).toBe(
    true,
  );
});

test("hardened: keeps denying plain /tmp targets and dotdot escapes", () => {
  expect(isSandboxSafeHardened("rm -rf /tmp/x", fixture.project)).toBe(false);
  expect(
    isSandboxSafeHardened("rm -rf .pi/work/escape/../../etc", fixture.project),
  ).toBe(false);
  expect(isSandboxSafeHardened("rm -rf ../etc", fixture.project)).toBe(false);
});

test("realTargetPath resolves the deepest existing ancestor (realpath-normalized)", () => {
  const inside = path.join(fixture.sandbox, "sub");
  // macOS maps /var -> /private/var, so the resolved value is realpath-based
  expect(realTargetPath(path.join(inside, "ghost"))).toBe(
    path.join(realpathSync(inside), "ghost"),
  );
  expect(realTargetPath(fixture.sandbox)).toBe(realpathSync(fixture.sandbox));
  expect(realTargetPath(path.join(fixture.project, ".pi", "zzz"))).toBe(
    path.join(realpathSync(path.join(fixture.project, ".pi")), "zzz"),
  );
});

test("realCandidates includes realpath forms of existing candidates", () => {
  const cands = realCandidates(fixture.project);
  expect(cands).toContain(path.join(fixture.project, ".pi", "work"));
  expect(cands).toContain(fixture.sandbox); // realpath of itself
});

test("sandboxDirName honors PI_SANDBOX_DIR", () => {
  const prev = process.env.PI_SANDBOX_DIR;
  process.env.PI_SANDBOX_DIR = "scratch";
  try {
    expect(sandboxDirName()).toBe("scratch");
  } finally {
    if (prev === undefined) delete process.env.PI_SANDBOX_DIR;
    else process.env.PI_SANDBOX_DIR = prev;
  }
  expect(sandboxDirName()).toBe(".pi/work");
  if (!existsSync(fixture.root)) throw new Error("fixture missing");
});

test("hardened: sandbox dir override is honored by the fs check", () => {
  const altSandbox = path.join(fixture.project, "scratch");
  mkdirSync(altSandbox, { recursive: true });
  expect(
    isSandboxSafeHardened("rm -rf scratch/*", fixture.project, "scratch"),
  ).toBe(true);
  expect(
    isSandboxSafeHardened("rm -rf .pi/work/*", fixture.project, "scratch"),
  ).toBe(false);
});

// fixture cleanup at exit (best-effort)
process.on("exit", () => {
  try {
    rmSync(fixture.root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
