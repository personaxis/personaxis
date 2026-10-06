/**
 * Undoing the last N mutations, without rewriting history.
 *
 * The chain is never truncated: a rewind moves the coordinates back with ordinary
 * recorded moves, so an audit can see that somebody took something back. That is a
 * fact worth keeping rather than one to erase, and it is the whole reason this is
 * harder than deleting rows.
 *
 * These used to drive the old in-place engine and assert against `state.mutation_log`
 * directly, which meant they covered a path the persona no longer takes: planning and
 * moving were one function, two callers persisted its result and a third only
 * previewed it, and nothing wrote any of it to the record.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readState, record, type Envelope, type StateFile } from "@personaxis/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rewind, rewindPlan } from "../src/rewind.js";

const env: Record<string, Envelope> = {
  "mood.tone": { mean: 0, min: -0.5, max: 0.5 } as Envelope,
};
const WHO = record.authorOf("human-operator");

let dir: string;
let personaPath: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-rewind-"));
  personaPath = join(dir, "personaxis.md");
  statePath = join(dir, "state.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A persona that has moved twice, written the way one on disk today would be. */
function moved(): StateFile {
  const row = (from: number, to: number, reason: string) => ({
    ts: `2026-08-0${reason === "a" ? 1 : 2}T00:00:00.000Z`,
    field: "mood.tone",
    from,
    to,
    delta_requested: to - from,
    clamped: false,
    reason,
    actor: "actor-llm",
  });
  const state = {
    schema_version: "1.1.0",
    persona_id: "t",
    persona_version: "1.0.0",
    values: { "mood.tone": 0.3 },
    mutation_log: [row(0, 0.2, "a"), row(0.2, 0.3, "b")],
  } as unknown as StateFile;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

describe("planning a rewind", () => {
  it("says what would move and writes nothing at all", () => {
    // The preview used to run the same code that did it, against a clone. That is a
    // simulation only for as long as nobody forgets the clone.
    const state = moved();

    const { moves, steps } = rewindPlan(state, env, 1);

    expect(steps).toBe(1);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.from).toBeCloseTo(0.3);
    expect(moves[0]!.to).toBeCloseTo(0.2);
    expect(readState(statePath).mutation_log).toHaveLength(2);
    expect(record.readRecord(record.recordPathFor(personaPath))).toEqual([]);
  });

  it("plans nothing when the persona is already at that point", () => {
    const { moves } = rewindPlan(moved(), env, 0);

    // `0` means one step, and one step from 0.3 back to 0.2 is a real move. What must
    // plan nothing is a rewind of a persona that never moved.
    expect(moves).toHaveLength(1);
    expect(rewindPlan(readState(statePath), env, 1).moves).toHaveLength(1);
  });
});

describe("performing one", () => {
  it("restores the value and appends, rather than truncating", async () => {
    const state = moved();

    const { changed } = await rewind(personaPath, statePath, state, env, 1, WHO);

    expect(changed).toEqual(["mood.tone"]);
    const after = readState(statePath);
    expect(after.values["mood.tone"]).toBeCloseTo(0.2);
    expect(after.mutation_log).toHaveLength(3);
    expect(after.mutation_log.at(-1)!.reason).toContain("rewind");
  });

  it("attributes it to whoever asked, and never to the runtime", async () => {
    // A rewind is somebody deciding to take something back. An entry that credits the
    // machine for it is a forged one, and it cannot be corrected afterwards.
    await rewind(personaPath, statePath, moved(), env, 1, WHO);

    expect(readState(statePath).mutation_log.at(-1)!.actor).toBe("human-operator");
  });

  it("puts it in the record, and the chain still verifies", async () => {
    await rewind(personaPath, statePath, moved(), env, 1, WHO);

    const entries = record.readRecord(record.recordPathFor(personaPath));
    // The two it is undoing, the coordinate's origin, and the move back.
    expect(entries.length).toBe(4);
    expect(record.verify(entries).ok).toBe(true);
  });

  it("goes back to the envelope mean when asked for more than there is", async () => {
    await rewind(personaPath, statePath, moved(), env, 5, WHO);

    expect(readState(statePath).values["mood.tone"]).toBeCloseTo(0);
  });

  it("writes nothing when the persona is already where it would be put", async () => {
    // A persona that never moved. Rewinding one that HAS moved always moves it, even
    // when the last entry was itself a rewind: undoing an undo is a real change and
    // recording it is the point, not an edge case to suppress.
    const state = {
      schema_version: "1.1.0",
      persona_id: "t",
      persona_version: "1.0.0",
      values: { "mood.tone": 0 },
      mutation_log: [],
    } as unknown as StateFile;
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const { changed } = await rewind(personaPath, statePath, state, env, 1, WHO);

    expect(changed).toEqual([]);
    expect(readState(statePath).mutation_log).toEqual([]);
  });

  it("records undoing an undo, because that is a change too", async () => {
    await rewind(personaPath, statePath, moved(), env, 1, WHO);
    const settled = readState(statePath);
    expect(settled.values["mood.tone"]).toBeCloseTo(0.2);

    const { changed } = await rewind(personaPath, statePath, settled, env, 1, WHO);

    expect(changed).toEqual(["mood.tone"]);
    expect(readState(statePath).values["mood.tone"]).toBeCloseTo(0.3);
    expect(readState(statePath).mutation_log).toHaveLength(4);
  });
});
