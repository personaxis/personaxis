import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  LivingLoop,
  loadPersona,
  readMemory,
  readMemoryTypes,
  consolidateSemantic,
  prepareMemoryEntry,
  commitMemoryEntry,
  type Appraiser,
  type AppraisalSignal,
  type StateFile,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-mem-"));
  personaPath = join(dir, "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(memTypes: string): string {
  return `---
apiVersion: persona.dev/v1
metadata: { name: memtest, version: 1.0.0 }
identity: { canonical_id: memtest }
improvement_policy: { mode: locked }
memory:
  types:
${memTypes}
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
  const state: StateFile = {
    schema_version: "0.8.0",
    persona_id: "memtest",
    persona_version: "1.0.0",
    values: { "mood.tone": 0 },
    mutation_log: [],
  };
  writeFileSync(handle.statePath, JSON.stringify(state, null, 2));
}

class FixedAppraiser implements Appraiser {
  constructor(private signal: AppraisalSignal) {}
  async appraise(): Promise<AppraisalSignal> {
    return this.signal;
  }
}

const signalWithMemory: AppraisalSignal = {
  appraisal: "noted",
  confidence: 0.9,
  mutations: [],
  memories: [{ content: "user likes terse answers", source: "user", tags: [] }],
};

describe("readMemoryTypes", () => {
  it("defaults episodic on when no memory block is declared", () => {
    expect(readMemoryTypes({}).episodic).toBe(true);
  });
  it("honors an explicit episodic:false", () => {
    expect(readMemoryTypes({ memory: { types: { episodic: false } } }).episodic).toBe(false);
  });
});

describe("LivingLoop honors memory.types (spec fidelity)", () => {
  it("writes NOTHING to episodic.jsonl when episodic:false", async () => {
    writeFileSync(personaPath, fixture("    episodic: false\n    semantic: true"));
    seed();
    const loop = new LivingLoop(personaPath, { appraiser: new FixedAppraiser(signalWithMemory) });
    await loop.tick({ observation: "hi", source: "user" });
    await loop.tick({ observation: "again", source: "user" });
    expect(readMemory(personaPath).length).toBe(0);
    expect(existsSync(join(dirname(personaPath), "memory", "episodic.jsonl"))).toBe(false);
  });

  it("writes episodic + consolidates semantic when both are on", async () => {
    writeFileSync(personaPath, fixture("    episodic: true\n    semantic: true"));
    seed();
    const loop = new LivingLoop(personaPath, { appraiser: new FixedAppraiser(signalWithMemory) });
    const report = await loop.tick({ observation: "hi", source: "user" });
    expect(report.memoriesWritten).toBe(1);
    expect(readMemory(personaPath).length).toBe(1);
    expect(existsSync(join(dirname(personaPath), "memory.md"))).toBe(true);
    expect(readFileSync(join(dirname(personaPath), "memory.md"), "utf-8")).toContain("user likes terse answers");
  });
});

describe("consolidateSemantic", () => {
  it("groups live entries by source into memory.md", () => {
    writeFileSync(personaPath, fixture("    episodic: true"));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "a", source: "user" }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "b", source: "tool" }));
    const r = consolidateSemantic(personaPath);
    expect(r.count).toBe(2);
    const md = readFileSync(r.path, "utf-8");
    expect(md).toContain("## From user");
    expect(md).toContain("## From tool");
  });
});
