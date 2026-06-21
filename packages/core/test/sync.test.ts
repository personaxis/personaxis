import { describe, it, expect } from "vitest";
import { mergeState, type StateFile } from "../src/index.js";

function st(values: Record<string, number>, log: StateFile["mutation_log"] = []): StateFile {
  return { schema_version: "0.6.0", persona_id: "t", persona_version: "1", values, mutation_log: log };
}

describe("cross-OS state merge", () => {
  it("unions and de-duplicates the mutation log and appends a merge marker", () => {
    const a = st({ "mood.tone": 0.1 }, [mut("2026-06-01T00:00:00Z", "mood.tone", 0.1)]);
    const b = st({ "mood.tone": 0.1 }, [mut("2026-06-01T00:00:00Z", "mood.tone", 0.1)]); // dup
    const { merged } = mergeState(a, b);
    // one deduped entry + the merge marker
    expect(merged.mutation_log.filter((e) => e.field === "mood.tone")).toHaveLength(1);
    expect(merged.mutation_log.at(-1)!.field).toBe("__merge__");
  });

  it("last-writer-wins per field by timestamp", () => {
    const a = st({ "mood.tone": 0.1 }, [mut("2026-06-01T00:00:00Z", "mood.tone", 0.1)]);
    const b = st({ "mood.tone": 0.3 }, [mut("2026-06-02T00:00:00Z", "mood.tone", 0.3)]);
    const { merged } = mergeState(a, b);
    expect(merged.values["mood.tone"]).toBe(0.3); // b is newer
  });

  it("clamps the chosen value to the envelope", () => {
    const a = st({ "mood.tone": 0.9 }, [mut("2026-06-02T00:00:00Z", "mood.tone", 0.9)]);
    const b = st({ "mood.tone": 0.1 });
    const { merged } = mergeState(a, b, { "mood.tone": { mean: 0, min: -0.2, max: 0.2 } });
    expect(merged.values["mood.tone"]).toBe(0.2); // clamped
  });

  it("reports a conflict when both diverge without history", () => {
    const a = st({ "mood.tone": 0.1 });
    const b = st({ "mood.tone": 0.3 });
    const { merged, conflicts } = mergeState(a, b);
    expect(conflicts).toHaveLength(1);
    expect(merged.values["mood.tone"]).toBe(0.1); // base kept, not clobbered
  });
});

function mut(ts: string, field: string, to: number): StateFile["mutation_log"][number] {
  return { ts, field, from: 0, to, delta_requested: to, clamped: false, reason: "t", actor: "actor-llm" };
}
