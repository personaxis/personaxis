/**
 * Persona service — the engine operations the MCP tools wrap.
 *
 * Each function takes an explicit persona path so a host can drive multiple
 * personas. All mutation goes through the same clamp + audit engine the CLI and
 * runtime use; nothing here bypasses the governance gate or the universal
 * invariants.
 */

import {
  LivingLoop,
  HeuristicAppraiser,
  loadPersona,
  writeState,
  ensureState,
  extractEnvelopes,
  applyMutation,
  readMemory,
  readLiveMemory,
  tombstoneMemory,
  verifyMemoryChain,
  detectMemoryAnomalies,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";

export function compiledDocument(persona: string): string {
  return loadPersona(persona).body;
}

export function stateSummary(persona: string): unknown {
  const h = loadPersona(persona);
  const st = ensureState(h);
  return {
    persona_id: st.persona_id,
    persona_version: st.persona_version,
    values: st.values,
    mutation_count: st.mutation_log.length,
    recent_mutations: st.mutation_log.slice(-5),
  };
}

export function envelopes(persona: string): unknown {
  const h = loadPersona(persona);
  const { envelopes, hardEnforcedVirtues } = extractEnvelopes(h.frontmatter);
  return { mutable_fields: envelopes, hard_enforced_virtues: hardEnforcedVirtues };
}

export function adjustState(
  persona: string,
  field: string,
  delta: number,
  reason: string,
): unknown {
  const h = loadPersona(persona);
  const env = extractEnvelopes(h.frontmatter);
  const state = ensureState(h);
  const result = applyMutation(state, env.envelopes, {
    field,
    delta,
    reason,
    actor: "actor-llm",
  });
  writeState(h.statePath, state);
  return {
    field,
    from: result.from,
    to: result.to,
    clamped: result.clamped,
    blocked: result.blocked,
    audit: result.entry,
  };
}

export async function observe(
  persona: string,
  observation: string,
  source: ProvenanceSource,
): Promise<unknown> {
  const events: LoopEvent[] = [];
  ensureState(loadPersona(persona)); // seed state.json if missing
  const loop = new LivingLoop(persona, { appraiser: new HeuristicAppraiser() });
  loop.bus.on((e) => events.push(e));
  const report = await loop.tick({ observation, source });
  return { report, events };
}

export function audit(persona: string): unknown {
  const h = loadPersona(persona);
  const st = ensureState(h);
  const chain = verifyMemoryChain(persona);
  const mem = readMemory(persona);
  return {
    mutation_log: st.mutation_log.slice(-10),
    memory_entries: mem.length,
    memory_chain_intact: chain.ok,
    memory_chain_broken_at: chain.brokenAt ?? null,
    anomalies: detectMemoryAnomalies(mem),
  };
}

/** Honor deletion_policy.user_request_supported: tombstone a memory entry. */
export function forget(persona: string, targetHash: string, reason: string): unknown {
  const entry = tombstoneMemory(persona, targetHash, reason);
  return { tombstoned: targetHash, by: entry.hash, live_entries: readLiveMemory(persona).length };
}
