/**
 * F3.4, state.json as a rebuildable checkpoint of the mutation_log.
 */
import { describe, it, expect } from "vitest";
import { rebuildStateValues, rebuildState, type Envelope, type StateFile, type MutationLogEntry } from "../src/index.js";

const envelopes: Record<string, Envelope> = {
  "mood.tone": { mean: 0, min: -1, max: 1 },
  "traits.openness": { mean: 0.8, min: 0.65, max: 0.92 },
};

function entry(field: string, from: number, to: number, extra: Partial<MutationLogEntry> = {}): MutationLogEntry {
  return {
    ts: "2026-07-04T00:00:00Z",
    field,
    from,
    to,
    delta_requested: to - from,
    clamped: false,
    reason: "test",
    actor: "actor-llm",
    ...extra,
  };
}

describe("F3.4 rebuildStateValues", () => {
  it("seeds untouched fields from envelope means", () => {
    const { values } = rebuildStateValues(envelopes, []);
    expect(values["mood.tone"]).toBe(0);
    expect(values["traits.openness"]).toBe(0.8);
  });

  it("replays the log: the last `to` per field wins (exact, deterministic)", () => {
    const log = [entry("mood.tone", 0, 0.1), entry("mood.tone", 0.1, 0.25), entry("traits.openness", 0.8, 0.7)];
    const { values } = rebuildStateValues(envelopes, log);
    expect(values["mood.tone"]).toBe(0.25);
    expect(values["traits.openness"]).toBe(0.7);
  });

  it("a governance-blocked entry (to === from) leaves the value unchanged", () => {
    const log = [entry("mood.tone", 0, 0.2), entry("mood.tone", 0.2, 0.2, { governance_blocked: true })];
    expect(rebuildStateValues(envelopes, log).values["mood.tone"]).toBe(0.2);
  });

  it("reports drift when the stored value disagrees with the replay (tamper-evidence)", () => {
    const log = [entry("mood.tone", 0, 0.25)];
    const { drift } = rebuildStateValues(envelopes, log, { "mood.tone": 0.9, "traits.openness": 0.8 });
    // mood.tone was hand-edited to 0.9 but the log only justifies 0.25 → drift.
    expect(drift.find((d) => d.field === "mood.tone")).toEqual({ field: "mood.tone", stored: 0.9, rebuilt: 0.25 });
    // traits.openness matches its mean → no drift.
    expect(drift.find((d) => d.field === "traits.openness")).toBeUndefined();
  });

  it("no drift when stored values match the replay", () => {
    const log = [entry("mood.tone", 0, 0.25)];
    const { drift } = rebuildStateValues(envelopes, log, { "mood.tone": 0.25, "traits.openness": 0.8 });
    expect(drift).toEqual([]);
  });
});

describe("F3.4 rebuildState", () => {
  it("rebuilds values but preserves the mutation_log verbatim (checkpoint, not rewrite)", () => {
    const log = [entry("mood.tone", 0, 0.25)];
    const state: StateFile = {
      schema_version: "1.0.0",
      persona_id: "p",
      persona_version: "1.0.0",
      values: { "mood.tone": 0.9 }, // corrupted/hand-edited
      mutation_log: log,
    };
    const { state: rebuilt, drift } = rebuildState(state, envelopes);
    expect(rebuilt.values["mood.tone"]).toBe(0.25);
    expect(rebuilt.mutation_log).toBe(log); // log untouched
    expect(drift).toHaveLength(1);
  });
});
