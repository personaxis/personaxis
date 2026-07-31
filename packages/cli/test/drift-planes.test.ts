/**
 * V7.F: drift as three planes.
 *
 * The point of these tests: drift that only covers numbers is
 * not drift for a spec full of strings, arrays and booleans, and a plane that only COUNTS
 * edits is not a measurement. So every case here asserts a magnitude and a before/after,
 * not the presence of a heading.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { proposeSelfEdit } from "@personaxis/core";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { writeStarterPersona } from "../src/starter.js";
import { structuralReport, behavioralReport, changeDetailLines } from "../src/repl/views/drift-data.js";
import {
  continuousLines,
  structuralLines,
  behavioralLines,
  driftTextLines,
  DRIFT_TABS,
} from "../src/repl/views/drift-view.js";
import { isRow, lineText, type TabLine } from "../src/repl/views/tabbed.js";

chalk.level = 0;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-drift-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A rationale long enough, and provenance trusted enough, to pass the governance gate. */
const RATIONALE =
  "Across three sessions the user asked for shorter answers and rated the long ones unhelpful; the recorded evaluations support loosening the tone.";

function personaWithEdits(): ReturnType<typeof makeCtx> {
  const p = writeStarterPersona(dir, "Clio");
  const ctx = makeCtx(p, makeMeter());
  proposeSelfEdit(p, { targetPath: "persona.voice.tone", toValue: "warm, discursive, playful", rationale: RATIONALE, sources: ["user"] }, "autonomous");
  proposeSelfEdit(p, { targetPath: "cognition.uncertainty_policy.disclose_when_above", toValue: 0.6, rationale: RATIONALE, sources: ["user"] }, "autonomous");
  return ctx;
}

const asText = (lines: TabLine[]): string => lines.map(lineText).join("\n");

describe("the drift miniapp has three planes (V7.F3)", () => {
  it("names them, in the order continuous → structural → behavioral", () => {
    expect([...DRIFT_TABS]).toEqual(["Continuous", "Structural", "Behavioral"]);
  });

  it("every plane renders for a persona that has never moved", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Still"), makeMeter());
    for (const lines of [continuousLines(ctx), structuralLines(ctx), behavioralLines(ctx)]) {
      expect(lines.length).toBeGreaterThan(0);
    }
    expect(asText(structuralLines(ctx))).toContain("nothing has moved");
  });
});

describe("the structural plane measures, it does not count (V7.F1)", () => {
  it("reports the exact field, its magnitude, and its before/after", () => {
    const ctx = personaWithEdits();
    const r = structuralReport(ctx);
    const tone = r.changes.find((c) => c.path === "persona.voice.tone");
    expect(tone, "the edited field must appear by path").toBeDefined();
    expect(tone!.kind).toBe("text");
    expect(tone!.magnitude).toBeGreaterThan(0);
    expect(tone!.to).toBe("warm, discursive, playful");
    expect(tone!.from).not.toBe(tone!.to);
  });

  it("covers a NON-string change in the same view (the original complaint)", () => {
    const ctx = personaWithEdits();
    const num = structuralReport(ctx).changes.find(
      (c) => c.path === "cognition.uncertainty_policy.disclose_when_above",
    );
    expect(num, "a numeric field with no envelope still belongs to a plane").toBeDefined();
    expect(num!.kind).toBe("number");
    expect(num!.to).toBe(0.6);
  });

  it("every row is OPENABLE, and the drill shows both literal values", () => {
    const ctx = personaWithEdits();
    const rows = structuralLines(ctx).filter(isRow);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.onEnter, `${row.label} must open`).toBeDefined();

    const change = structuralReport(ctx).changes.find((c) => c.path === "persona.voice.tone")!;
    const detail = changeDetailLines(change).join("\n");
    expect(detail).toContain("Declared in personaxis.md");
    expect(detail).toContain("In force now");
    expect(detail).toContain("warm, discursive, playful");
    // And it must say WHERE the change lives, so the reader knows the spec was not rewritten.
    expect(detail).toContain("overlay");
  });

  it("carries the layer's edit policy onto the row", () => {
    const ctx = personaWithEdits();
    const tone = structuralReport(ctx).changes.find((c) => c.path === "persona.voice.tone")!;
    expect(tone.policy, "a change under governance is not the same event as a free one").toBeTruthy();
  });
});

describe("the behavioral plane answers whether behaviour actually changed (V7.F2)", () => {
  it("measures how far the COMPILED document moves, offline", () => {
    const ctx = personaWithEdits();
    const b = behavioralReport(ctx);
    expect(b.compiledShift).toBeGreaterThan(0);
    expect(b.compiledShift).toBeLessThanOrEqual(1);
  });

  it("a persona with no edits shows no compiled shift", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Still"), makeMeter());
    expect(behavioralReport(ctx).compiledShift).toBe(0);
  });

  it("flags a document the hosts would read as out of date, and says why", () => {
    const ctx = personaWithEdits();
    const b = behavioralReport(ctx);
    expect(b.stale).toBe(true);
    expect(b.staleReason, "staleness without a reason is just a warning light").toBeTruthy();
    expect(asText(behavioralLines(ctx))).toMatch(/freshness/);
  });
});

describe("the pipe projection carries all three planes", () => {
  it("prints each plane, with the structural rows' values", () => {
    const ctx = personaWithEdits();
    const text = driftTextLines(ctx).join("\n");
    expect(text).toContain("Continuous plane");
    expect(text).toContain("Structural plane");
    expect(text).toContain("Behavioral plane");
    expect(text).toContain("persona.voice.tone");
  });
});
