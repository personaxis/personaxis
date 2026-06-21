import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderLiveBlock,
  upsertLiveBlock,
  liveSync,
  makeRecompileHook,
  loadPersona,
  writeState,
  LIVE_START,
  LIVE_END,
  type StateFile,
} from "../src/index.js";

let dir: string;
let personaPath: string;
let compiledPath: string;

const FIX = `---
metadata: { name: t, version: 1.0.0 }
identity: { canonical_id: t, display_name: T }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-0.2, 0.2] }
---
body
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-live-"));
  personaPath = join(dir, "personaxis.md");
  compiledPath = join(dir, "PERSONA.md");
  writeFileSync(personaPath, FIX);
  writeFileSync(compiledPath, "# T\n\nCompiled doc body.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function st(): StateFile {
  return {
    schema_version: "0.7.0",
    persona_id: "t",
    persona_version: "1",
    values: { "mood.tone": 0.12 },
    mutation_log: [{ ts: "2026-06-21T00:00:00Z", field: "mood.tone", from: 0, to: 0.12, delta_requested: 0.12, clamped: false, reason: "nudge", actor: "actor-llm" }],
  };
}

describe("live-sync", () => {
  it("renders a delimited block with the current values", () => {
    const block = renderLiveBlock(loadPersona(personaPath), st());
    expect(block).toContain(LIVE_START);
    expect(block).toContain(LIVE_END);
    expect(block).toContain("mood.tone");
    expect(block).toContain("0.120");
  });

  it("upsert appends when absent and replaces when present (idempotent)", () => {
    const block1 = renderLiveBlock(loadPersona(personaPath), st());
    let doc = upsertLiveBlock("# T\nbody\n", block1);
    expect((doc.match(new RegExp(LIVE_START, "g")) ?? []).length).toBe(1);
    // upsert again -> still exactly one block
    doc = upsertLiveBlock(doc, block1);
    expect((doc.match(new RegExp(LIVE_START, "g")) ?? []).length).toBe(1);
  });

  it("liveSync updates the compiled doc and writes the .live marker", () => {
    const handle = loadPersona(personaPath);
    const marker = liveSync(handle, compiledPath, st());
    expect(readFileSync(compiledPath, "utf-8")).toContain(LIVE_START);
    expect(existsSync(join(dir, ".live.json"))).toBe(true);
    expect(marker.mutations).toBe(1);
    expect(marker.state_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("recompile hook reads state and syncs", async () => {
    const handle = loadPersona(personaPath);
    writeState(handle.statePath, st());
    const hook = makeRecompileHook(compiledPath);
    await hook(handle);
    expect(readFileSync(compiledPath, "utf-8")).toContain("mood.tone");
    expect(existsSync(join(dir, ".live.json"))).toBe(true);
  });
});
