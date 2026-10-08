/**
 * `create --yes` over an existing persona starts a new persona, not the old one with a new definition.
 *
 * Seen on 2026-10-03 when Clio was rebuilt: the old record.jsonl and state.json stayed beside the new
 * definition, so the new persona compiled with the old values ("openness high" with a declared mean of
 * 0.50). The old history is moved aside, not deleted: it is a hash-chained record somebody may want.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

const CLI = join(process.cwd(), "dist", "index.js");
const FIELD = "affect.baseline.core_affect.arousal";

const BRIEF = "A terse code reviewer that never softens findings";

let dir: string;
let home: string;
let model: FakeModel;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pxs-create-overwrite-"));
  home = mkdtempSync(join(tmpdir(), "pxs-create-overwrite-home-"));
  model = await startFakeModel();
});
afterEach(async () => {
  await model.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[]): Promise<string> {
  const r = await runCli(CLI, args, { cwd: dir, env: { PERSONAXIS_HOME: home, ...modelEnv(model) } });
  expect(r.code, r.out).toBe(0);
  return r.out;
}

// The same brief both times: the fake model answers from one recorded run, and what is under test is what
// happens to the old persona's history, not what the new one says.
function create(): Promise<string> {
  return run(["create", "rev", "--from-prompt", BRIEF, "--yes", "--no-compile"]);
}

function valueIn(path: string): number {
  return (JSON.parse(readFileSync(path, "utf-8")) as { values: Record<string, number> }).values[FIELD];
}

describe("create --yes over an existing persona", () => {
  it("does not carry the old state, record, sessions or self-edits into the new persona, and keeps them aside", async () => {
    await create();
    const base = join(dir, ".personaxis", "personas", "rev");
    const statePath = join(base, "state.json");

    // The old persona lived: its state moved through the real command, which also writes the record, and it
    // held sessions, a self-edit ledger and episodic memory.
    const before = valueIn(statePath);
    await run(["state", "mutate", "--field", FIELD, "--delta", "0.05", "--reason", "old-persona-entry", "-f", "rev"]);
    const moved = valueIn(statePath);
    expect(moved).not.toBe(before);
    expect(readFileSync(join(base, "record.jsonl"), "utf-8")).toContain("old-persona-entry");
    mkdirSync(join(base, "sessions"), { recursive: true });
    writeFileSync(join(base, "sessions", "old.jsonl"), "{}\n");
    writeFileSync(join(base, "self-edits.jsonl"), JSON.stringify({ op: "propose", id: "x" }) + "\n");
    mkdirSync(join(base, "memory"), { recursive: true });
    writeFileSync(join(base, "memory", "episodic.jsonl"), JSON.stringify({ content: "old-memory" }) + "\n");

    const out = await create();

    expect(valueIn(statePath)).toBe(before);
    const record = existsSync(join(base, "record.jsonl")) ? readFileSync(join(base, "record.jsonl"), "utf-8") : "";
    expect(record).not.toContain("old-persona-entry");
    expect(existsSync(join(base, "sessions", "old.jsonl"))).toBe(false);
    expect(existsSync(join(base, "self-edits.jsonl"))).toBe(false);
    expect(existsSync(join(base, "memory", "episodic.jsonl"))).toBe(false);

    // Kept, not deleted, and the run says where.
    const previous = join(base, "previous");
    expect(existsSync(previous)).toBe(true);
    const [archive] = readdirSync(previous);
    expect(readFileSync(join(previous, archive, "record.jsonl"), "utf-8")).toContain("old-persona-entry");
    expect(valueIn(join(previous, archive, "state.json"))).toBe(moved);
    expect(existsSync(join(previous, archive, "sessions", "old.jsonl"))).toBe(true);
    expect(existsSync(join(previous, archive, "self-edits.jsonl"))).toBe(true);
    expect(existsSync(join(previous, archive, "memory", "episodic.jsonl"))).toBe(true);
    expect(out).toMatch(/previous/);
  }, 120_000);

  it("leaves a first creation alone: nothing to move aside", async () => {
    await create();
    expect(existsSync(join(dir, ".personaxis", "personas", "rev", "previous"))).toBe(false);
  }, 60_000);
});
