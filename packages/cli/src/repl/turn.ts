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
import { ensureState,
  PersonaAgent,
  EventBus,
  Tracer,
  readState,
  readMemoryTypes,
  readMemoryKnobs,
  factsView,
  recallWindow,
  prepareMemoryEntry,
  commitMemoryEntry,
  appendTurn,
  readRecompilePending,
  readAgentBudget,
  readVerification,
  readObservability,
  compactMessages,
  recordCompaction,
  readHooksConfig,
  runHooks,
  appendHistory,
} from "@personaxis/core";
import { slugAddressFromPath } from "../load.js";
import { runCompile } from "../commands/compile.js";
import { buildAwarenessBlock } from "./awareness.js";
import { discoverTree, colorForSlug, type SubPersonaRef } from "./roster.js";
import type { Ctx } from "./types.js";
import { llmConfig, ctxModelArg, buildPolicy, readGoalText, POSTURES } from "./config.js";
import type { AwarenessOpts } from "./awareness.js";
import { shortName, replyLine, phaseFor, renderEvent, friendlyProviderError } from "./render.js";
import { expandFileMentions } from "./mentions.js";
import { recordTurn, recordEvidence, makeCtx, ensureCtxSession } from "./session.js";

/**
 * A turn: the persona CONVERSES and (when needed) USES TOOLS, one governed agent
 * loop, with persistent conversation + the session context meter. This unifies chat
 * and `/do`: natural language can now call tools. Offline (no model) → the honest
 * reflective responder. Identity evolution (the Living Loop) still runs each turn.
 */
/** Session facts for the runtime-context block (V5.P0.1). */
function awarenessOpts(ctx: Ctx, model: string | undefined): AwarenessOpts {
  return {
    frontmatter: ctx.handle.frontmatter as Record<string, unknown>,
    posture: POSTURES[ctx.postureIndex],
    model,
    cwd: process.cwd(),
    // V7.A7: the standing goal rides the runtime context (recency slot), which the
    // model demonstrably reads, instead of being buried mid system prompt.
    goal: readGoalText(ctx.handle),
  };
}

export async function runAgentTurn(line: string, ctx: Ctx): Promise<void> {
  const llm = llmConfig(ctxModelArg(ctx));
  if (!llm) {
    const cur = ensureState(ctx.handle);
    // Offline recall (V2-F1.2): the user profile loads FIRST (name recall works with
    // no model), then the bounded recent window, never a blind last-6 of raw lines.
    const p = ctx.handle.personaPath;
    const knobs = readMemoryKnobs(ctx.handle.frontmatter as Record<string, unknown>);
    const known = factsView(p);
    const memoryLines = [
      ...Object.entries(known.facts).map(([k, v]) => `${k}: ${v.value}`),
      ...recallWindow(p, { maxItems: knobs.maxItems, sessionId: ctx.sessionId }).map((m) => m.content),
    ];
    const reply = await ctx.responder
      .respond({ message: expandFileMentions(line), personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`, awareness: buildAwarenessBlock(p, awarenessOpts(ctx, undefined)), memory: memoryLines, state: cur.values, name: shortName(ctx) })
      .catch((e) => `(responder error: ${friendlyProviderError((e as Error).message)})`);
    ctx.out(replyLine(ctx, reply), "persona");
    await recordTurn(ctx, line, reply);
    await ctx.loop.observe({ observation: line, source: "user", actor: "actor-llm", sessionId: ctx.sessionId }).catch((e) => ctx.out(chalk.dim(`loop skipped: ${(e as Error).message}`)));
    return;
  }

  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  const bus = new EventBus();
  // Which memories were RECALLED to answer this turn (emitted by the agent's resumeContext
  // before the loop listener below exists), collected here for the concise per-turn summary.
  const recalls: string[] = [];
  bus.on((e) => {
    ctx.phase?.(phaseFor(e));
    // V5.FIX.3: human phrasing ("2 user preferences: …"), not the cryptic "kind×N".
    if (e.type === "memory-recall") recalls.push(`${e.count} ${e.kind.replace(/_/g, " ")}${e.detail ? `: ${e.detail}` : ""}`);
    const l = renderEvent(ctx.theme, e);
    if (l) ctx.out(l, "activity");
  });
  const obs = readObservability(fm);
  const tracer = obs.trace !== "off" ? new Tracer(bus, obs) : null;
  const agent = new PersonaAgent({
    llm,
    policy: buildPolicy(ctx),
    personaBody: `You are ${shortName(ctx)}. Stay in character.\n\n${ctx.personaDoc}`,
    awareness: buildAwarenessBlock(ctx.handle.personaPath, awarenessOpts(ctx, llm.model)),
    goal: readGoalText(ctx.handle),
    onApproval: ctx.approve,
    budget: readAgentBudget(fm),
    verification: readVerification(fm),
    judge: { endpoint: llm.endpoint, model: llm.model, apiKey: llm.apiKey },
    personaPath: ctx.handle.personaPath,
    sessionId: ctx.sessionId,
    meter: ctx.meter,
    priorMessages: ctx.conversation,
    // V7.A1: a posture change is announced as an EPHEMERAL SYSTEM MESSAGE so the model
    // re-evaluates what it declined under a stricter posture. It used to be glued in
    // front of the user's text, which made the model answer the environment note as if
    // the user had written it ("thanks for restoring my access!" out of nowhere).
    envNote: ctx.pendingEnvNote,
    bus,
  });
  ctx.pendingEnvNote = undefined;
  const result = await agent.run(line);
  ctx.conversation = (agent.lastMessages ?? []).filter((m) => m.role !== "system");
  ctx.out(replyLine(ctx, result.summary || "…"), "persona");
  // Cumulative session accounting (F3.D16: /cost, /usage).
  ctx.usage.turns += 1;
  ctx.usage.tokens += result.budget.tokens;
  ctx.usage.costUsd += result.budget.costUsd;
  ctx.usage.steps += result.budget.steps;
  // V5.P1.2: per-model breakdown for Settings > Usage.
  const bm = (ctx.usage.byModel ??= {});
  const slot = (bm[llm.model] ??= { turns: 0, tokens: 0, costUsd: 0 });
  slot.turns += 1;
  slot.tokens += result.budget.tokens;
  slot.costUsd += result.budget.costUsd;
  await recordTurn(ctx, line, result.summary || "…");
  // Only surface the budget line when something noteworthy happened (a multi-step
  // task or an early stop), not on every one-shot chat reply.
  if (result.budget.steps > 1 || (result.budget.stoppedBy && result.budget.stoppedBy !== "goal_met")) {
    ctx.out(chalk.dim(`  budget: ${result.budget.steps} steps · ${result.budget.tokens} tok · $${result.budget.costUsd}` + (result.budget.stoppedBy && result.budget.stoppedBy !== "goal_met" ? ` · stopped: ${result.budget.stoppedBy}` : "")));
  }
  if (tracer) {
    const { paths } = tracer.write(ctx.handle.personaPath);
    tracer.stop();
    for (const p of paths) ctx.out(chalk.dim(`  trace → ${p}`));
  }
  // Identity evolution runs without the observe/appraise/govern noise, but we DO
  // surface a concise, meaningful summary of what actually happened this turn:
  // which envelope changed, whether memory was written, whether PERSONA.md recompiled.
  const changed: string[] = [];
  let memWrites = 0;
  const memWriteKinds: string[] = []; // snippets of episodic memory CREATED this turn
  const memKinds: string[] = [];
  const evals: string[] = []; // individual quality scores (target · dimension · score)
  const selfEdits: string[] = [];
  const off = ctx.loop.on((e) => {
    if (e.type === "mutate" && e.result && !e.result.blocked && e.result.from !== e.result.to) {
      changed.push(`${e.result.field} ${e.result.from.toFixed(2)}→${e.result.to.toFixed(2)}${e.result.clamped ? " clamped" : ""}`);
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
      // FASE 7 P2: the theorem made visible, stage the band-crossing moment
      // (field pulses, the new band's prose lands, then a committed summary).
      ctx.onMoment?.(e.crossings);
    }
    // NB: within-band ticks emit no recompile; the fast .live.json marker stays internal.
  });
  await ctx.loop.observe({ observation: line, source: "user", actor: "actor-llm", sessionId: ctx.sessionId }).catch(() => {});
  off();
  // Per-turn telemetry as a distinct, labeled BLOCK (one line per fact) so it never blends into
  // the persona's reply above. Rendered dim, with a gutter (┊) and an aligned label; only the
  // rows that actually happened appear.
  // V5.P3.5: multi-value facts get ONE LINE PER ITEM under their label (the old
  // comma-run made "recalled a, b, c, d" unreadable); the block opens with a
  // dim title so it reads as a unit, never as part of the reply.
  const rows: Array<[string, string]> = [];
  const pushAll = (label: string, values: string[], cap = 5): void => {
    values.slice(0, cap).forEach((v, i) => rows.push([i === 0 ? label : "", v]));
    if (values.length > cap) rows.push(["", `… +${values.length - cap} more`]);
  };
  // Recalled memory shows COMPLETE: no "+N more" hiding what the persona actually read.
  if (recalls.length) pushAll("recalled", recalls, Number.POSITIVE_INFINITY);
  if (changed.length) pushAll("evolved", changed);
  if (selfEdits.length) pushAll("self-edit", selfEdits);
  if (memWrites) rows.push(["memory", `+${memWrites} episodic` + (memWriteKinds.length ? ` (${memWriteKinds[memWriteKinds.length - 1]})` : "")]);
  for (const k of memKinds) rows.push(["memory", k]);
  if (evals.length) pushAll("evaluated", evals, 4);
  if (rows.length) {
    const block = [
      chalk.dim(`  ┊ ${chalk.bold("this turn")}`),
      ...rows.map(([label, value]) => chalk.dim(`  ┊ ${chalk.cyan(label.padEnd(9))} ${value}`)),
    ];
    ctx.out("", "activity"); // blank line separates the telemetry block from the reply
    for (const l of block) ctx.out(l, "activity");
    // Recorded so a resumed session reprints the WORK, not just the words.
    //
    // Its own append-only entry rather than a field on the reply, because the
    // evidence only EXISTS after the loop tick, which runs after the turn is
    // already persisted. Rewriting a written line to attach it would break the
    // one property this log has. `role: "note"` keeps it out of what the model
    // sees on reload, so replaying costs no context.
    recordEvidence(ctx, block);
  }

  // A governed self-edit may have marked the compiled doc stale. Do NOT recompile inline, 
  // a full LLM compile would block every single turn (the "stuck thinking" hang). Just
  // surface it; recompile happens on /compile, on /review approve, or on exit.
  if (readRecompilePending(ctx.handle.personaPath).pending) {
    ctx.out(chalk.dim("  · PERSONA.md stale (self-edits applied), /compile to refresh"));
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
    ctx.out(chalk.dim("  · PERSONA.md is stale, run `personaxis compile` to refresh it"));
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
      break; // unknown, leave it in the message
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
  // (buildAwarenessBlock), which covers root AND every sub, so we no longer bake it
  // into personaDoc here.
  return { subs, color: (a) => subColor.get(a), getSub };
}

/**
 * V2-F3.A3: when the model's context window is filling up, auto-summarize older
 * turns (once, with a visible notice) instead of waiting for a manual /compact.
 * Best-effort: needs a model, and never breaks the turn on failure.
 */
export async function maybeAutoCompact(ctx: Ctx, threshold = 0.85): Promise<void> {
  const llm = llmConfig(ctxModelArg(ctx));
  if (!llm || ctx.meter.pct < threshold) return;
  try {
    const r = await compactMessages([{ role: "system", content: "" }, ...ctx.conversation], ctx.meter, { llm, threshold });
    if (!r.compacted) return;
    ctx.conversation = r.messages.filter((m) => m.role !== "system");
    if (r.summary) {
      ensureCtxSession(ctx, ctx.conversation[0]?.content ?? "session");
      recordCompaction(ctx.handle.personaPath, ctx.sessionId, r.summary);
    }
    ctx.out(chalk.dim(`  · context auto-compacted (${r.removed} msg freed, ${Math.round(ctx.meter.pct * 100)}% full)`), "activity");
  } catch {
    /* best-effort; a failed compaction must never break the turn */
  }
}

/**
 * Route one user line to the ROOT or to addressed sub-personas (@address/@all). Replies come
 * from each target; every delegation is recorded in the root's hash-chained memory.
 */
export async function dispatchTurn(line: string, rootCtx: Ctx, roster: Roster, setPhase?: (s: string) => void): Promise<void> {
  // V6.10: every user turn lands in the GLOBAL cross-project history
  // (~/.personaxis/history.jsonl), the same pattern ~/.claude/history.jsonl uses.
  appendHistory({ cwd: process.cwd(), persona: rootCtx.name, prompt: line });
  // User hooks (V2-F3.C14): a UserPromptSubmit hook may observe or block the prompt.
  try {
    const pre = await runHooks("UserPromptSubmit", { prompt: line }, readHooksConfig(rootCtx.handle.personaPath));
    if (pre.blocked) {
      rootCtx.out(chalk.yellow("  · prompt blocked by a UserPromptSubmit hook"), "activity");
      return;
    }
  } catch {
    /* hooks are best-effort; never break the turn */
  }
  const { targets, rest } = parseMentions(line, roster.subs);
  const msg = rest || line;
  if (targets.length === 0) {
    await handleTurn(msg, rootCtx);
    await maybeAutoCompact(rootCtx);
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
    // enables episodic memory (honors memory.types.episodic, fixes the prior leak).
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
  await maybeAutoCompact(rootCtx);
}
