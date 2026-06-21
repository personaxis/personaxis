import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personaTheme, ensureState, loadPersona } from "@personaxis/core";
import { sigilLines, auraBar, eventLine, voiceWrap, envelopeBars } from "../src/visual.js";
import { renderFrame } from "../src/index.js";

// chalk emits no color in the test env (non-TTY), so assert on stripped content.
const fm = {
  identity: { canonical_id: "demo", display_name: "Demo" },
  affect: { baseline: { core_affect: { valence: { mean: 0.3 }, arousal: { mean: 0.6 } } } },
  personality: { traits: { extraversion: { mean: 0.7 }, openness: { mean: 0.8 } } },
};

describe("visual engine", () => {
  it("sigilLines renders one row per theme size", () => {
    const theme = personaTheme(fm);
    const lines = sigilLines(theme, { "mood.tone": 0.1 }, 0);
    expect(lines).toHaveLength(theme.size);
  });

  it("auraBar reflects intensity", () => {
    const theme = personaTheme(fm);
    expect(auraBar(theme, { "affect.arousal": 0.9 })).toContain("◈");
  });

  it("eventLine formats a mutate event with the field", () => {
    const theme = personaTheme(fm);
    const line = eventLine(theme, {
      type: "mutate",
      result: {
        entry: { ts: "", field: "mood.tone", from: 0, to: 0.1, delta_requested: 0.1, clamped: false, reason: "r", actor: "actor-llm" },
        from: 0,
        to: 0.1,
        clamped: false,
        blocked: false,
      },
    });
    expect(line).toContain("mood.tone");
  });

  it("voiceWrap returns the text content for each density", () => {
    const theme = personaTheme(fm);
    expect(voiceWrap(theme, "hello")).toContain("hello");
  });

  it("envelopeBars marks each field position", () => {
    const theme = personaTheme(fm);
    const out = envelopeBars(theme, { "mood.tone": 0.1 }, { "mood.tone": { min: -0.2, max: 0.2 } });
    expect(out).toContain("mood.tone");
    expect(out).toContain("◉");
  });
});

describe("dashboard renderFrame", () => {
  let dir: string;
  let persona: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-tui-"));
    persona = join(dir, "personaxis.md");
    writeFileSync(
      persona,
      `---\nmetadata: { name: t, version: 1.0.0 }\nidentity: { canonical_id: t, display_name: T }\naffect:\n  baseline:\n    mood:\n      tone: { mean: 0.0, range: [-0.2, 0.2] }\n---\nbody\n`,
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("renders a frame with the sigil + chain status", () => {
    ensureState(loadPersona(persona)); // seed state.json
    const out = renderFrame(persona, 0);
    expect(out).toContain("T");
    expect(out).toContain("intact");
    expect(out).toContain("mood.tone");
  });
});
