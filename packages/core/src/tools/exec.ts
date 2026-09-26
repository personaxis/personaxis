/**
 * Real action executors (G1), the surface the governed agent loop acts through.
 *
 * Gating happens BEFORE this module (the agent calls evaluateCommand /
 * evaluateFileWrite and only reaches here on an `allow`). These functions perform
 * the actual side effect, bounded: commands run with a timeout and truncated
 * output; file writes resolve against the workspace root. Output is returned, not
 * printed, the engine stays UI-agnostic.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
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
  // An empty command makes `spawn` THROW rather than fail, and a throw here escapes into
  // the agent loop: the difference between a failed step the model can react to and a run
  // that dies mid-way. A model emitting an empty command is not rare, it is what happens
  // when a tool call comes back with a field it did not fill in.
  if (!cmd.trim()) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: "",
      stderr: "empty command: nothing to run",
      truncated: false,
      timedOut: false,
    });
  }

  const wrapped = wrapCommand(cmd, policy);
  const useShell = wrapped.sandbox === "none";
  const spawnFn = opts.spawnImpl ?? spawn;
  return new Promise((resolveExec) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = useShell
        ? spawnFn(cmd, { cwd: policy.workspaceRoot, shell: true })
        : spawnFn(wrapped.command, wrapped.args, { cwd: policy.workspaceRoot, shell: false });
    } catch (error) {
      // `spawn` throws synchronously for a handful of argument shapes, so the async error
      // handler below never sees them. Reported in the same shape as every other failure,
      // because a caller that has to handle two kinds of failure eventually handles one.
      resolveExec({
        ok: false,
        code: null,
        stdout: "",
        stderr: `could not start the command: ${error instanceof Error ? error.message : String(error)}`,
        truncated: false,
        timedOut: false,
      });
      return;
    }

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
  /**
   * C4/C5: this file is bytes, and `content` is a sentence ABOUT it rather than it.
   *
   * A flag and not a sentence to match on, which is the difference between two halves
   * that agree and two halves that agree today. `find_in_files` has to skip these, and
   * the first version of it recognised them by looking for the words "is not a text
   * file" inside the answer: a string shared by two modules with nothing keeping them
   * the same is the shape of bug this codebase spent a morning removing elsewhere.
   */
  binary?: boolean;
}

function abs(path: string, policy: Policy): string {
  return resolve(policy.workspaceRoot, path);
}

/**
 * V3.1 read-side resolution: `workspaceRoot` first, then the active persona's
 * `resourceRoots`. A compiled persona doc references `./memory.md` relative to
 * the persona's OWN home, which only equals the process CWD by coincidence;
 * without the fallback those reads fail as "file not found". Reads/edits of
 * existing files only; write-creates stay at `workspaceRoot`.
 *
 * Exported for `run/material-use.ts` (E80), which has to name the file a read
 * actually opened. Resolving it a second way would name one it never touched.
 */
export function absRead(path: string, policy: Policy): string {
  const first = abs(path, policy);
  if (existsSync(first)) return first;
  for (const root of policy.resourceRoots ?? []) {
    const cand = resolve(root, path);
    if (existsSync(cand)) return cand;
  }
  return first;
}

/**
 * C4: how much of a file is inspected before deciding it is not text.
 *
 * Eight thousand bytes, which is git's own rule and is worth borrowing rather than
 * inventing: it is long enough that a text file with a long licence header is not
 * mistaken for binary, and short enough to be free on a large file.
 */
const BINARY_SNIFF_BYTES = 8_000;

/**
 * Is this file bytes rather than text?
 *
 * A NUL in the head, which is git's test and the only cheap one that does not have
 * false positives on real text: UTF-8 never encodes a zero byte inside a character,
 * so a NUL means the file is not UTF-8 text at all.
 *
 * MEASURED on 2026-09-08, which is why this exists. A 24-byte PNG read as UTF-8 came
 * back as 24 characters of which **eight were replacement characters**: the model was
 * handed mojibake with nothing to say it was mojibake, and paid tokens for it. Worse
 * on the write side: reading those bytes and writing the string back turned 24 bytes
 * into 40, different ones, so `edit_file` on an image silently corrupted it and
 * reported `edited`.
 */
function looksBinary(bytes: Buffer): boolean {
	return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
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

/**
 * Add `content` to the end of a text file, creating it if it is missing (E139).
 *
 * A write too long for one reply arrives cut, and the only way to send it is in pieces. With
 * nothing but `executeFileWrite`, the second piece replaced the first: measured 2026-09-26, four
 * of fourteen `long-job` runs with Qwen3.5-9B delivered a `game.html` that began halfway through
 * its script. Reading the file back to rewrite it is not a way round it either, because
 * `readFileSafe` stops at `MAX_OUTPUT`. The whole file comes back in `content` so the caller can
 * check what is now on disk, not only the piece it sent.
 */
export function executeFileAppend(path: string, content: string, policy: Policy): FileResult {
  try {
    const p = abs(path, policy);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, content, "utf-8");
    const whole = readFileSync(p, "utf-8");
    return { ok: true, path: p, bytes: Buffer.byteLength(content), content: whole };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}

/**
 * Replace ONE occurrence of `find` with `replace` in an existing file.
 *
 * C4, and three of its rules are corrections rather than features.
 *
 * **An ambiguous edit is refused, not resolved.** This replaced the FIRST occurrence
 * and said `edited`, so a `find` that appeared twice was a coin flip the model was
 * never told about: it asked to change one thing and changed a different one, in a
 * file it then believed it had fixed. Refusing costs a round trip and asks for more
 * context, which is the thing that makes the next attempt unambiguous.
 *
 * **A binary is refused before it is read as text.** See `looksBinary`: a read and a
 * write through a UTF-8 string does not round-trip, so this used to corrupt an image
 * and report success.
 *
 * **What changed comes back.** `edited <path>` was the whole answer, so neither the
 * model nor a person watching could tell an edit that landed where it was meant from
 * one that landed somewhere else that happened to match.
 */
export function executeFileEdit(path: string, find: string, replace: string, policy: Policy): FileResult {
  try {
    const p = absRead(path, policy);
    if (!existsSync(p)) return { ok: false, path: p, error: "file not found" };

    const raw = readFileSync(p);
    if (looksBinary(raw)) {
      return {
        ok: false,
        path: p,
        error: `this is not a text file (${raw.length} bytes), and editing it as text would corrupt it`,
      };
    }

    const orig = raw.toString("utf-8");
    const occurrences = find === "" ? 0 : orig.split(find).length - 1;
    if (occurrences === 0) return { ok: false, path: p, error: "find text not present (no change made)" };
    if (occurrences > 1) {
      return {
        ok: false,
        path: p,
        error:
          `the find text appears ${occurrences} times, so which one to change is ambiguous ` +
          "(no change made). Include enough surrounding lines to name exactly one.",
      };
    }

    writeFileSync(p, orig.replace(find, replace), "utf-8");
    return { ok: true, path: p, content: describeEdit(orig, find, replace) };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}

/**
 * The change, as the few lines it touched.
 *
 * A diff and not the file: handing back the whole file after every edit would spend
 * the context the edit was made to save, and a model that has just written a line does
 * not need to be shown the other four hundred.
 *
 * Line numbers are the file's own, so what comes back can be checked against what the
 * model read. Bounded, because a `replace` can be a page: past the ceiling it says how
 * much it cut rather than cutting silently.
 */
function describeEdit(before: string, find: string, replace: string): string {
  const at = before.indexOf(find);
  const line = before.slice(0, at).split("\n").length;

  const shown = (text: string): string => {
    const lines = text.split("\n");
    if (lines.length <= DIFF_LINES) return text;
    return `${lines.slice(0, DIFF_LINES).join("\n")}\n…[${lines.length - DIFF_LINES} more line(s)]`;
  };

  return [`at line ${line}:`, `- ${shown(find).split("\n").join("\n- ")}`, `+ ${shown(replace).split("\n").join("\n+ ")}`].join(
    "\n",
  );
}

/** How many lines of each side of a change come back. Enough to recognise it, not enough to be the file. */
const DIFF_LINES = 12;

/**
 * Read a file's contents (truncated to MAX_OUTPUT).
 *
 * C4: a file that is not text comes back as an ANSWER rather than as its own bytes
 * mangled into characters. It is the same call `nearby.ts` makes about a missing file:
 * "there is nothing here I can read" is a fact the model can act on, and mojibake is a
 * fact it cannot even recognise. The size is given because it is what somebody decides
 * with: a 40 MB archive and a 300-byte icon need different next moves.
 */
export function readFileSafe(path: string, policy: Policy): FileResult {
  try {
    const p = absRead(path, policy);
    if (!existsSync(p)) return { ok: false, path: p, error: "file not found" };

    const raw = readFileSync(p);
    if (looksBinary(raw)) {
      return {
        ok: true,
        path: p,
        binary: true,
        bytes: raw.length,
        content:
          `${p} is not a text file (${raw.length} bytes). Nothing here reads binary content, ` +
          "so its bytes are not shown rather than shown as damaged text.",
      };
    }

    let content = raw.toString("utf-8");
    if (content.length > MAX_OUTPUT) content = content.slice(0, MAX_OUTPUT) + "\n…[truncated]";
    return { ok: true, path: p, content };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}

/** List a directory (names + type marker). */
export function listDirSafe(path: string, policy: Policy): FileResult {
  try {
    const p = absRead(path, policy);
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
