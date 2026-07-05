import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripLiveBlock,
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
  it("stripLiveBlock is a no-op when no block is present", () => {
    const doc = "# T\n\nBody.\n";
    expect(stripLiveBlock(doc)).toBe(doc);
  });

  it("stripLiveBlock removes a residual block and surrounding blank space", () => {
    const doc = `# T\n\nBody.\n\n${LIVE_START}\n> stuff\n${LIVE_END}\n`;
    const cleaned = stripLiveBlock(doc);
    expect(cleaned).not.toContain(LIVE_START);
    expect(cleaned).not.toContain(LIVE_END);
    expect(cleaned).toContain("Body.");
    // idempotent
    expect(stripLiveBlock(cleaned)).toBe(cleaned);
  });

  it("liveSync writes the .live marker and never injects numeric state into the doc", () => {
    const handle = loadPersona(personaPath);
    const before = readFileSync(compiledPath, "utf-8");
    const marker = liveSync(handle, compiledPath, st());
    const after = readFileSync(compiledPath, "utf-8");
    expect(after).toBe(before); // prose untouched
    expect(after).not.toContain(LIVE_START);
    expect(existsSync(join(dir, ".live.json"))).toBe(true);
    expect(marker.mutations).toBe(1);
    expect(marker.state_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("liveSync self-heals a doc that still carries an old live block", () => {
    writeFileSync(compiledPath, `# T\n\nBody.\n\n${LIVE_START}\n> old\n${LIVE_END}\n`);
    const handle = loadPersona(personaPath);
    liveSync(handle, compiledPath, st());
    expect(readFileSync(compiledPath, "utf-8")).not.toContain(LIVE_START);
  });

  it("recompile hook reads state and writes the marker without touching prose", async () => {
    const handle = loadPersona(personaPath);
    writeState(handle.statePath, st());
    const before = readFileSync(compiledPath, "utf-8");
    const hook = makeRecompileHook(compiledPath);
    await hook(handle);
    expect(readFileSync(compiledPath, "utf-8")).toBe(before);
    expect(existsSync(join(dir, ".live.json"))).toBe(true);
  });

  it("F3.1: with an assemble fn, the hook rewrites the compiled doc deterministically (inline recompile)", async () => {
    const handle = loadPersona(personaPath);
    writeState(handle.statePath, st());
    const hook = makeRecompileHook({
      compiledPath,
      assemble: () => "# You are Fresh\n\nDeterministically re-assembled.\n",
    });
    await hook(handle);
    const after = readFileSync(compiledPath, "utf-8");
    expect(after).toContain("# You are Fresh");
    expect(after).toContain("Deterministically re-assembled.");
    expect(existsSync(join(dir, ".live.json"))).toBe(true); // marker still written
  });
});
