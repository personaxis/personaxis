/**
 * OS isolation (K.02): wrap an ALLOWED shell command with the platform's native sandbox so the
 * KERNEL, not just the policy, enforces the boundary (threat T9). The policy in `sandbox.ts`
 * decides allow/ask/deny; this decides HOW an allowed command runs: under bubblewrap on Linux,
 * Seatbelt on macOS, or, honestly, unwrapped where no reachable primitive exists.
 *
 * The one rule that makes this trustworthy is availability-awareness. The previous wrapper
 * returned `bwrap ...` on every Linux box, so a machine without bubblewrap would spawn a binary
 * that does not exist (ENOENT) and every command would fail, a fake sandbox that also broke the
 * agent. Here a primitive that is not on PATH degrades to `none` with an honest note, never to a
 * command that cannot run and never silently to full access.
 *
 * Windows: Job Objects / restricted tokens / AppContainer are not reachable from Node without a
 * native addon, so isolation is honestly `none` and the policy decision is the control. We do
 * not pretend otherwise.
 */

import { platform } from "node:os";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { Policy } from "../sandbox.js";

export type IsolationBackend = "seatbelt" | "bubblewrap" | "none";

export interface IsolationResult {
  /** Command + args to spawn. For `none` the caller runs the raw command via the shell. */
  command: string;
  args: string[];
  backend: IsolationBackend;
  /** True only when the kernel actually enforces the boundary (a real sandbox is in use). */
  enforced: boolean;
  note: string;
}

/** Injected so the resolution is testable on any OS without touching the real filesystem. */
export interface IsolationDeps {
  os?: NodeJS.Platform;
  hasBinary?: (bin: string) => boolean;
}

/** Is `bin` on PATH? Synchronous, cross-platform, no spawn. */
export function binaryOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, bin + ext))) return true;
    }
  }
  return false;
}

/**
 * Resolve how an allowed command should be spawned. The caller must only pass commands that
 * already cleared `evaluateCommand` (this decides isolation, not permission).
 */
export function resolveIsolation(cmd: string, policy: Policy, deps: IsolationDeps = {}): IsolationResult {
  const os = deps.os ?? platform();
  const has = deps.hasBinary ?? ((b: string) => binaryOnPath(b));
  const none = (note: string): IsolationResult => ({ command: "sh", args: ["-c", cmd], backend: "none", enforced: false, note });

  if (policy.sandbox === "danger-full-access") return none("full access (no wrapping)");

  if (os === "darwin") {
    if (!has("sandbox-exec")) return none("darwin: sandbox-exec not found; policy decision is the control");
    const profile =
      `(version 1)(allow default)` +
      (policy.sandbox === "read-only"
        ? `(deny file-write*)`
        : `(allow file-write* (subpath "${policy.workspaceRoot}"))(deny file-write*)`) +
      `(deny network*)`;
    return { command: "sandbox-exec", args: ["-p", profile, "sh", "-c", cmd], backend: "seatbelt", enforced: true, note: "macOS Seatbelt profile" };
  }

  if (os === "linux") {
    if (!has("bwrap")) return none("linux: bwrap not found; install bubblewrap for kernel isolation; policy decision is the control");
    const args = ["--ro-bind", "/", "/", "--bind", policy.workspaceRoot, policy.workspaceRoot, "--unshare-net", "--dev", "/dev", "sh", "-c", cmd];
    return { command: "bwrap", args, backend: "bubblewrap", enforced: true, note: "Linux bubblewrap" };
  }

  return none(`${os}: no native sandbox reachable from Node; policy decision is the control`);
}

/** One line for a status/forensic surface: which backend, and whether it truly enforces. */
export function describeIsolation(r: IsolationResult): string {
  return r.enforced ? `${r.backend} (kernel-enforced)` : `${r.backend} (policy-only: ${r.note})`;
}
