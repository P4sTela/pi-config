import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  RM_RECURSIVE_FORCE_PATTERN,
  isSandboxSafeHardened,
  sandboxDirName,
} from "./permission-gate-core";

/**
 * Permission gate
 *
 * Confirms with the user before running risky operations:
 *  - dangerous bash commands (rm -rf, sudo, disk writes, force git, etc.)
 *  - writes/edits to protected paths (.env, secrets, lockfiles, etc.)
 *
 * If the user declines, the tool call is blocked and the model is told why.
 * In non-interactive contexts (no UI), risky calls are blocked by default.
 *
 * Sandbox bypass: recursive/forced `rm` whose targets all resolve inside a
 * project scratch dir (`<project>/.pi/work`, or $PI_SANDBOX_DIR) is scratch
 * cleanup — allowed silently, also in headless runs. The bypass is limited to
 * commands where rm -r/-f is the SOLE dangerous pattern (so `sudo rm -rf …`
 * still gates) and uses realpath-resolved containment, so a symlink inside the
 * sandbox cannot smuggle deletion outside it. See permission-gate-core.ts.
 *
 * This is a cooperative guard, not a security boundary — deletion via other
 * tools (find -delete, shutil.rmtree, …) is covered by the pattern list below.
 */

// --- Dangerous bash command patterns ---------------------------------------
const DANGEROUS_BASH: { pattern: RegExp; reason: string }[] = [
  {
    pattern: RM_RECURSIVE_FORCE_PATTERN,
    reason: "recursive/forced file deletion (rm -rf)",
  },
  { pattern: /\bfind\b.*\s-delete\b/, reason: "find -delete (recursive deletion)" },
  { pattern: /\brmtree\s*\(/, reason: "python shutil.rmtree (recursive deletion)" },
  { pattern: /\bsudo\b/, reason: "elevated privileges (sudo)" },
  { pattern: /\bchmod\s+-R\b/, reason: "recursive permission change" },
  { pattern: /\bchown\s+-R\b/, reason: "recursive ownership change" },
  { pattern: /\b(mkfs|fdisk|dd)\b/, reason: "low-level disk operation" },
  {
    pattern: />\s*\/dev\/(sd|nvme|disk)/,
    reason: "writing to a raw disk device",
  },
  {
    pattern: /\bgit\s+push\s+.*--force\b|\bgit\s+push\s+.*-f\b/,
    reason: "force push",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: "hard reset (discards changes)",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    reason: "git clean (deletes untracked files)",
  },
  {
    pattern: /\b(shutdown|reboot|halt|poweroff)\b/,
    reason: "system power state change",
  },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}\s*;/, reason: "fork bomb" },
  {
    pattern: /\bcurl\b.*\|\s*(sudo\s+)?(sh|bash)\b/,
    reason: "piping a remote script into a shell",
  },
  {
    pattern: /\bwget\b.*\|\s*(sudo\s+)?(sh|bash)\b/,
    reason: "piping a remote script into a shell",
  },
  { pattern: /\bnpm\s+publish\b/, reason: "publishing an npm package" },
];

// --- Protected paths (write/edit) ------------------------------------------
const PROTECTED_PATHS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)\.env(\.|$)/, reason: "environment/secret file" },
  { pattern: /(^|\/)\.git\/config$/, reason: "git config" },
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa)/, reason: "SSH private key" },
  { pattern: /(^|\/)\.ssh\//, reason: "SSH directory" },
  { pattern: /(^|\/)\.aws\/credentials/, reason: "AWS credentials" },
  { pattern: /(^|\/)\.npmrc$/, reason: "npm credentials" },
  {
    pattern: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
    reason: "dependency lockfile",
  },
];

function matchBash(command: string) {
  for (const { pattern, reason } of DANGEROUS_BASH) {
    if (pattern.test(command)) return reason;
  }
  return undefined;
}

/**
 * True when any dangerous pattern OTHER than rm -r/-f matches the command
 * (e.g. `sudo rm -rf .pi/work/*`). The sandbox bypass must never let those
 * ride through on the rm allowance.
 */
function hasOtherDangerousBash(command: string) {
  return DANGEROUS_BASH.some(
    ({ pattern }) =>
      pattern !== RM_RECURSIVE_FORCE_PATTERN && pattern.test(command),
  );
}

function matchPath(path: string) {
  for (const { pattern, reason } of PROTECTED_PATHS) {
    if (pattern.test(path)) return reason;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    let reason: string | undefined;
    let detail = "";

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      detail = command;
      // Scratch cleanup inside <project>/.pi/work is always safe — bypass the
      // gate, but only when rm -r/-f is the sole dangerous pattern in play.
      if (
        RM_RECURSIVE_FORCE_PATTERN.test(command) &&
        !hasOtherDangerousBash(command) &&
        isSandboxSafeHardened(
          command,
          ctx.cwd ?? process.cwd(),
          sandboxDirName(),
        )
      ) {
        return;
      }
      reason = matchBash(command);
    } else if (isToolCallEventType("write", event)) {
      reason = matchPath(event.input.path ?? "");
      detail = event.input.path ?? "";
    } else if (isToolCallEventType("edit", event)) {
      reason = matchPath(event.input.path ?? "");
      detail = event.input.path ?? "";
    }

    if (!reason) return;

    // No interactive UI available: block by default for safety.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked by permission gate (${reason}). No interactive confirmation available.`,
      };
    }

    const ok = await ctx.ui.confirm(
      `⚠ Permission gate: ${reason}`,
      `Allow this ${event.toolName} operation?\n\n${detail}`,
    );

    if (!ok) {
      return {
        block: true,
        reason: `User declined: ${reason}.`,
      };
    }
  });
}
