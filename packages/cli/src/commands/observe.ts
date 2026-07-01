/**
 * `personaxis observe` — feed ONE observation to the living persona (Fase 3).
 *
 * This is the primitive that keeps a persona alive WITHOUT burning the host's tokens: a host hook
 * (Claude Code / Codex end-of-turn) or a serverless cron fires `personaxis observe --observation
 * "<turn>"`, which runs one governed Living-Loop tick on OUR configured model (resolveModel) and, if
 * the tick drifted the spec (a governed self-edit), recompiles PERSONA.md so the host reads a fresh
 * identity. Deterministic + bounded: a tick failure never throws non-zero unless --strict.
 */

import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import {
  LivingLoop,
  HeuristicAppraiser,
  LlmAppraiser,
  resolveModel,
  slugFromPersonaPath,
  makeRecompileHook,
  readRecompilePending,
  loadPersona,
  ensureState,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";
import { runCompile } from "./compile.js";

/** Resolve the persona spec: explicit --persona, else the project root `.personaxis/personaxis.md`. */
export function resolveObservePersona(personaOpt?: string): string | undefined {
  if (personaOpt) {
    const p = resolve(personaOpt);
    return existsSync(p) ? p : undefined;
  }
  const root = join(process.cwd(), ".personaxis", "personaxis.md");
  return existsSync(root) ? root : undefined;
}

export interface ObserveResult {
  ok: boolean;
  report?: { mutationsApplied: number; memoriesWritten: number; abstained: boolean };
  recompiled: boolean;
  events: LoopEvent[];
  error?: string;
}

/** Run one governed tick + a drift-gated recompile. Reusable by the daemon and tests. */
export async function runObserve(
  personaPath: string,
  observation: string,
  source: ProvenanceSource = "user",
): Promise<ObserveResult> {
  const handle = loadPersona(personaPath);
  ensureState(handle);
  const fm = handle.frontmatter as Record<string, unknown>;
  const m = resolveModel({ personaPath, frontmatter: fm });
  const events: LoopEvent[] = [];
  const loop = new LivingLoop(personaPath, {
    appraiser: m ? new LlmAppraiser({ ...m, timeoutMs: 30_000 }) : new HeuristicAppraiser(),
    recompile: makeRecompileHook(),
  });
  loop.bus.on((e) => events.push(e));
  try {
    const report = await loop.tick({ observation, source });
    // Drift-gated recompile: only when a governed self-edit marked PERSONA.md stale.
    let recompiled = false;
    if (readRecompilePending(personaPath).pending) {
      const slug = slugFromPersonaPath(personaPath);
      await runCompile(slug ? { slug, provider: "local", ifPending: true } : { root: true, provider: "local", ifPending: true });
      recompiled = true;
    }
    return { ok: true, report, recompiled, events };
  } catch (e) {
    return { ok: false, recompiled: false, events, error: (e as Error).message };
  }
}

/** Read all of stdin (the host hook's JSON payload). Empty string if none/none within timeout. */
function readStdin(): Promise<string> {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    let data = "";
    const timer = setTimeout(() => res(data), 1500); // never hang the host
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      res(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      res(data);
    });
  });
}

/**
 * Turn a host hook payload into an observation. Claude Code's Stop hook sends JSON with a
 * `transcript_path` (a JSONL of the session); we extract the last user + assistant exchange. Falls
 * back to the raw text so any host that pipes the turn on stdin works. Best-effort — never throws.
 */
export function observationFromHookPayload(stdinText: string): string | undefined {
  const raw = stdinText.trim();
  if (!raw) return undefined;
  try {
    const payload = JSON.parse(raw) as { transcript_path?: string; prompt?: string; message?: string };
    if (payload.transcript_path && existsSync(payload.transcript_path)) {
      const lines = readFileSync(payload.transcript_path, "utf-8").split("\n").filter((l) => l.trim());
      const texts: string[] = [];
      for (const line of lines.slice(-8)) {
        try {
          const row = JSON.parse(line) as { role?: string; type?: string; message?: { role?: string; content?: unknown } };
          const role = row.role ?? row.message?.role ?? row.type;
          const content = extractText(row.message?.content ?? (row as { content?: unknown }).content);
          if ((role === "user" || role === "assistant") && content) texts.push(`${role}: ${content}`);
        } catch {
          /* skip */
        }
      }
      const joined = texts.slice(-2).join("\n").slice(0, 1200);
      if (joined) return joined;
    }
    if (payload.prompt) return String(payload.prompt).slice(0, 1200);
    if (payload.message) return String(payload.message).slice(0, 1200);
  } catch {
    /* not JSON — treat as raw text */
  }
  return raw.slice(0, 1200);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? "")).join(" ").trim();
  }
  return "";
}

export const observeCommand = new Command("observe")
  .description("Feed one observation to the living persona: run a governed tick on the configured model, recompile PERSONA.md on drift. Fired by host hooks (--stdin) or a serverless cron.")
  .option("-o, --observation <text>", "What just happened (the host turn, user message, tool result, …)")
  .option("--stdin", "Read the observation from a host hook payload on stdin (Claude Code Stop hook JSON / transcript)", false)
  .option("-p, --persona <path>", "Path to personaxis.md (default: <cwd>/.personaxis/personaxis.md)")
  .option("-s, --source <source>", "Provenance: user | tool | internal | synthesis", "user")
  .option("--json", "Emit the tick report + events as JSON (for programmatic hosts)", false)
  .option("--strict", "Exit non-zero if the tick fails (default: never break the host)", false)
  .action(async (opts: { observation?: string; stdin?: boolean; persona?: string; source: string; json?: boolean; strict?: boolean }) => {
    const personaPath = resolveObservePersona(opts.persona);
    if (!personaPath) {
      console.error(chalk.red("Error:"), "no persona found — pass --persona or run inside a project with .personaxis/personaxis.md");
      process.exit(opts.strict ? 1 : 0);
    }
    const observation = opts.stdin ? observationFromHookPayload(await readStdin()) ?? opts.observation : opts.observation;
    if (!observation || !observation.trim()) {
      // A hook that fires with no captured turn is a no-op, not an error — never break the host.
      if (!opts.json) console.error(chalk.dim("· observe: nothing to observe (empty payload)"));
      process.exit(opts.strict ? 1 : 0);
    }
    const source = (["user", "tool", "internal", "synthesis"].includes(opts.source) ? opts.source : "user") as ProvenanceSource;
    const result = await runObserve(personaPath, observation, source);
    if (opts.json) {
      console.log(JSON.stringify({ ok: result.ok, report: result.report, recompiled: result.recompiled, error: result.error }, null, 2));
    } else if (result.ok) {
      const r = result.report!;
      console.log(
        chalk.green("✓ observed"),
        chalk.dim(`· ${r.mutationsApplied} mutation(s) · ${r.memoriesWritten} memory · ${result.recompiled ? "PERSONA.md recompiled" : "no drift"}`),
      );
    } else {
      console.error(chalk.yellow("· observe skipped:"), result.error);
    }
    if (!result.ok && opts.strict) process.exit(1);
  });
