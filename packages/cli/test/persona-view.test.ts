import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { personaLines, PERSONA_TABS, anatomyLines } from "../src/repl/views/persona-data.js";
import { writeStarterPersona } from "../src/starter.js";

// The aura advances with the clock, so the portrait differs from frame to frame by design.
// This suite asserts against a persona's drawn features, which only holds on a fixed frame;
// declare the pin HERE rather than inheriting it from whichever suite happened to run first
// in the same worker (it did, and the test failed only when run alongside another file).
process.env.PERSONAXIS_NO_ANIM = "1";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-personaview-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Persona miniapp collectors (V5.P3.3)", () => {
  it("every tab renders lines without crashing on a fresh persona", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Vista"), makeMeter());
    expect(PERSONA_TABS).toHaveLength(6);
    for (let t = 0; t < PERSONA_TABS.length; t++) expect(personaLines(ctx, t).length).toBeGreaterThan(0);
  });

  it("anatomy names the TEN canonical layers in order", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Diez"), makeMeter());
    const text = anatomyLines(ctx).join("\n");
    for (const layer of [
      "1 identity",
      "2 character",
      "3 personality",
      "4 values_and_drives",
      "5 affect",
      "6 cognition",
      "7 memory",
      "8 metacognition",
      "9 self_regulation",
      "10 persona",
    ]) {
      expect(text).toContain(layer);
    }
  });

  it("identity tab carries the aura portrait and the spec version, side by side", async () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Aura"), makeMeter());
    const text = personaLines(ctx, 0).join("\n");
    // The portrait, with its data in a column to the RIGHT. Parts vary per persona, so
    // assert against this persona own drawn features, not any fixed glyph.
    const { auraFeatures, sigilParams } = await import("./aura-probe.js");
    const f = auraFeatures(sigilParams(ctx.handle.frontmatter).seed);
    // Assert by GLYPH, not by the exact row: every persona starts on its own phase, so
    // the drawn frame may already carry a gaze shift, the second mouth, or an exhale
    // (which narrows the chest). Requiring the resting rows would be asserting that the
    // figure is frozen, which is the opposite of what this view must do.
    const glyphs = (s: string): string[] => [...new Set([...s])].filter((c) => c !== " ");
    for (const g of glyphs(f.eyes)) expect(text, "the face").toContain(g);
    const mouthShown = glyphs(f.mouth).every((g) => text.includes(g)) || glyphs(f.mouthAlt).every((g) => text.includes(g));
    expect(mouthShown, "the mouth").toBe(true);
    expect(text, "a filled torso").toContain(f.fill.slice(1, -1));
    // side by side: at least one line carries figure AND fact
    const shared = personaLines(ctx, 0).filter((l) => /\S/.test(l.slice(0, 12)) && /\S/.test(l.slice(14)));
    expect(shared.length).toBeGreaterThan(0);
    expect(text).toContain("spec_version");
  });
});
