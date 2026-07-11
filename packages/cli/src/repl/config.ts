/**
 * REPL configuration + model/policy resolution (F3.6 split).
 *
 * Persona-path resolution, the layered model resolver, appraiser/responder
 * selection, the sandbox posture list + policy assembly, and the context meter.
 * Pure helpers over core; no other repl module depends the other way.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import {
  resolveModel,
  describeModel,
  HeuristicAppraiser,
  LlmAppraiser,
  LlmResponder,
  ReflectiveResponder,
  policyFromFrontmatter,
  resolveEffectivePersona,
  ContextMeter,
  cachedContextWindow,
  resolveContextWindow,
  type Appraiser,
  type Responder,
  type Policy,
  type SandboxMode,
  type PersonaHandle,
} from "@personaxis/core";
import { slugChainFromPath } from "../load.js";
import type { Ctx } from "./types.js";

export const CANDIDATES = [".personaxis/personaxis.md", ".personaxis/PERSONA.md", "personaxis.md", "PERSONA.md"];
export const POSTURES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

export function resolvePersonaPath(opt?: string): string | null {
  if (opt) {
    if (existsSync(resolve(opt))) return resolve(opt);
    // Not a path → treat as a global/overlay persona slug (G5 reuse).
    if (!opt.includes("/") && !opt.includes("\\")) {
      const eff = resolveEffectivePersona(process.cwd(), opt);
      if (eff.scope !== "none" && existsSync(eff.path)) return eff.path;
    }
    return null;
  }
  for (const c of CANDIDATES) {
    const p = resolve(c);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Record that the sandbox posture changed, so the next turn nudges the model to re-evaluate.
 * Exported for tests. */
export function notePostureChange(ctx: { postureIndex: number; pendingEnvNote?: string }): void {
  const posture = POSTURES[ctx.postureIndex];
  const permission =
    posture === "read-only"
      ? "You may run read-only commands but NOT write files or access the network."
      : posture === "workspace-write"
        ? "You may now read/run commands AND write files within the workspace (network still restricted)."
        : "You now have full access: read, write, network, and destructive commands are permitted.";
  ctx.pendingEnvNote = `[environment change] The sandbox posture is now "${posture}". ${permission} Re-evaluate, and if appropriate, retry, any request you previously declined due to a stricter posture.`;
}

/**
 * The resolved model for the (optionally persona-scoped) session. Delegates to core's layered
 * resolveModel: env > frontmatter.runtime > per-persona config > project config > global config.
 */
export function llmConfig(ctx?: { personaPath?: string; frontmatter?: Record<string, unknown> }): { endpoint: string; model: string; apiKey?: string } | undefined {
  return resolveModel({ personaPath: ctx?.personaPath, frontmatter: ctx?.frontmatter, cwd: process.cwd() });
}

/** Convenience: build the llmConfig arg from a Ctx (its persona path + frontmatter). */
export function ctxModelArg(ctx: Ctx): { personaPath: string; frontmatter: Record<string, unknown> } {
  return { personaPath: ctx.handle.personaPath, frontmatter: ctx.handle.frontmatter as Record<string, unknown> };
}

export function pickAppraiser(arg?: { personaPath?: string; frontmatter?: Record<string, unknown> }): Appraiser {
  const llm = llmConfig(arg);
  return llm ? new LlmAppraiser(llm) : new HeuristicAppraiser();
}
export function pickResponder(arg?: { personaPath?: string; frontmatter?: Record<string, unknown> }): Responder {
  const llm = llmConfig(arg);
  return llm ? new LlmResponder(llm) : new ReflectiveResponder();
}
export function appraiserLabel(arg?: { personaPath?: string; frontmatter?: Record<string, unknown> }): string {
  return describeModel({ personaPath: arg?.personaPath, frontmatter: arg?.frontmatter, cwd: process.cwd() });
}

/**
 * Cross-persona isolation (read-only across the roster): a persona may READ any other
 * persona's files but never WRITE them. Deny-list regexes match writes into the
 * `.personaxis/personas/` tree outside the persona's OWN subtree.
 */
export function crossPersonaDenies(personaPath: string): string[] {
  const tree = "\\.personaxis[\\\\/]+personas[\\\\/]+";
  const chain = slugChainFromPath(personaPath);
  if (chain.length === 0) return [tree]; // root: writes none of the personas tree
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const own = chain.map(esc).join("[\\\\/]+personas[\\\\/]+") + "[\\\\/]";
  return [`${tree}(?!${own})`];
}

export function buildPolicy(ctx: Ctx): Policy {
  const base = policyFromFrontmatter(ctx.handle.frontmatter as Record<string, unknown>, process.cwd());
  return {
    ...base,
    sandbox: POSTURES[ctx.postureIndex],
    deny: [...base.deny, ...crossPersonaDenies(ctx.handle.personaPath)],
  };
}

export function readGoalText(handle: PersonaHandle): string | undefined {
  const goalPath = join(dirname(handle.personaPath), "goal.json");
  if (!existsSync(goalPath)) return undefined;
  try {
    return (JSON.parse(readFileSync(goalPath, "utf-8")) as { text?: string }).text;
  } catch {
    return undefined;
  }
}

export function makeMeter(): ContextMeter {
  const llm0 = llmConfig();
  const meter = new ContextMeter(llm0 ? cachedContextWindow(llm0.model) : 0);
  if (llm0) void resolveContextWindow(llm0).then((w) => (meter.limit = w)).catch(() => {});
  return meter;
}
