/**
 * Permission & sandbox policy (F3 / T9).
 *
 * Honest scope: real *kernel* sandboxing needs native primitives (macOS Seatbelt,
 * Linux Landlock/seccomp/bubblewrap, Windows job objects / restricted tokens).
 * This module provides two things that ARE doable cross-platform and that the big
 * agents rely on most:
 *
 *   1. A two-axis POLICY ENGINE (approval × sandbox, the Codex model) that DECIDES
 *      allow | ask | deny for a command, pure, deterministic, fully tested. This
 *      is the load-bearing control: a denied command never runs.
 *   2. A best-effort NATIVE WRAPPER that, when the command is allowed, wraps it
 *      with the platform's available sandbox (sandbox-exec / bwrap) so writes and
 *      network are constrained at the OS level where possible.
 *
 * If no native sandbox is available, enforcement degrades to the policy decision
 * (deny-by-default for risky ops), never a silent full-access fallback.
 */

import { resolveIsolation } from "./security/isolation.js";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

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
  /**
   * FR.8: additional roots writable under `workspace-write` (the workspaceRoot
   * is always one). Lets a host grant, e.g., a build output dir outside the repo
   * without escalating to danger-full-access.
   */
  writableRoots?: string[];
  /**
   * FR.8: per-category approval overrides, finer than the single global
   * `approval` knob (e.g. network commands always ask while plain writes flow).
   */
  approvals?: Partial<Record<"network" | "destructive" | "write", ApprovalMode>>;
  /**
   * V3.1: read-side resolution roots for the ACTIVE persona's resources. A
   * compiled persona doc references its resources relative to its OWN home
   * (`./memory.md` for a sub-persona, `./.personaxis/...` for a root persona),
   * which only coincides with `workspaceRoot` when the process happens to run
   * from that directory. Read tools resolve against `workspaceRoot` first and
   * then fall back through these roots. Reads only; writes stay confined to
   * `workspaceRoot`/`writableRoots`.
   */
  resourceRoots?: string[];
}

export const DEFAULT_POLICY: Policy = {
  sandbox: "workspace-write",
  approval: "on-request",
  allow: [],
  deny: [],
  workspaceRoot: process.cwd(),
};

/**
 * FR.8 (Codex protocol.rs anti-escalation): folders that stay PROTECTED even
 * inside a writable root, at any depth below it. `.git` = arbitrary-code-execution
 * escalation: a write to `.git/hooks` runs on the user's next git command, and so
 * does one to `.git/config` that sets `core.hooksPath` or `core.fsmonitor`, which
 * is why Codex keeps the whole folder read-only rather than only its hooks
 * (`WritableRoot.read_only_subpaths`); this list named only `.git/hooks` until
 * 2026-09-11. `.personaxis` = the persona's identity artifacts, raw file writes
 * would bypass the governance ledger (self-edits are the sanctioned path). A deny
 * here is NOT overridable by the allow-list (deny precedence).
 */
export const PROTECTED_SUBPATHS = [".git", ".personaxis"] as const;

/** Named permission profiles (FR.8), one word instead of four knobs. */
export const PERMISSION_PROFILES = {
  strict: { sandbox: "read-only", approval: "untrusted" },
  standard: { sandbox: "workspace-write", approval: "on-request" },
  trusted: { sandbox: "workspace-write", approval: "on-failure" },
  yolo: { sandbox: "danger-full-access", approval: "never" },
} as const satisfies Record<string, Pick<Policy, "sandbox" | "approval">>;

export type PermissionProfile = keyof typeof PERMISSION_PROFILES;

/** Build a Policy from a named profile (+ optional overrides). */
export function policyFromProfile(
  profile: PermissionProfile,
  overrides: Partial<Policy> = {},
): Policy {
  return { ...DEFAULT_POLICY, ...PERMISSION_PROFILES[profile], ...overrides };
}

/** True when `p` lands inside a protected subpath of any writable root. */
export function isProtectedPath(p: string, policy: Policy): boolean {
  const abs = isAbsolute(p) ? normalize(p) : resolve(policy.workspaceRoot, p);
  return [policy.workspaceRoot, ...(policy.writableRoots ?? [])].some((root) => isProtectedUnder(abs, root));
}

/**
 * True when `p`, resolved from `root`, lands inside `root` and under one of the
 * `PROTECTED_SUBPATHS`, at any depth: a nested project's `.personaxis` is another
 * persona's identity, and a submodule's `.git` runs code like the top one does.
 *
 * Folded to lower case, because Windows and macOS do not tell `.Personaxis` from
 * `.personaxis`, and protecting a folder nobody names that way on Linux costs nothing.
 *
 * Two defects fixed here on 2026-09-11 (E59): a name that merely starts with two
 * dots inside a protected folder (`.personaxis/..notes`) was read as a way out of
 * it and left unprotected, by the same bare-prefix test `pathEscapesWorkspace` had;
 * and only the top level of a root was looked at.
 */
export function isProtectedUnder(p: string, root: string): boolean {
  const base = resolve(root);
  const target = isAbsolute(p) ? normalize(p) : resolve(base, p);
  const rel = relative(base, target);
  if (rel === "" || climbsOut(rel)) return false;
  const protectedNames: readonly string[] = PROTECTED_SUBPATHS;
  return rel.split(/[\\/]+/).some((segment) => protectedNames.includes(segment.toLowerCase()));
}

/** `..` alone, or `..` followed by a separator, or another drive: a relative path that leaves its base. */
function climbsOut(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel);
}

/**
 * v0.8: build a Policy from a persona's declared `permissions` block, so a persona
 * carries its own sandbox posture to any host. Missing fields fall back to defaults.
 */
export function policyFromFrontmatter(
  frontmatter: Record<string, unknown>,
  workspaceRoot: string = process.cwd(),
): Policy {
  const p = (frontmatter.permissions ?? {}) as Partial<Policy>;
  const sandbox =
    p.sandbox === "read-only" || p.sandbox === "workspace-write" || p.sandbox === "danger-full-access"
      ? p.sandbox
      : DEFAULT_POLICY.sandbox;
  const approval =
    p.approval === "untrusted" || p.approval === "on-failure" || p.approval === "on-request" || p.approval === "never"
      ? p.approval
      : DEFAULT_POLICY.approval;
  return {
    sandbox,
    approval,
    allow: Array.isArray(p.allow) ? p.allow.filter((x): x is string => typeof x === "string") : [],
    deny: Array.isArray(p.deny) ? p.deny.filter((x): x is string => typeof x === "string") : [],
    workspaceRoot,
  };
}

/**
 * V3.1: the read-resolution roots for the ACTIVE persona (see Policy.resourceRoots).
 * Pure path derivation, works for every persona level the same way:
 *  - sub-persona   `<proj>/.personaxis/personas/<slug>/personaxis.md` → its own folder
 *  - root persona  `<proj>/.personaxis/personaxis.md`                → `.personaxis/`
 *  - home persona  `~/.personaxis/personaxis.md`                     → `~/.personaxis/`
 * plus the persona's PROJECT root (the directory containing `.personaxis`), so
 * `./.personaxis/...`-style references resolve when the process CWD is elsewhere.
 */
export function personaResourceRoots(personaPath: string): string[] {
  const dir = dirname(resolve(personaPath));
  const roots = [dir];
  const segs = dir.split(/[\\/]/);
  const i = segs.lastIndexOf(".personaxis");
  if (i > 0) roots.push(segs.slice(0, i).join(sep));
  return roots;
}

export interface CommandClass {
  writesFiles: boolean;
  network: boolean;
  destructive: boolean;
  escapesWorkspace: boolean;
}

// E62, 2026-09-11: PowerShell and cmd are shells too. Claude Code on Windows runs commands through a
// tool called `PowerShell`, and none of its verbs were in these lists, so `Remove-Item -Recurse
// -Force C:\Users` classified as nothing at all. And `rm -r` deletes a tree as surely as `rm -f`.
const NETWORK =
  /\b(curl|wget|nc|ncat|ssh|scp|telnet|ftp|rsync)\b|\bnpm\s+(install|i|publish)\b|\bpip\s+install\b|\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Send-MailMessage)\b|Net\.WebClient/i;
const WRITE =
  />>?|\b(rm|mv|cp|mkdir|touch|tee|dd|truncate|chmod|chown|ln|del|erase|rmdir)\b|\b(Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Clear-Content)\b/i;
const DESTRUCTIVE =
  /\brm\s+-[a-z]*[rf]|\b(mkfs|fdisk|shred|:\(\)\s*\{)|\bRemove-Item\b[^|;&\n]*\s-(r|fo)|\b(rd|rmdir|del|erase)\b[^|;&\n]*\s\/s\b|\b(Format-Volume|Clear-Disk)\b/i;

/** True when a command is destructive by the documented classification: a tree delete, a forced delete, a disk format. */
export function isDestructiveCommand(cmd: string): boolean {
  return DESTRUCTIVE.test(cmd);
}

/**
 * A leading-slash token that is really a Windows/CLI SWITCH, not a filesystem path
 * (e.g. `/t`, `/c`, `/s`, `/?`, `/all`, `/b`). Real escaping paths look like
 * `/etc/passwd`, `/usr`, `/tmp`, `~/x`, `../x`. We exclude switch-shaped tokens so
 * harmless commands like `date /t` or `dir /s` aren't misflagged as workspace escapes.
 */
function isCliSwitch(tok: string): boolean {
  return /^\/(\?|[a-zA-Z]{1,3}(:[A-Za-z0-9_-]+)?)$/.test(tok);
}

/** Heuristically classify what a shell command would do. */
export function classifyCommand(cmd: string, workspaceRoot: string): CommandClass {
  const writesFiles = WRITE.test(cmd);
  const network = NETWORK.test(cmd);
  const destructive = DESTRUCTIVE.test(cmd);
  const escapesWorkspace = commandPathTokens(cmd).some((tok) => pathEscapesWorkspace(tok, workspaceRoot));
  return { writesFiles, network, destructive, escapesWorkspace };
}

/**
 * E85: when a zero exit code proves what somebody thinks it proves.
 *
 * Adopted without changes from the note `trabajar-sin-nadie-delante` (2026-08-22), which measured it in a
 * repository that had already been wrong about it: a command's exit code attributes to that command only when
 * it was the ONLY command of the sequence, or when the whole sequence is conjunctions (`&&`) and the code was
 * zero. A pipeline reports the LAST stage, so `tests | tee log` exits zero when the tests failed; a disjunction
 * runs the right side precisely when the left failed, so zero can mean the fallback worked; and a background
 * job exits immediately with the shell's code, not the job's.
 *
 * Pure and about the text, because the verdict has to be readable before anything runs. Quotes are respected,
 * so an operator inside a string is not an operator: `echo "a && b"` is one command.
 */
export function exitCodeAttributes(cmd: string): { readonly attributes: boolean; readonly why: string } {
  const text = cmd.trim();
  if (!text) return { attributes: false, why: "there is no command" };

  const operators: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      operators.push(pair);
      i += 1;
      continue;
    }
    // A single `&` that is not `&&` backgrounds what came before it; `;` and a newline chain unconditionally,
    // so what the code reports is only the last one. A pipe reports the last stage.
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") operators.push(ch);
  }

  if (operators.length === 0) return { attributes: true, why: "one command, so its code is its own" };
  const bad = operators.find((op) => op !== "&&");
  if (bad === undefined) return { attributes: true, why: "every step is a conjunction, so zero means each one passed" };
  const named =
    bad === "|" ? "a pipeline reports its last stage" : bad === "||" ? "a disjunction runs the right side only when the left failed" : bad === "&" ? "a background job returns the shell's code, not its own" : "an unconditional chain reports only the last command";
  return { attributes: false, why: named };
}

/**
 * The tokens of a command that could be a way out: absolute (`/x`, `C:\x`), home (`~/x`), or any
 * token with a `..` segment anywhere in it. The last used to be only a token STARTING with `../`, so
 * `cat docs/../../secret` was never looked at. A relative token with no `..` is not returned: it
 * lands inside whatever folder the command runs in. A token may open with a quote (E62): `rm -rf
 * "C:\Users"` hid its path from a scan that wanted whitespace right before it.
 */
export function commandPathTokens(cmd: string): string[] {
  return (cmd.match(/(?:^|\s)['"]?(\/[^\s'"]+|[A-Za-z]:[\\/][^\s'"]*|[~][^\s'"]*|[^\s'"]*\.\.[\\/][^\s'"]*)/g) ?? [])
    .map((tok) => tok.trim().replace(/^['"]/, ""))
    .filter((tok) => !isCliSwitch(tok));
}

/**
 * True if `p` resolves outside `root`.
 *
 * Always resolved. The first version returned "inside" for any relative path that did not
 * START with `..`, without resolving it, so `docs/../../x` passed the read gate, the file-write
 * gate and the command scan as a path inside the workspace. Found 2026-09-11.
 *
 * Symlinks are not followed: a link inside the workspace that points out of it is reported as
 * inside. That needs the filesystem, and this is a pure check on a string.
 */
export function pathEscapesWorkspace(p: string, root: string): boolean {
  if (p.startsWith("~")) return true;
  const base = resolve(root);
  const target = isAbsolute(p) ? normalize(p) : resolve(base, p);
  // `..` alone or `..` followed by a separator is a way up. A name that merely starts with two
  // dots (`..cache`) is a folder inside, and a bare prefix test used to call it a way out.
  return climbsOut(relative(base, target));
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

  // danger-full-access = explicit YOLO: allow everything the deny-list didn't block, with NO
  // approval prompt. This is what makes the posture meaningfully different from workspace-write
  // (which still asks for risky ops) and consistent with wrapCommand's "full access (no wrapping)".
  if (policy.sandbox === "danger-full-access") {
    return { decision: "allow", reason: "danger-full-access (no restrictions except deny-list)", class: klass };
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

  // Approval mode governs the residual risk. FR.8: a per-category override
  // (approvals.network/destructive/write) takes precedence over the global
  // knob for commands of that class, most-specific-first, strictest-wins
  // when a command falls in several categories.
  const risky = klass.writesFiles || klass.network || klass.destructive || klass.escapesWorkspace;
  const effective = effectiveApproval(policy, klass);
  switch (effective) {
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

/** Strictness order for approval modes (stricter = later). */
const APPROVAL_STRICTNESS: ApprovalMode[] = ["never", "on-failure", "on-request", "untrusted"];

/**
 * FR.8: resolve the approval mode for a classified command (strictest category wins).
 * Exported for the consent matrix (E61), which has to read the same answer this gate reads.
 */
export function effectiveApproval(policy: Policy, klass: CommandClass): ApprovalMode {
  const candidates: ApprovalMode[] = [policy.approval];
  const a = policy.approvals;
  if (a) {
    if (klass.network && a.network) candidates.push(a.network);
    if (klass.destructive && a.destructive) candidates.push(a.destructive);
    if (klass.writesFiles && a.write) candidates.push(a.write);
  }
  return candidates.reduce((strictest, m) =>
    APPROVAL_STRICTNESS.indexOf(m) > APPROVAL_STRICTNESS.indexOf(strictest) ? m : strictest,
  );
}

/**
 * O22: the stricter of two approval modes.
 *
 * Exported beside the order it reads, and reading that same order, because a second strictness scale written
 * somewhere else is a scale that disagrees with this one the day somebody adds a mode. It exists for work
 * handed to a colleague: the colleague acts under the lower ceiling of the two, and on this dimension the lower ceiling IS the stricter mode. It is not a preference: with
 * `never` or `on-failure` a risky operation comes back `allow` from `evaluateCommand`, so a looser colleague
 * would turn into silent permission what the asker would have sent to a person.
 */
export function stricterApproval(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return APPROVAL_STRICTNESS.indexOf(a) >= APPROVAL_STRICTNESS.indexOf(b) ? a : b;
}

/**
 * Decide allow | ask | deny for a FILE WRITE/EDIT under a policy. Mirrors
 * evaluateCommand's precedence but for a path target (the agent's write_file /
 * edit_file tools). Reuses pathEscapesWorkspace so a write that escapes the
 * workspace is denied under workspace-write, exactly like a shell redirect would be.
 */
export function evaluateFileWrite(
  targetPath: string,
  policy: Policy = DEFAULT_POLICY,
  opts: { destructive?: boolean } = {},
): CommandVerdict {
  // FR.8: writable under workspace-write ⇔ inside ANY writable root.
  const roots = [policy.workspaceRoot, ...(policy.writableRoots ?? [])];
  const klass: CommandClass = {
    writesFiles: true,
    network: false,
    destructive: Boolean(opts.destructive),
    escapesWorkspace: roots.every((r) => pathEscapesWorkspace(targetPath, r)),
  };

  // Anti-escalation guard FIRST, not even the allow-list overrides it.
  if (isProtectedPath(targetPath, policy)) {
    return {
      decision: "deny",
      reason: "protected subpath (.git/hooks = code-execution escalation; .personaxis = governed identity artifacts, use the sanctioned edit tools)",
      class: klass,
    };
  }
  if (matchesAny(policy.deny, targetPath)) {
    return { decision: "deny", reason: "path matches deny-list", class: klass };
  }
  // danger-full-access = explicit YOLO: writes are allowed without an approval prompt (only the
  // deny-list still blocks). Mirrors evaluateCommand so cycling to this posture is meaningful.
  if (policy.sandbox === "danger-full-access") {
    return { decision: "allow", reason: "danger-full-access (writes allowed, deny-list still applies)", class: klass };
  }
  if (policy.sandbox === "read-only") {
    return { decision: "deny", reason: "read-only sandbox forbids writes", class: klass };
  }
  if (policy.sandbox === "workspace-write" && klass.escapesWorkspace) {
    return { decision: "deny", reason: "write escapes the workspace", class: klass };
  }
  if (matchesAny(policy.allow, targetPath)) {
    return { decision: "allow", reason: "path matches allow-list", class: klass };
  }
  switch (policy.approval) {
    case "never":
    case "on-failure":
      return { decision: "allow", reason: `approval=${policy.approval}`, class: klass };
    case "on-request":
    case "untrusted":
    default:
      return { decision: "ask", reason: "file write needs approval", class: klass };
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
 *
 * Delegates to `security/isolation.ts`, which is availability-aware: a primitive that is not on
 * PATH (bwrap on a bare Linux box, sandbox-exec on a stripped macOS) degrades to `none` with an
 * honest note, never to a `bwrap ...` that would ENOENT and break every command (K.02, T9).
 */
export function wrapCommand(cmd: string, policy: Policy = DEFAULT_POLICY): WrapResult {
  const r = resolveIsolation(cmd, policy);
  return { command: r.command, args: r.args, sandbox: r.backend, note: r.note };
}
