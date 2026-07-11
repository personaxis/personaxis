import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LivingLoop, loadPersona,
  type Appraiser, type AppraisalSignal, type StateFile, type LoopEvent,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-obs-"));
  personaPath = join(dir, "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function persona(): string {
  return `---
apiVersion: persona.dev/v1
metadata: { name: obs, version: 1.0.0 }
identity: { canonical_id: obs }
improvement_policy: { mode: suggesting }
memory:
  types:
    episodic: true
    evaluations: true
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }
---
body
`;
}

function seed(): void {
  const handle = loadPersona(personaPath);
  const state: StateFile = { schema_version: "0.8.0", persona_id: "obs", persona_version: "1.0.0", values: { "mood.tone": 0 }, mutation_log: [] };
  writeFileSync(handle.statePath, JSON.stringify(state, null, 2));
}

class FixedAppraiser implements Appraiser {
  constructor(private signal: AppraisalSignal) {}
  async appraise(): Promise<AppraisalSignal> {
    return this.signal;
  }
}

describe("loop observability, evaluations surface their target/dimension/score (C)", () => {
  it("emits a detailed `evaluation` event per score when a memory is written", async () => {
    writeFileSync(personaPath, persona());
    seed();
    const signal: AppraisalSignal = {
      appraisal: "remember the user's name",
      confidence: 0.9,
      mutations: [],
      memories: [{ content: "the user prefers a terse register", source: "user" }],
    };
    const events: LoopEvent[] = [];
    const loop = new LivingLoop(personaPath, { appraiser: new FixedAppraiser(signal) });
    loop.bus.on((e) => events.push(e));
    await loop.tick({ observation: "I prefer terse answers", source: "user" });

    const evals = events.filter((e): e is Extract<LoopEvent, { type: "evaluation" }> => e.type === "evaluation");
    expect(evals.length).toBeGreaterThanOrEqual(2); // safety + usefulness for the written memory
    const dims = new Set(evals.map((e) => e.dimension));
    expect(dims.has("safety")).toBe(true);
    expect(dims.has("usefulness")).toBe(true);
    for (const e of evals) {
      expect(typeof e.target).toBe("string");
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.score).toBeLessThanOrEqual(1);
      expect(e.rationale.length).toBeGreaterThan(0);
    }
  });

  it("scores the turn (safety=1) even when nothing was written", async () => {
    writeFileSync(personaPath, persona());
    seed();
    const signal: AppraisalSignal = { appraisal: "noted", confidence: 0.9, mutations: [], memories: [] };
    const events: LoopEvent[] = [];
    const loop = new LivingLoop(personaPath, { appraiser: new FixedAppraiser(signal) });
    loop.bus.on((e) => events.push(e));
    await loop.tick({ observation: "hi", source: "user" });
    const evals = events.filter((e): e is Extract<LoopEvent, { type: "evaluation" }> => e.type === "evaluation");
    expect(evals).toHaveLength(1);
    expect(evals[0].target).toBe("turn");
    expect(evals[0].score).toBe(1);
  });
});
