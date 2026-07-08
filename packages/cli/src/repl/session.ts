/**
 * REPL session lifecycle (F3.6 split).
 *
 * Building a per-persona `Ctx` (root or sub-persona), lazily creating the
 * on-disk session header, and recording each completed user/assistant exchange
 * (with a one-time LLM auto-name). All session logging is best-effort — it never
 * breaks a turn.
 */

import { stdout } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import {
  LivingLoop,
  loadPersona,
  ensureState,
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
  type ContextMeter,
} from "@personaxis/core";
import { isSubagentPath, slugAddressFromPath } from "../load.js";
import type { Ctx } from "./types.js";
import { POSTURES, pickAppraiser, pickResponder, llmConfig, ctxModelArg } from "./config.js";

/**
 * Build a REPL context for ANY persona (root or a sub-persona), sharing the session
 * meter. The compiled system prompt is resolved per the artifact model: a sub-persona's
 * lives INSIDE its folder (./PERSONA.md), the root's at the repo root (../PERSONA.md).
 * `out`/`approve`/`phase` default here; the active mode runner rebinds them to the screen.
 */
export function makeCtx(personaPath: string, meter: ContextMeter, replyColor?: number): Ctx {
  const handle = loadPersona(personaPath);
  ensureState(handle);
  const isSub = isSubagentPath(personaPath);
  const compiled = isSub
    ? join(dirname(personaPath), "PERSONA.md")
    : resolve(dirname(dirname(personaPath)), "PERSONA.md");
  const personaDoc = existsSync(compiled) ? readFileSync(compiled, "utf-8") : handle.body;
  const modelArg = { personaPath, frontmatter: handle.frontmatter as Record<string, unknown> };
  const loop = new LivingLoop(personaPath, {
    appraiser: pickAppraiser(modelArg),
    // F6.5: the inline recompile is REAL — on a band crossing the stage-1
    // assembler rewrites the compiled doc deterministically (band-selected
    // expression from fresh state; F3.1's `assemble` seam, finally wired).
    recompile: makeRecompileHook({
      compiledPath: existsSync(compiled) ? compiled : undefined,
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
          stateValues: existsSync(h.statePath) ? readState(h.statePath).values : undefined,
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
    replyColor,
  };
}

/** Lazily create the on-disk session (header) for a ctx, seeded by the first message. */
export function ensureCtxSession(ctx: Ctx, seedMsg: string): void {
  if (ctx.sessionStarted) return;
  const isSub = isSubagentPath(ctx.handle.personaPath);
  const address = slugAddressFromPath(ctx.handle.personaPath);
  ensureSession(ctx.handle.personaPath, {
    id: ctx.sessionId,
    kind: isSub ? "sub" : "root",
    participants: [address || "(root)"],
    name: fallbackName(seedMsg),
    created: new Date().toISOString(),
    persona: address,
  });
  ctx.sessionStarted = true;
}

/** Append a completed user/assistant exchange to the persona's session; auto-name once. */
export async function recordTurn(ctx: Ctx, userMsg: string, assistantMsg: string): Promise<void> {
  try {
    ensureCtxSession(ctx, userMsg);
    const from = slugAddressFromPath(ctx.handle.personaPath) || "(root)";
    appendTurn(ctx.handle.personaPath, ctx.sessionId, { role: "user", content: userMsg });
    appendTurn(ctx.handle.personaPath, ctx.sessionId, { role: "assistant", content: assistantMsg, from });
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
