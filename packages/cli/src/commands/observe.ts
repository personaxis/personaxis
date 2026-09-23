/**
 * `personaxis observe`, feed ONE observation to the living persona (Fase 3).
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
  run,
  slugFromPersonaPath,
  makeRecompileHook,
  readRecompilePending,
  loadPersona,
  ensureState,
  TRUST,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";
import { runCompile } from "./compile.js";
import { holdPresence } from "../presence-session.js";

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
  /** E117: the observation is the runtime's own report of a turn, never a source of preferences. */
  opts: { readonly experience?: boolean } = {},
): Promise<ObserveResult> {
  const handle = loadPersona(personaPath);
  ensureState(handle);
  const fm = handle.frontmatter as Record<string, unknown>;
  const events: LoopEvent[] = [];
  const evolver = run.evolverFor(
    { personaPath, frontmatter: fm },
    { recompile: makeRecompileHook(), onEvent: (e: LoopEvent) => events.push(e) },
  );
  // D6: a tick runs a model and can rewrite the spec, so for its duration this process is a
  // holder like any other. Host hooks fire this on every turn, which is precisely the case
  // where the fleet claiming "idle" was furthest from the truth.
  const presence = holdPresence(personaPath, { host: "loop", activity: "running a governed tick" });
  try {
    const report = await evolver.observe({ observation, source, ...(opts.experience === true ? { experience: true } : {}) });
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
  } finally {
    presence.release();
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

/** What a host hook handed over, and where it came from. */
export interface HookObservation {
  text: string;
  /**
   * Who said it, which is what a self-edit's justification is weighed by (`provenance.ts`: a
   * self-edit needs `user` trust, and the weakest source wins).
   */
  source: ProvenanceSource;
}

/**
 * Turn a host hook payload into an observation. Best-effort, never throws.
 *
 * E57, 2026-09-11: the person's own line, labelled `user`, and nothing else when it is there.
 * This used to hand over the last user AND assistant messages as one text labelled `user`, so the
 * model's reply, and anything it had repeated from a tool or a pasted document, carried the trust
 * of the persona's owner, enough to justify a self-edit of its prose in `autonomous`. The REPL
 * observes the person's line and not the reply, and a service step observes what it was handed,
 * labelled `internal`; a persona that appraised its own output would be reacting to itself.
 *
 * When there is no line from the person (a host that only sends the reply, a context blob, raw
 * text of unknown shape), the text is observed as `internal`, which moves state and cannot justify
 * a self-edit.
 */
export function observationFromHookPayload(stdinText: string): HookObservation | undefined {
  const raw = stdinText.trim();
  if (!raw) return undefined;
  const person = (text: string): HookObservation => ({ text: text.slice(0, 1200), source: "user" });
  const other = (text: string): HookObservation => ({ text: text.slice(0, 1200), source: "internal" });
  try {
    const payload = JSON.parse(raw) as {
      transcript_path?: string;
      prompt?: string;
      message?: string;
      // Codex Stop hook: the final assistant message (+ optional user prompt).
      last_assistant_message?: string;
      last_user_message?: string;
      // openclaw internal hook: a serialized event with a context blob.
      context?: unknown;
    };
    if (payload.transcript_path && existsSync(payload.transcript_path)) {
      const lines = readFileSync(payload.transcript_path, "utf-8").split("\n").filter((l) => l.trim());
      let lastUser: string | undefined;
      let lastAssistant: string | undefined;
      for (const line of lines.slice(-8)) {
        try {
          const row = JSON.parse(line) as { role?: string; type?: string; message?: { role?: string; content?: unknown } };
          const role = row.role ?? row.message?.role ?? row.type;
          const content = extractText(row.message?.content ?? (row as { content?: unknown }).content);
          if (!content) continue;
          if (role === "user") lastUser = content;
          if (role === "assistant") lastAssistant = content;
        } catch {
          /* skip */
        }
      }
      if (lastUser) return person(lastUser);
      if (lastAssistant) return other(lastAssistant);
    }
    if (payload.last_user_message?.trim()) return person(payload.last_user_message.trim());
    if (payload.last_assistant_message?.trim()) return other(payload.last_assistant_message.trim());
    // A prompt hook carries what the person typed.
    if (payload.prompt) return person(String(payload.prompt));
    if (payload.message) return other(String(payload.message));
    // openclaw event: use the context blob if it carries text.
    const ctx = extractText(payload.context);
    if (ctx) return other(ctx);
  } catch {
    /* not JSON, treat as raw text */
  }
  return other(raw);
}

/**
 * The source an observation is recorded with. Exported for its test.
 *
 * From a hook, the payload decides, and a label on the command line can only lower it. The hooks
 * `personaxis hooks` installed until 2026-09-11 pass `--source user`, and that label is exactly what
 * made the model's reply count as the owner's words (E57). Typed with `--observation`, the label
 * decides, and it defaults to `user`: that is a person at the keyboard.
 */
export function sourceFor(hooked: HookObservation | undefined, label: string | undefined): ProvenanceSource {
  const asked = label && ["user", "tool", "internal", "synthesis"].includes(label) ? (label as ProvenanceSource) : undefined;
  if (!hooked) return asked ?? "user";
  if (!asked) return hooked.source;
  return (TRUST[asked] ?? 0) < (TRUST[hooked.source] ?? 0) ? asked : hooked.source;
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
  .option(
    "-s, --source <source>",
    "Provenance: user | tool | internal | synthesis (default user for --observation; with --stdin the payload decides, and this can only lower it)",
  )
  .option("--json", "Emit the tick report + events as JSON (for programmatic hosts)", false)
  .option("--strict", "Exit non-zero if the tick fails (default: never break the host)", false)
  .action(async (opts: { observation?: string; stdin?: boolean; persona?: string; source?: string; json?: boolean; strict?: boolean }) => {
    const personaPath = resolveObservePersona(opts.persona);
    if (!personaPath) {
      // A GLOBAL hook fires in every project; one without a persona is a silent no-op (not an error),
      // so the hook never spams the host. Manual runs (no --stdin) still get the hint.
      if (!opts.stdin && !opts.json) console.error(chalk.dim("· observe: no persona here (run inside a project with .personaxis/personaxis.md, or pass --persona)"));
      process.exit(opts.strict ? 1 : 0);
    }
    const hooked = opts.stdin ? observationFromHookPayload(await readStdin()) : undefined;
    const observation = hooked?.text ?? opts.observation;
    if (!observation || !observation.trim()) {
      // A hook that fires with no captured turn is a no-op, not an error, never break the host.
      if (!opts.json) console.error(chalk.dim("· observe: nothing to observe (empty payload)"));
      process.exit(opts.strict ? 1 : 0);
    }
    const result = await runObserve(personaPath, observation, sourceFor(hooked, opts.source));
    if (opts.json) {
      console.log(JSON.stringify({ ok: result.ok, report: result.report, recompiled: result.recompiled, error: result.error }, null, 2));
    } else if (result.ok) {
      const r = result.report!;
      console.log(
        chalk.green("✓ observed"),
        chalk.dim(`· ${r.mutationsApplied} mutation(s) · ${r.memoriesWritten} memory · ${result.recompiled ? "PERSONA.md recompiled" : "no drift"}`),
      );
      // A zero with no reason reads as a failure. The engine already says WHY it
      // held back (an ephemeral write policy, a locked gate, episodic memory
      // switched off); it was being dropped on the floor here.
      for (const e of result.events) {
        if (e.type === "abstain") console.log(chalk.dim(`  · ${e.reason}`));
        if (e.type === "govern") {
          for (const v of e.verdicts.filter((x) => !x.admitted)) {
            console.log(chalk.dim(`  · ${v.field} not applied: ${v.reason}`));
          }
        }
      }
    } else {
      console.error(chalk.yellow("· observe skipped:"), result.error);
    }
    if (!result.ok && opts.strict) process.exit(1);
  });
