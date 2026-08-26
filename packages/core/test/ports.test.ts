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
// From the record's own module, not the top-level re-export: `RecordEntry` is also
// the name of the wire protocol's entry, and this file's tsconfig does not type-check
// tests, so importing the wrong one of the two would go unnoticed.
import type { RecordEntry } from "../src/record/entry.js";
import { recordPathFor } from "../src/record/store.js";

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
    expect(typeof s.lock.acquire).toBe("function");
    expect(typeof s.state.read).toBe("function");
    expect(typeof s.state.write).toBe("function");
    // The record's own port. The state file is printed from the record now, so a
    // hosted engine given only `state` would be hosting the projection and losing
    // the thing it is projected from.
    expect(typeof s.record?.read).toBe("function");
    expect(typeof s.record?.sink).toBe("function");
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
    // The record, in memory too. Since the record became the source, an engine that
    // wrote state through this store and entries to a disk beside it would still be
    // touching the filesystem, and touching it for the half that matters.
    let entries: RecordEntry[] = [];
    const storage: Storage = {
      lock: { acquire: (_k) => { locks++; return () => {}; } },
      state: {
        read: () => structuredClone(mem),
        write: (_k, s) => { writes++; mem = structuredClone(s); },
        exists: () => true,
      },
      record: {
        read: () => [...entries],
        sink: () => ({ append: async (batch) => { entries = [...entries, ...batch]; } }),
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
    // The record went to the injected store and its entries are really there.
    expect(entries.length).toBeGreaterThan(0);
    expect(existsSync(statePath)).toBe(false); // fs was never touched
    // And neither did the record, which is the half that matters now: an engine
    // writing state through a store and entries to a disk beside it is still on the
    // filesystem, for the source rather than for the projection.
    expect(existsSync(recordPathFor(personaPath))).toBe(false);
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
      lock: { acquire: () => () => {} },
      state: { read: () => structuredClone(mem), write: (_k, s) => { mem = structuredClone(s); }, exists: () => true },
      record: { read: () => [], sink: () => ({ append: async () => {} }) },
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
