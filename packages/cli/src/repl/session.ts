/**
 * REPL session lifecycle (F3.6 split).
 *
 * Building a per-persona `Ctx` (root or sub-persona), lazily creating the
 * on-disk session header, and recording each completed user/assistant exchange
 * (with a one-time LLM auto-name). All session logging is best-effort, it never
 * breaks a turn.
 */

import { stdout } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import {
  run,
  loadPersona,
  stateOf,
  displayName,
  readMode,
  personaTheme,
  policyFromFrontmatter,
  newSessionId,
  ensureSession,
  appendTurn,
  renameSession,
  fallbackName,
  nameSession,
  makeRecompileHook,
  assemblePersonaDoc,
  activeOverlay,
  readState,
  readMemoryTypes,
  readWritePolicy,
  readConsolidationMode,
  readMemoryKnobs,
  distillSession,
  consolidateSemantic,
  pruneMemory,
  listSessions,
  findSession,
  loadConversation,
  readSession,
  readAutobiographical,
  appendAutobiographical,
  recordSessionStats,
  type ContextMeter,
  type SessionSummary,
  type SessionKind,
} from "@personaxis/core";
import chalk from "chalk";
import { isSubagentPath, slugAddressFromPath, compiledPathFor } from "../load.js";
import { replyLine, userLine } from "./render.js";
import type { Ctx } from "./types.js";
import type { LineRole } from "@personaxis/tui/screen";
import { POSTURES, pickAppraiser, pickResponder, llmConfig, ctxModelArg } from "./config.js";

/**
 * Build a REPL context for ANY persona (root or a sub-persona), sharing the session
 * meter. The compiled system prompt is resolved per the artifact model: a sub-persona's
 * lives INSIDE its folder (./PERSONA.md), the root's at the repo root (../PERSONA.md).
 * `out`/`approve`/`phase` default here; the active mode runner rebinds them to the screen.
 */
export function makeCtx(personaPath: string, meter: ContextMeter, replyColor?: number): Ctx {
  // One read, one place. The paths this implies used to be derived here and, in the
  // SDK, derived differently: it looked for the compiled document beside the spec,
  // which is only where a SUB-persona's lives, so an ordinary project got the raw body.
  const assembled = run.assemble(personaPath);
  const handle = assembled.handle;
  const isSub = run.isSubagentPath(personaPath);
  const compiled = assembled.compiledPath;
  const personaDoc = run.identityOf(assembled);
  const modelArg = { personaPath, frontmatter: handle.frontmatter as Record<string, unknown> };
  const loop = run.evolverFor(modelArg, {
    // F6.5: the inline recompile is REAL, on a band crossing the stage-1
    // assembler rewrites the compiled doc deterministically (band-selected
    // expression from fresh state; F3.1's `assemble` seam, finally wired).
    recompile: makeRecompileHook({
      // Always pass the canonical path: the hook itself no-ops while the file does not
      // exist, and starts keeping it fresh the moment the first /compile creates it.
      compiledPath: compiled,
      assemble: (h) =>
        assemblePersonaDoc({
          persona: h.frontmatter as Record<string, unknown>,
          target: {
            name: displayName(h.frontmatter),
            isSubagent: isSub,
            ...(isSub ? { slug: slugAddressFromPath(personaPath) } : {}),
            resourceBase: isSub ? "./" : "./.personaxis/",
          },
          appliedOverlay: activeOverlay(personaPath),
          // Undefined when the persona has not started. Building a session must not
          // bring one into existence as a side effect of describing it.
          stateValues: stateOf(h)?.values,
        }),
    }),
  });
  let postureIndex = POSTURES.indexOf(policyFromFrontmatter(handle.frontmatter as Record<string, unknown>).sandbox);
  if (postureIndex < 0) postureIndex = 1;
  return {
    handle,
    loop,
    responder: pickResponder(modelArg),
    theme: personaTheme(handle.frontmatter),
    name: displayName(handle.frontmatter),
    mode: readMode(handle.frontmatter as Record<string, unknown>, handle.personaPath),
    out: (t) => stdout.write(t + "\n"),
    postureIndex,
    approve: async () => "deny",
    personaDoc,
    conversation: [],
    sessionId: newSessionId(),
    sessionStarted: false,
    sessionNamed: false,
    meter,
    usage: { turns: 0, tokens: 0, costUsd: 0, steps: 0 },
    presence: { activity: "idle" },
    replyColor,
  };
}

/**
 * The session's conversation, as the port whatever runs the turn reads and writes.
 *
 * A lens onto `ctx.conversation` rather than a copy of it, because `/compact` and
 * `/resume` replace that array outright and a port holding its own list would keep
 * handing the loop the conversation the session used to have.
 *
 * The system message is dropped on the way in. It is built fresh for each request from
 * the persona's current identity, so carrying an old one forward would hand the model a
 * description of who this persona used to be.
 */
export function conversationOf(ctx: Ctx): run.Conversation {
  return {
    read: () => ctx.conversation,
    write: (messages) => {
      ctx.conversation = messages.filter((m) => m.role !== "system");
    },
  };
}

/** Lazily create the on-disk session (header) for a ctx, seeded by the first message. */
export function ensureCtxSession(ctx: Ctx, seedMsg: string, kind?: SessionKind): void {
  if (ctx.sessionStarted) return;
  const isSub = isSubagentPath(ctx.handle.personaPath);
  const address = slugAddressFromPath(ctx.handle.personaPath);
  ensureSession(ctx.handle.personaPath, {
    id: ctx.sessionId,
    // A background run labels itself, so its turns are identifiable later without being
    // treated differently by anything that reads them.
    kind: kind ?? (isSub ? "sub" : "root"),
    participants: [address || "(root)"],
    name: fallbackName(seedMsg),
    created: new Date().toISOString(),
    persona: address,
  });
  ctx.sessionStarted = true;
}

/**
 * Close the conversation session (V2-F1.3), the moment raw dialog becomes durable
 * memory: distill the session's facts/decisions/event into the episodic ledger
 * (back-referenced, not copied), consolidate memory.md when the spec says auto,
 * apply the retention window, and record the first-conversation milestone.
 * Idempotent per ctx (guarded by ctx.sessionClosed); best-effort by design.
 */
export function closeSession(ctx: Ctx): void {
  if (!ctx.sessionStarted || ctx.sessionClosed) return;
  ctx.sessionClosed = true;
  const p = ctx.handle.personaPath;
  const fm = ctx.handle.frontmatter as Record<string, unknown>;
  try {
    const memTypes = readMemoryTypes(fm);
    if (memTypes.episodic && readWritePolicy(fm).default !== "ephemeral") {
      distillSession(p, ctx.sessionId);
    }
    if (memTypes.autobiographical && listSessions(p).length === 1) {
      const already = readAutobiographical(p).some((e) => e.tags.includes("first-conversation"));
      if (!already) appendAutobiographical(p, { event: "first conversation with the user", tags: ["milestone", "first-conversation"] });
    }
    if (memTypes.semantic && readConsolidationMode(fm) === "auto") consolidateSemantic(p);
    pruneMemory(p, readMemoryKnobs(fm).retentionDays);
    // V6.10: fold this session's per-model usage into the global stats cache
    // (~/.personaxis/stats-cache.json), so Settings > Stats draws tokens/day
    // per model instantly, across every project.
    if (ctx.usage.byModel && Object.keys(ctx.usage.byModel).length) recordSessionStats(ctx.usage.byModel);
  } catch {
    /* closing must never block exit */
  }
}

/**
 * Load a saved conversation into a ctx (the shared body of `/resume` and the
 * `--continue`/`--resume` startup flags). Returns the resolved session, or
 * undefined when nothing matched.
 */
export function resumeSessionInto(ctx: Ctx, query: string): SessionSummary | undefined {
  const s = query ? findSession(ctx.handle.personaPath, query) : listSessions(ctx.handle.personaPath)[0];
  if (!s) return undefined;
  // V7.A6: closing the CURRENT session first is what makes resuming a switch rather
  // than a merge; without it the outgoing conversation would never be distilled.
  if (ctx.sessionStarted && ctx.sessionId !== s.id) closeSession(ctx);
  const conv = loadConversation(ctx.handle.personaPath, s.id);
  ctx.conversation = conv;
  ctx.sessionId = s.id;
  ctx.sessionStarted = true;
  ctx.sessionNamed = true;
  ctx.sessionClosed = false;
  ctx.meter.estimate([{ role: "system", content: "" }, ...conv]);
  // Tell the MODEL that the restored history is its own.
  //
  // Without this it treats those messages as somebody else's transcript and
  // refuses on principle ("I cannot access previous sessions") while the answer
  // sits in its context: it had the words and would quote them verbatim when
  // asked to repeat a literal string, but denied "remembering" anything. That
  // reads as a broken resume and, worse, as a persona being untruthful about
  // what it knows. Delivered as SYSTEM speech, never glued to the user's text.
  if (conv.length > 0) {
    ctx.pendingEnvNote =
      `The conversation above is YOUR OWN earlier exchange with this same person, in this same ` +
      `session ("${s.name}"), which has just been resumed. It is your memory of this conversation, ` +
      `not a transcript of someone else's: answer questions about it directly and quote it when ` +
      `asked. Do not claim you cannot access previous sessions.`;
  }
  return s;
}

/**
 * The resumed conversation, rendered as the transcript lines the session would have left
 * on screen. Resuming REBUILDS the chat you left: the caller clears the screen and prints
 * these, so the old conversation reappears as it was instead of being appended under
 * whatever belonged to a different one.
 */
export function replayTranscript(ctx: Ctx): Array<{ text: string; role: LineRole }> {
  const out: Array<{ text: string; role: LineRole }> = [];
  const push = (text: string, role: LineRole): void => void out.push({ text, role });

  // Built from the RECORD on disk, not from ctx.conversation: the conversation is
  // only what the model sees (role + content), while the file also holds the
  // evidence notes. Rebuilding the chat means rebuilding what was on SCREEN.
  const turns = ctx.sessionId ? readSession(ctx.handle.personaPath, ctx.sessionId).turns : [];
  if (turns.length === 0) {
    // No session file (a conversation held in memory): replay what we have.
    for (const m of ctx.conversation) {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (!content.trim()) continue;
      if (m.role === "user") {
        push("", "divider");
        push(userLine(content), "user");
      } else if (m.role === "assistant") {
        push(replyLine(ctx, content), "persona");
        push("", "system");
      }
    }
    return out;
  }

  // A /compact checkpoint REPLACES everything before it, exactly as loadConversation
  // does, so the rebuilt screen matches the context the persona actually carries.
  let start = 0;
  for (let i = 0; i < turns.length; i++) if (turns[i].role === "summary") start = i;
  if (turns[start]?.role === "summary") {
    push("", "divider");
    push(chalk.dim(`  ┊ earlier conversation, compacted: ${turns[start].content.slice(0, 120)}`), "activity");
    start += 1;
  }

  for (let i = start; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === "user") {
      // The same chrome a live turn gets: a divider opens each exchange, so a long
      // history reads as a conversation rather than one uninterrupted block.
      push("", "divider");
      push(userLine(t.content), "user");
    } else if (t.role === "assistant") {
      push(replyLine(ctx, t.content), "persona");
      // A trailing gap unless the evidence note follows, which carries its own.
      if (turns[i + 1]?.role !== "note") push("", "system");
    } else if (t.role === "note" && t.evidence?.length) {
      push("", "activity");
      for (const l of t.evidence) push(l, "activity");
      push("", "system");
    }
  }
  return out;
}

/**
 * Record the "this turn" evidence block against the exchange just written.
 *
 * Append-only, as a `note`: the block is only known after the loop tick, which
 * runs once the turn is already on disk. `loadConversation` skips notes, so this
 * costs the model nothing on reload and exists purely so `/resume` can rebuild
 * what the screen showed.
 */
export function recordEvidence(ctx: Ctx, block: string[]): void {
  if (!block.length || !ctx.sessionStarted) return;
  try {
    appendTurn(ctx.handle.personaPath, ctx.sessionId, { role: "note", content: "this turn", evidence: block });
  } catch {
    /* evidence is a nicety; never break a turn over it */
  }
}

/**
 * Append a completed exchange to the persona's session; auto-name once.
 *
 * `spoken: false` records the reply as a NOTE instead of as the persona's words. It is
 * for a turn that failed, where the text is the runtime saying what went wrong. Notes
 * are dropped by `loadConversation`, so a resumed session does not hand the model
 * "agent error: connection refused" as something this persona once said, and the
 * transcript does not quote a component under the persona's name.
 */
export async function recordTurn(
  ctx: Ctx,
  userMsg: string,
  assistantMsg: string,
  kind?: SessionKind,
  spoken = true,
): Promise<void> {
  try {
    ensureCtxSession(ctx, userMsg, kind);
    const from = slugAddressFromPath(ctx.handle.personaPath) || "(root)";
    appendTurn(ctx.handle.personaPath, ctx.sessionId, { role: "user", content: userMsg });
    appendTurn(ctx.handle.personaPath, ctx.sessionId, {
      role: spoken ? "assistant" : "note",
      content: assistantMsg,
      from,
    });
    if (!ctx.sessionNamed) {
      ctx.sessionNamed = true;
      const llm = llmConfig(ctxModelArg(ctx));
      if (llm) {
        try {
          renameSession(ctx.handle.personaPath, ctx.sessionId, await nameSession(llm, userMsg));
        } catch {
          /* keep the deterministic fallback name */
        }
      }
    }
  } catch {
    /* session logging is best-effort and must never break a turn */
  }
}
