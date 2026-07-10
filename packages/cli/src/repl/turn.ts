/**
 * REPL turn execution + multi-persona routing (F3.6 split).
 *
 * `runAgentTurn` is the unified chat+tools turn: one governed Agent Loop with the
 * persistent conversation and the session context meter, plus the per-turn
 * telemetry block and the identity-evolution tick. `dispatchTurn` routes a line
 * to the ROOT persona or to addressed sub-personas (`@address`/`@all`).
 *
 * The interactive turn constructs `PersonaAgent` directly (it needs fine-grained
 * bus/meter/awareness/approval control the SDK façade doesn't expose); routing it
 * through @personaxis/sdk is a follow-on that needs an expanded SDK agent API.
 */

import chalk from "chalk";
import {
  PersonaAgent,
  EventBus,
  Tracer,
  readState,
  readMemory,
  readMemoryTypes,
  prepareMemoryEntry,
  commitMemoryEntry,
  appendTurn,
  readRecompilePending,
  readAgentBudget,
  readVerification,
  readObservability,
} from "@personaxis/core";
import { slugAddressFromPath } from "../load.js";
import { runCompile } from "../commands/compile.js";
import { buildAwarenessBlock } from "./awareness.js";
import { discoverTree, colorForSlug, type SubPersonaRef } from "./roster.js";
import type { Ctx } from "./types.js";
import { llmConfig, ctxModelArg, buildPolicy, readGoalText } from "./config.js";
import { shortName, replyLine, phaseFor, renderEvent } from "./render.js";
import { recordTurn, makeCtx, ensureCtxSession } from "./session.js";

/**
 * A turn: the persona CONVERSES and (when needed) USES TOOLS — one governed agent
 * loop, with persistent conversation + the session context meter. This unifies chat
 * and `/do`: natural language can now call tools. Offline (no model) → the honest
 * reflective responder. Identity evolution (the Living Loop) still runs each turn.
 */
export async function runAgentTurn(line: string, ctx: Ctx): Promise<void> {
  const llm = llmConfig(ctxModelArg(ctx));
  if (!llm) {
    const cur = readState(ctx.handle.statePath);
    const reply = await ctx.responder
      .respond({ message: line, personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`, memory: readMemory(ctx.handle.personaPath).slice(-6).map((m) => m.content), state: cur.values, name: shortName(ctx) })
      .catch((e) => `(responder error: ${(e as Error).message})`);
    ctx.out(replyLine(ctx, reply), "persona");
    await recordTurn(ctx, line, reply);
    await ctx.loop.tick({ observation: line, source: "user", actor: "actor-llm" }).catch((e) => ctx.out(chalk.dim(`loop skipped: ${(e as Error).message}`)));
    return;
  }

  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const bus = new EventBus();
  // Which memories were RECALLED to answer this turn (emitted by the agent's resumeContext
  // before the loop listener below exists) — collected here for the concise per-turn summary.
  const recalls: string[] = [];
  bus.on((e) => {
    ctx.phase?.(phaseFor(e));
    if (e.type === "memory-recall") recalls.push(`${e.kind}×${e.count}${e.detail ? ` (${e.detail})` : ""}`);
    const l = renderEvent(ctx.theme, e);
    if (l) ctx.out(l, "activity");
  });
  const obs = readObservability(fm);
  const tracer = obs.trace !== "off" ? new Tracer(bus, obs) : null;
  const agent = new PersonaAgent({
    llm,
    policy: buildPolicy(ctx),
    personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`,
    awareness: buildAwarenessBlock(ctx.handle.personaPath),
    goal: readGoalText(ctx.handle),
    onApproval: ctx.approve,
    budget: readAgentBudget(fm),
    verification: readVerification(fm),
    judge: { endpoint: llm.endpoint, model: llm.model, apiKey: llm.apiKey },
    personaPath: ctx.handle.personaPath,
    meter: ctx.meter,
    priorMessages: ctx.conversation,
    bus,
  });
  // If the sandbox posture just changed, prepend a one-shot environment note so the model
  // RE-EVALUATES (and retries) a request it may have declined under the old posture, instead of
  // parroting its previous refusal from the conversation history. The note is NOT persisted to the
  // session (recordTurn stores the real user line).
  const taskLine = ctx.pendingEnvNote ? `${ctx.pendingEnvNote}\n\n${line}` : line;
  ctx.pendingEnvNote = undefined;
  const result = await agent.run(taskLine);
  ctx.conversation = (agent.lastMessages ?? []).filter((m) => m.role !== "system");
  ctx.out(replyLine(ctx, result.summary || "…"), "persona");
  await recordTurn(ctx, line, result.summary || "…");
  // Only surface the budget line when something noteworthy happened (a multi-step
  // task or an early stop) — not on every one-shot chat reply.
  if (result.budget.steps > 1 || (result.budget.stoppedBy && result.budget.stoppedBy !== "goal_met")) {
    ctx.out(chalk.dim(`  budget: ${result.budget.steps} steps · ${result.budget.tokens} tok · $${result.budget.costUsd}` + (result.budget.stoppedBy && result.budget.stoppedBy !== "goal_met" ? ` · stopped: ${result.budget.stoppedBy}` : "")));
  }
  if (tracer) {
    const { paths } = tracer.write(ctx.handle.personaPath);
    tracer.stop();
    for (const p of paths) ctx.out(chalk.dim(`  trace → ${p}`));
  }
  // Identity evolution runs without the observe/appraise/govern noise — but we DO
  // surface a concise, meaningful summary of what actually happened this turn:
  // which envelope changed, whether memory was written, whether PERSONA.md recompiled.
  const changed: string[] = [];
  let memWrites = 0;
  const memWriteKinds: string[] = []; // snippets of episodic memory CREATED this turn
  const memKinds: string[] = [];
  const evals: string[] = []; // individual quality scores (target · dimension · score)
  const selfEdits: string[] = [];
  const off = ctx.loop.bus.on((e) => {
    if (e.type === "mutate" && e.result && !e.result.blocked && e.result.from !== e.result.to) {
      changed.push(`${e.result.entry.field} ${e.result.from.toFixed(2)}→${e.result.to.toFixed(2)}${e.result.clamped ? " clamped" : ""}`);
    } else if (e.type === "memory") {
      memWrites++;
      memWriteKinds.push(`[${e.entry.source}] ${e.entry.content.slice(0, 48)}`);
    } else if (e.type === "evaluation") {
      // Real detail, not "+N eval(s)": e.g. "#a1b2c3d4 usefulness 0.74".
      evals.push(`${e.target} ${e.dimension} ${e.score.toFixed(2)}`);
    } else if (e.type === "memory-kind") {
      if (e.kind !== "evaluations") memKinds.push(`${e.kind} ${e.detail}`); // evaluations shown in detail below
    } else if (e.type === "self-edit") {
      if (e.op === "queued") selfEdits.push(`proposed ${e.targetPath} (/review)`);
      else if (e.op === "applied") selfEdits.push(`self-edit applied: ${e.targetPath}`);
    } else if (e.type === "drift") {
      // FASE 7 P2 (gap G5): the loop already computed the full report; the app's
      // gauge and drift view consume it directly, no disk re-read.
      ctx.onDrift?.(e.report);
    } else if (e.type === "recompile" && e.crossings?.length) {
      // FASE 7 P2: the theorem made visible — stage the band-crossing moment
      // (field pulses, the new band's prose lands, then a committed summary).
      ctx.onMoment?.(e.crossings);
    }
    // NB: within-band ticks emit no recompile; the fast .live.json marker stays internal.
  });
  await ctx.loop.tick({ observation: line, source: "user", actor: "actor-llm" }).catch(() => {});
  off();
  // Per-turn telemetry as a distinct, labeled BLOCK (one line per fact) so it never blends into
  // the persona's reply above. Rendered dim, with a gutter (┊) and an aligned label; only the
  // rows that actually happened appear.
  const rows: Array<[string, string]> = [];
  if (recalls.length) rows.push(["recalled", recalls.join(", ")]);
  if (changed.length) rows.push(["evolved", changed.join(", ")]);
  if (selfEdits.length) rows.push(["self-edit", selfEdits.join(" · ")]);
  if (memWrites) rows.push(["memory", `+${memWrites} episodic` + (memWriteKinds.length ? ` (${memWriteKinds[memWriteKinds.length - 1]})` : "")]);
  for (const k of memKinds) rows.push(["memory", k]);
  if (evals.length) rows.push(["evaluated", evals.slice(0, 4).join(" · ") + (evals.length > 4 ? ` +${evals.length - 4} more` : "")]);
  if (rows.length) {
    ctx.out("", "activity"); // blank line separates the telemetry block from the reply
    for (const [label, value] of rows) {
      ctx.out(chalk.dim(`  ┊ ${chalk.cyan(label.padEnd(9))} ${value}`), "activity");
    }
  }

  // A governed self-edit may have marked the compiled doc stale. Do NOT recompile inline —
  // a full LLM compile would block every single turn (the "stuck thinking" hang). Just
  // surface it; recompile happens on /compile, on /review approve, or on exit.
  if (readRecompilePending(ctx.handle.personaPath).pending) {
    ctx.out(chalk.dim("  · PERSONA.md stale (self-edits applied) — /compile to refresh"));
  }
}

/**
 * Recompile PERSONA.md when a self-edit marked it stale (`.recompile-pending.json`). Uses the
 * authenticated `local` provider (PERSONAXIS_* env) when configured; otherwise just notifies.
 * Best-effort: a failed recompile never breaks the turn.
 */
export async function maybeRecompile(ctx: Ctx): Promise<void> {
  if (!readRecompilePending(ctx.handle.personaPath).pending) return;
  if (!llmConfig(ctxModelArg(ctx))) {
    ctx.out(chalk.dim("  · PERSONA.md is stale — run `personaxis compile` to refresh it"));
    return;
  }
  try {
    ctx.phase?.("recompiling PERSONA.md");
    const address = slugAddressFromPath(ctx.handle.personaPath);
    await runCompile(address ? { slug: address, provider: "local" } : { root: true, provider: "local" });
    ctx.out(chalk.dim("  · PERSONA.md recompiled (self-edit applied)"));
  } catch (e) {
    ctx.out(chalk.dim(`  · recompile deferred: ${(e as Error).message}`));
  }
}

export const handleTurn = runAgentTurn;

/**
 * Parse leading @mentions for multi-persona routing, by hierarchical address:
 *   `@all` → every sub-persona; `@cmo` → "cmo"; `@cmo/legal` → nested; `@cmo/all` → cmo's subtree.
 * One or more mentions may lead the line. Unknown @tokens are left in the message.
 */
export function parseMentions(line: string, subs: SubPersonaRef[]): { targets: string[]; rest: string } {
  const byAddr = new Set(subs.map((s) => s.address));
  let rest = line.trim();
  const targets: string[] = [];
  for (;;) {
    const m = rest.match(/^@([A-Za-z0-9_/-]+)\s*/);
    if (!m) break;
    const tok = m[1].replace(/\/$/, "");
    if (tok === "all") {
      for (const s of subs) targets.push(s.address);
    } else if (tok.endsWith("/all")) {
      const pre = tok.slice(0, -3); // keep trailing "/"
      for (const s of subs) if (s.address.startsWith(pre)) targets.push(s.address);
    } else if (byAddr.has(tok)) {
      targets.push(tok);
    } else {
      break; // unknown — leave it in the message
    }
    rest = rest.slice(m[0].length);
  }
  return { targets: [...new Set(targets)], rest: rest.trim() };
}

export interface Roster {
  subs: SubPersonaRef[];
  color: (address: string) => number | undefined;
  getSub: (address: string) => Ctx | undefined;
}

/**
 * Build the multi-persona roster for a root context: discover the whole sub-persona tree,
 * assign each a fixed color (by full address), lazily materialize a Ctx per sub (sharing the
 * root's screen + meter), and make the root aware of the tree it can delegate to.
 */
export function buildRoster(rootCtx: Ctx): Roster {
  const subs = discoverTree(rootCtx.handle.personaPath);
  const subColor = new Map<string, number>();
  const taken = new Set<number>();
  for (const s of subs) subColor.set(s.address, colorForSlug(s.address, taken));
  const cache = new Map<string, Ctx>();
  const getSub = (address: string): Ctx | undefined => {
    const ref = subs.find((s) => s.address === address);
    if (!ref) return undefined;
    let c = cache.get(address);
    if (!c) {
      c = makeCtx(ref.path, rootCtx.meter, subColor.get(address));
      c.out = rootCtx.out;
      c.approve = rootCtx.approve;
      c.phase = rootCtx.phase;
      cache.set(address, c);
    }
    return c;
  };
  // The sub-persona tree is surfaced to the LLM via the runtime awareness block
  // (buildAwarenessBlock), which covers root AND every sub — so we no longer bake it
  // into personaDoc here.
  return { subs, color: (a) => subColor.get(a), getSub };
}

/**
 * Route one user line to the ROOT or to addressed sub-personas (@address/@all). Replies come
 * from each target; every delegation is recorded in the root's hash-chained memory.
 */
export async function dispatchTurn(line: string, rootCtx: Ctx, roster: Roster, setPhase?: (s: string) => void): Promise<void> {
  const { targets, rest } = parseMentions(line, roster.subs);
  const msg = rest || line;
  if (targets.length === 0) {
    await handleTurn(msg, rootCtx);
    return;
  }
  for (const addr of targets) {
    const sub = roster.getSub(addr);
    if (!sub) {
      rootCtx.out(chalk.yellow(`  no sub-persona @${addr}`));
      continue;
    }
    setPhase?.(`@${addr} thinking`);
    await handleTurn(msg, sub);
    // Record the delegation for provenance: a note in the ROOT's session (the sub logged
    // its own turn in its own session), and an episodic memory ONLY if the root's spec
    // enables episodic memory (honors memory.types.episodic — fixes the prior leak).
    try {
      ensureCtxSession(rootCtx, msg);
      appendTurn(rootCtx.handle.personaPath, rootCtx.sessionId, {
        role: "note",
        content: `Delegated to @${addr}: "${msg.slice(0, 120)}"`,
        from: "(root)",
      });
      if (readMemoryTypes(rootCtx.handle.frontmatter as Record<string, unknown>).episodic) {
        commitMemoryEntry(
          rootCtx.handle.personaPath,
          prepareMemoryEntry(rootCtx.handle.personaPath, {
            content: `Delegated to @${addr}: "${msg.slice(0, 120)}"`,
            source: "synthesis",
            tags: ["delegation", addr],
          }),
        );
      }
    } catch {
      /* delegation logging is best-effort */
    }
  }
}
