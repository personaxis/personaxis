/**
 * Permission & sandbox policy (F3 / T9 — plan/11-security).
 *
 * Honest scope: real *kernel* sandboxing needs native primitives (macOS Seatbelt,
 * Linux Landlock/seccomp/bubblewrap, Windows job objects / restricted tokens).
 * This module provides two things that ARE doable cross-platform and that the big
 * agents rely on most:
 *
 *   1. A two-axis POLICY ENGINE (approval × sandbox, the Codex model) that DECIDES
 *      allow | ask | deny for a command — pure, deterministic, fully tested. This
 *      is the load-bearing control: a denied command never runs.
 *   2. A best-effort NATIVE WRAPPER that, when the command is allowed, wraps it
 *      with the platform's available sandbox (sandbox-exec / bwrap) so writes and
 *      network are constrained at the OS level where possible.
 *
 * If no native sandbox is available, enforcement degrades to the policy decision
 * (deny-by-default for risky ops) — never a silent full-access fallback.
 */

import { platform } from "node:os";
import { isAbsolute, normalize, relative } from "node:path";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalMode = "untrusted" | "on-failure" | "on-request" | "never";

export interface Policy {
  sandbox: SandboxMode;
  approval: ApprovalMode;
  /** Regexes (as strings) that force-allow a matching command. */
  allow: string[];
  /** Regexes that force-deny a matching command (highest precedence). */
  deny: string[];
  workspaceRoot: string;
}

export const DEFAULT_POLICY: Policy = {
  sandbox: "workspace-write",
  approval: "on-request",
  allow: [],
  deny: [],
  workspaceRoot: process.cwd(),
};

export interface CommandClass {
  writesFiles: boolean;
  network: boolean;
  destructive: boolean;
  escapesWorkspace: boolean;
}

const NETWORK = /\b(curl|wget|nc|ncat|ssh|scp|telnet|ftp|rsync)\b|\bnpm\s+(install|i|publish)\b|\bpip\s+install\b/i;
const WRITE = />>?|\b(rm|mv|cp|mkdir|touch|tee|dd|truncate|chmod|chown|ln)\b/i;
const DESTRUCTIVE = /\brm\s+-[a-z]*f|\b(mkfs|fdisk|shred|:\(\)\s*\{)/i;

/** Heuristically classify what a shell command would do. */
export function classifyCommand(cmd: string, workspaceRoot: string): CommandClass {
  const writesFiles = WRITE.test(cmd);
  const network = NETWORK.test(cmd);
  const destructive = DESTRUCTIVE.test(cmd);
  const escapesWorkspace = (cmd.match(/(?:^|\s)(\/[^\s'"]+|[~][^\s'"]*|\.\.\/[^\s'"]*)/g) ?? []).some((tok) =>
    pathEscapesWorkspace(tok.trim(), workspaceRoot),
  );
  return { writesFiles, network, destructive, escapesWorkspace };
}

/** True if `p` resolves outside `root`. */
export function pathEscapesWorkspace(p: string, root: string): boolean {
  if (p.startsWith("~")) return true;
  if (!isAbsolute(p) && !p.startsWith("..")) return false;
  const rel = relative(normalize(root), normalize(isAbsolute(p) ? p : `${root}/${p}`));
  return rel.startsWith("..") || isAbsolute(rel);
}

export type Decision = "allow" | "ask" | "deny";

export interface CommandVerdict {
  decision: Decision;
  reason: string;
  class: CommandClass;
}

function matchesAny(patterns: string[], cmd: string): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(cmd);
    } catch {
      return false;
    }
  });
}

/**
 * Decide allow | ask | deny for a command under a policy. Precedence:
 * deny-list > sandbox hard limits > allow-list > approval mode.
 */
export function evaluateCommand(cmd: string, policy: Policy = DEFAULT_POLICY): CommandVerdict {
  const klass = classifyCommand(cmd, policy.workspaceRoot);

  if (matchesAny(policy.deny, cmd)) {
    return { decision: "deny", reason: "matches deny-list", class: klass };
  }

  // Sandbox hard limits (independent of approval).
  if (policy.sandbox === "read-only" && (klass.writesFiles || klass.network)) {
    return { decision: "deny", reason: "read-only sandbox forbids writes/network", class: klass };
  }
  if (policy.sandbox === "workspace-write") {
    if (klass.escapesWorkspace && klass.writesFiles) {
      return { decision: "deny", reason: "write escapes the workspace", class: klass };
    }
    if (klass.destructive) {
      return { decision: "deny", reason: "destructive command blocked under workspace-write", class: klass };
    }
  }

  if (matchesAny(policy.allow, cmd)) {
    return { decision: "allow", reason: "matches allow-list", class: klass };
  }

  // Approval mode governs the residual risk.
  const risky = klass.writesFiles || klass.network || klass.destructive || klass.escapesWorkspace;
  switch (policy.approval) {
    case "never":
      return { decision: "allow", reason: "approval=never", class: klass };
    case "on-failure":
      return { decision: "allow", reason: "approval=on-failure (pre-approved)", class: klass };
    case "on-request":
      return risky
        ? { decision: "ask", reason: "risky op needs approval", class: klass }
        : { decision: "allow", reason: "read-only op", class: klass };
    case "untrusted":
    default:
      return risky
        ? { decision: "ask", reason: "untrusted: confirm any risky op", class: klass }
        : { decision: "allow", reason: "read-only op", class: klass };
  }
}

export interface WrapResult {
  command: string;
  args: string[];
  sandbox: "seatbelt" | "bubblewrap" | "none";
  note: string;
}

/**
 * Best-effort native sandbox wrapping for an ALLOWED command. Caller is
 * responsible for only wrapping commands that already passed evaluateCommand.
 */
export function wrapCommand(cmd: string, policy: Policy = DEFAULT_POLICY): WrapResult {
  const os = platform();
  if (policy.sandbox === "danger-full-access") {
    return { command: "sh", args: ["-c", cmd], sandbox: "none", note: "full access (no wrapping)" };
  }
  if (os === "darwin") {
    // macOS Seatbelt: deny network, allow workspace writes only.
    const profile =
      `(version 1)(allow default)` +
      (policy.sandbox === "read-only" ? `(deny file-write*)` : `(allow file-write* (subpath "${policy.workspaceRoot}"))(deny file-write*)`) +
      `(deny network*)`;
    return { command: "sandbox-exec", args: ["-p", profile, "sh", "-c", cmd], sandbox: "seatbelt", note: "macOS Seatbelt profile" };
  }
  if (os === "linux") {
    // Linux bubblewrap: read-only bind of /, writable workspace, no network.
    const args = ["--ro-bind", "/", "/", "--bind", policy.workspaceRoot, policy.workspaceRoot, "--unshare-net", "--dev", "/dev", "sh", "-c", cmd];
    return { command: "bwrap", args, sandbox: "bubblewrap", note: "Linux bubblewrap (requires bwrap on PATH)" };
  }
  // Windows / other: no portable kernel sandbox here; rely on the policy decision.
  return { command: "sh", args: ["-c", cmd], sandbox: "none", note: `${os}: no native sandbox wrapper; policy decision is the control` };
}
