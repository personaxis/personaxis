/**
 * @personaxis/sdk — embed a living, governed persona in a Node/TS backend (Modo 2 self-host).
 *
 * A thin, ergonomic wrapper over @personaxis/core: the engine already does the governance (clamp +
 * audit + injection scan + hash-chained memory); this SDK gives an app a small, obvious surface to
 * drive it per end-user interaction. The API key/model resolve through core's layered config
 * (env > project > global), so production reads the key from the deploy's secret manager.
 *
 * Example:
 *   import { Persona } from "@personaxis/sdk";
 *   const persona = new Persona("./.personaxis/personas/support/personaxis.md");
 *   const systemPrompt = persona.compiledIdentity();         // system-prompt slot #1
 *   await persona.observe("the customer is frustrated about billing", "user"); // learn (our model)
 *   const { values } = persona.state();                       // current affect/mood dials
 */

import {
  LivingLoop,
  HeuristicAppraiser,
  LlmAppraiser,
  resolveModel,
  loadPersona,
  ensureState,
  readState,
  writeState,
  withStateLock,
  extractEnvelopes,
  applyMutation,
  readMemory,
  verifyMemoryChain,
  detectMemoryAnomalies,
  readRecompilePending,
  type PersonaHandle,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ObserveResult {
  report: { mutationsApplied: number; memoriesWritten: number; abstained: boolean };
  events: LoopEvent[];
  /** True if a governed self-edit left the compiled PERSONA.md stale (call `personaxis compile`). */
  recompilePending: boolean;
}

export interface PersonaStateView {
  values: Record<string, number>;
  recentMutations: unknown[];
}

export interface PersonaAuditView {
  mutationCount: number;
  memoryEntries: number;
  memoryChainIntact: boolean;
  anomalies: unknown[];
}

/** A live persona bound to its `personaxis.md` spec (its state.json + memory live alongside it). */
export class Persona {
  readonly personaPath: string;
  private handle: PersonaHandle;

  constructor(personaPath: string) {
    this.personaPath = resolve(personaPath);
    this.handle = loadPersona(this.personaPath);
    ensureState(this.handle);
  }

  /** The compiled, LLM-facing identity document (load as system-prompt slot #1). Falls back to the
   * spec body if PERSONA.md hasn't been compiled yet. */
  compiledIdentity(): string {
    const compiled = join(dirname(this.personaPath), "PERSONA.md");
    return existsSync(compiled) ? readFileSync(compiled, "utf-8") : this.handle.body;
  }

  /** Current runtime state: envelope values + the last few audited mutations. */
  state(): PersonaStateView {
    const st = readState(this.handle.statePath);
    return { values: st.values, recentMutations: st.mutation_log.slice(-5) };
  }

  /**
   * Run ONE governed Living-Loop cycle on an observation, on the persona's resolved model
   * (falls back to the deterministic heuristic appraiser if no model is configured). Every mutation
   * is clamped + audited; a malicious observation is injection-scanned and cannot steer evolution.
   */
  async observe(observation: string, source: ProvenanceSource = "user"): Promise<ObserveResult> {
    const m = resolveModel({ personaPath: this.personaPath, frontmatter: this.handle.frontmatter as Record<string, unknown> });
    const events: LoopEvent[] = [];
    const loop = new LivingLoop(this.personaPath, {
      appraiser: m ? new LlmAppraiser({ ...m, timeoutMs: 30_000 }) : new HeuristicAppraiser(),
    });
    loop.bus.on((e) => events.push(e));
    const report = await loop.tick({ observation, source });
    return { report, events, recompilePending: readRecompilePending(this.personaPath).pending };
  }

  /** Apply a single clamped, audited mutation to an envelope field (the spec's adjust_persona_state). */
  adjust(field: string, delta: number, reason: string): ReturnType<typeof applyMutation> {
    const env = extractEnvelopes(this.handle.frontmatter);
    // Locked read→apply→write: an embedding app may run ticks/adjusts concurrently (F1.4).
    return withStateLock(this.handle.statePath, () => {
      const st = readState(this.handle.statePath);
      const result = applyMutation(st, env.envelopes, { field, delta, reason, actor: "actor-llm" });
      writeState(this.handle.statePath, st);
      return result;
    });
  }

  /** Integrity view: mutation count, memory size, hash-chain validity, detected anomalies. */
  audit(): PersonaAuditView {
    const st = readState(this.handle.statePath);
    const mem = readMemory(this.personaPath);
    return {
      mutationCount: st.mutation_log.length,
      memoryEntries: mem.length,
      memoryChainIntact: verifyMemoryChain(this.personaPath).ok,
      anomalies: detectMemoryAnomalies(mem),
    };
  }

  /** Reload the spec from disk (e.g. after an external recompile/decompile). */
  reload(): void {
    this.handle = loadPersona(this.personaPath);
  }
}

export { resolveModel } from "@personaxis/core";
