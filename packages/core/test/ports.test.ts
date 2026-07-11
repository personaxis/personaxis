/**
 * F3.3, storage ports: the engine routes persistence through the injected
 * Storage bundle, so a host (the SaaS) can swap fs for Postgres/S3 unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LivingLoop,
  loadPersona,
  defaultFsStorage,
  type Appraiser,
  type AppraisalSignal,
  type StateFile,
  type Storage,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-ports-"));
  personaPath = join(dir, "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function persona(): string {
  return `---
apiVersion: persona.dev/v1
metadata: { name: p, version: 1.0.0 }
identity: { canonical_id: p }
improvement_policy: { mode: suggesting }
memory: { types: { episodic: true } }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }
---
body
`;
}

class FixedAppraiser implements Appraiser {
  constructor(private signal: AppraisalSignal) {}
  async appraise(): Promise<AppraisalSignal> {
    return this.signal;
  }
}

describe("F3.3 storage ports", () => {
  it("defaultFsStorage exposes the four adapters", () => {
    const s = defaultFsStorage();
    expect(typeof s.lock.withLock).toBe("function");
    expect(typeof s.state.read).toBe("function");
    expect(typeof s.state.write).toBe("function");
    expect(typeof s.ledger.verify).toBe("function");
    expect(typeof s.memory.consolidate).toBe("function");
  });

  it("the engine writes STATE through the injected store (never the filesystem)", async () => {
    writeFileSync(personaPath, persona());
    const statePath = loadPersona(personaPath).statePath;

    // An in-memory state store, nothing hits disk.
    let mem: StateFile = {
      schema_version: "0.8.0",
      persona_id: "p",
      persona_version: "1.0.0",
      values: { "mood.tone": 0 },
      mutation_log: [],
    };
    let locks = 0;
    let writes = 0;
    const storage: Storage = {
      lock: { withLock: (_k, fn) => { locks++; return fn(); } },
      state: {
        read: () => structuredClone(mem),
        write: (_k, s) => { writes++; mem = structuredClone(s); },
        exists: () => true,
      },
      memory: { readSemantic: () => "", consolidate: () => ({ ok: true, path: "", count: 0 }) },
      ledger: { read: () => [], append: () => {}, verify: () => ({ ok: true }), redact: () => ({ redacted: true }) },
    };

    const signal: AppraisalSignal = {
      appraisal: "shift mood",
      confidence: 0.9,
      mutations: [{ field: "mood.tone", delta: 0.2, reason: "positive turn" }],
      memories: [],
    };
    const loop = new LivingLoop(personaPath, { appraiser: new FixedAppraiser(signal), storage });
    const report = await loop.tick({ observation: "great progress today", source: "user" });

    expect(report.mutationsApplied).toBe(1);
    expect(locks).toBeGreaterThan(0);        // serialized through the injected lock
    expect(writes).toBeGreaterThan(0);       // persisted through the injected store
    expect(mem.mutation_log).toHaveLength(1);
    // The value moved (governance may cap the per-step delta) and MATCHES the audited entry.
    expect(mem.values["mood.tone"]).toBeGreaterThan(0);
    expect(mem.values["mood.tone"]).toBe(mem.mutation_log[0].to);
    expect(existsSync(statePath)).toBe(false); // fs was never touched
  });

  it("the engine appends EPISODIC memory and checks the chain through the injected ledger", async () => {
    writeFileSync(personaPath, persona());
    let mem: StateFile = {
      schema_version: "0.8.0", persona_id: "p", persona_version: "1.0.0",
      values: { "mood.tone": 0 }, mutation_log: [],
    };
    const appended: string[] = [];
    let verifyCalls = 0;
    const storage: Storage = {
      lock: { withLock: (_k, fn) => fn() },
      state: { read: () => structuredClone(mem), write: (_k, s) => { mem = structuredClone(s); }, exists: () => true },
      memory: { readSemantic: () => "", consolidate: () => ({ ok: true, path: "", count: 0 }) },
      ledger: {
        read: () => [],
        append: (_k, e) => { appended.push(e.content); },
        verify: () => { verifyCalls++; return { ok: true }; },
        redact: () => ({ redacted: true }),
      },
    };
    const signal: AppraisalSignal = {
      appraisal: "note a fact",
      confidence: 0.9,
      mutations: [],
      memories: [{ content: "the user ships on Fridays", source: "user" }],
    };
    const loop = new LivingLoop(personaPath, { appraiser: new FixedAppraiser(signal), storage });
    const report = await loop.tick({ observation: "we ship Fridays", source: "user" });

    expect(report.memoriesWritten).toBe(1);
    expect(appended).toEqual(["the user ships on Fridays"]);
    expect(verifyCalls).toBeGreaterThan(0); // chain verified before the write (tamper-evidence)
  });
});
