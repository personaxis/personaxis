/**
 * Real action executors (G1) — the surface the governed agent loop acts through.
 *
 * Gating happens BEFORE this module (the agent calls evaluateCommand /
 * evaluateFileWrite and only reaches here on an `allow`). These functions perform
 * the actual side effect, bounded: commands run with a timeout and truncated
 * output; file writes resolve against the workspace root. Output is returned, not
 * printed — the engine stays UI-agnostic.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { wrapCommand, type Policy } from "../sandbox.js";

/** Hard cap on captured stdout/stderr so a runaway command can't blow up context. */
export const MAX_OUTPUT = 16_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Run an ALLOWED shell command. When a native sandbox wrapper is available
 * (macOS Seatbelt / Linux bubblewrap) we spawn that binary directly with explicit
 * args (no shell). Otherwise we run through the OS shell (cmd.exe on Windows,
 * /bin/sh on Unix) so the command is portable.
 */
export function executeCommand(
  cmd: string,
  policy: Policy,
  opts: { timeoutMs?: number; spawnImpl?: typeof spawn } = {},
): Promise<ExecResult> {
  const wrapped = wrapCommand(cmd, policy);
  const useShell = wrapped.sandbox === "none";
  const spawnFn = opts.spawnImpl ?? spawn;
  return new Promise((resolveExec) => {
    const child = useShell
      ? spawnFn(cmd, { cwd: policy.workspaceRoot, shell: true })
      : spawnFn(wrapped.command, wrapped.args, { cwd: policy.workspaceRoot, shell: false });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExec(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
      if (stdout.length >= MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
      if (stderr.length >= MAX_OUTPUT) {
        stderr = stderr.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    });
    child.on("error", (err: Error) => {
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\n[spawn error: ${err.message}]`, truncated, timedOut });
    });
    child.on("close", (code: number | null) => {
      finish({ ok: !timedOut && code === 0, code, stdout, stderr, truncated, timedOut });
    });
  });
}

export interface FileResult {
  ok: boolean;
  path: string;
  bytes?: number;
  content?: string;
  error?: string;
}

function abs(path: string, policy: Policy): string {
  return resolve(policy.workspaceRoot, path);
}

/** Overwrite/create a file with content (parent dirs created). */
export function executeFileWrite(path: string, content: string, policy: Policy): FileResult {
  try {
    const p = abs(path, policy);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
    return { ok: true, path: p, bytes: Buffer.byteLength(content) };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}

/** Replace the first occurrence of `find` with `replace` in an existing file. */
export function executeFileEdit(path: string, find: string, replace: string, policy: Policy): FileResult {
  try {
    const p = abs(path, policy);
    if (!existsSync(p)) return { ok: false, path: p, error: "file not found" };
    const orig = readFileSync(p, "utf-8");
    if (!orig.includes(find)) return { ok: false, path: p, error: "find text not present (no change made)" };
    writeFileSync(p, orig.replace(find, replace), "utf-8");
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}

/** Read a file's contents (truncated to MAX_OUTPUT). */
export function readFileSafe(path: string, policy: Policy): FileResult {
  try {
    const p = abs(path, policy);
    if (!existsSync(p)) return { ok: false, path: p, error: "file not found" };
    let content = readFileSync(p, "utf-8");
    if (content.length > MAX_OUTPUT) content = content.slice(0, MAX_OUTPUT) + "\n…[truncated]";
    return { ok: true, path: p, content };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}

/** List a directory (names + type marker). */
export function listDirSafe(path: string, policy: Policy): FileResult {
  try {
    const p = abs(path, policy);
    if (!existsSync(p)) return { ok: false, path: p, error: "directory not found" };
    const entries = readdirSync(p).map((name) => {
      const isDir = statSync(resolve(p, name)).isDirectory();
      return isDir ? `${name}/` : name;
    });
    return { ok: true, path: p, content: entries.join("\n") };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}
