import { describe, it, expect } from "vitest";
import { applyMutation, type StateFile, type Envelope } from "@personaxis/core";
import { rewindState } from "../src/rewind.js";

const env: Record<string, Envelope> = {
  "mood.tone": { mean: 0, min: -0.5, max: 0.5 } as Envelope,
};

function freshState(): StateFile {
  return {
    schema_version: "1.1.0",
    persona_id: "t",
    persona_version: "1.0.0",
    values: {},
    mutation_log: [],
  } as StateFile;
}

describe("rewindState (V2-F3.D19)", () => {
  it("restores values to before the last N mutations, chain intact (append, never truncate)", () => {
    const s = freshState();
    applyMutation(s, env, { field: "mood.tone", delta: 0.2, reason: "a" });
    applyMutation(s, env, { field: "mood.tone", delta: 0.1, reason: "b" });
    expect(s.values["mood.tone"]).toBeCloseTo(0.3);
    const before = s.mutation_log.length;

    const r = rewindState(s, env, 1); // undo "b"
    expect(r.changed).toContain("mood.tone");
    expect(s.values["mood.tone"]).toBeCloseTo(0.2);
    expect(s.mutation_log.length).toBe(before + 1); // appended, not truncated
    expect(s.mutation_log.at(-1)?.reason).toContain("rewind");
  });

  it("rewinding past all mutations returns to the envelope mean", () => {
    const s = freshState();
    applyMutation(s, env, { field: "mood.tone", delta: 0.2, reason: "a" });
    rewindState(s, env, 5);
    expect(s.values["mood.tone"]).toBeCloseTo(0);
  });
});
