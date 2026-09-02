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
