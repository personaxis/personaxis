import { describe, it, expect } from "vitest";
import { personaTheme, renderThemedSigil, type PersonaFrontmatter } from "../src/index.js";

const fm = (over: Record<string, unknown> = {}): PersonaFrontmatter => ({
  identity: { canonical_id: "demo" },
  affect: { baseline: { core_affect: { valence: { mean: 0.3 }, arousal: { mean: 0.6 } } } },
  personality: {
    traits: {
      openness: { mean: 0.8 },
      extraversion: { mean: 0.7 },
      emotionality: { mean: 0.3 },
      conscientiousness: { mean: 0.9 },
    },
  },
  ...over,
});

describe("persona theme", () => {
  it("is deterministic per spec", () => {
    expect(personaTheme(fm())).toEqual(personaTheme(fm()));
  });

  it("differentiates palette by affect (warm vs cool)", () => {
    const warm = personaTheme(fm({ affect: { baseline: { core_affect: { valence: { mean: 0.5 }, arousal: { mean: 0.6 } } } } }));
    const cool = personaTheme(fm({ affect: { baseline: { core_affect: { valence: { mean: -0.5 }, arousal: { mean: 0.6 } } } } }));
    expect(warm.palette.primary).not.toBe(cool.palette.primary);
  });

  it("maps personality to motion (extraversion->breath, conscientiousness->symmetry)", () => {
    const lively = personaTheme(fm({ personality: { traits: { extraversion: { mean: 0.95 } } } }));
    const calm = personaTheme(fm({ personality: { traits: { extraversion: { mean: 0.1 } } } }));
    expect(lively.motion.breathRate).toBeGreaterThan(calm.motion.breathRate);
    const rigid = personaTheme(fm({ personality: { traits: { conscientiousness: { mean: 0.98 } } } }));
    expect(rigid.motion.symmetry).toBeGreaterThan(0.9);
  });

  it("derives a voice density from personality", () => {
    const expansive = personaTheme(fm({ personality: { traits: { extraversion: { mean: 0.9 }, openness: { mean: 0.9 }, conscientiousness: { mean: 0.2 } } } }));
    const terse = personaTheme(fm({ personality: { traits: { extraversion: { mean: 0.2 }, openness: { mean: 0.2 }, conscientiousness: { mean: 0.95 } } } }));
    expect(expansive.voice.density).toBe("expansive");
    expect(terse.voice.density).toBe("terse");
  });

  it("renders a differentiated, animated sigil per persona", () => {
    const a = personaTheme(fm({ identity: { canonical_id: "alpha" } }));
    const b = personaTheme(fm({ identity: { canonical_id: "beta" } }));
    const values = { "mood.tone": 0.1, "affect.valence": 0.2, "affect.arousal": 0.5 };
    // different personas -> visibly different sigils
    expect(renderThemedSigil(a, values, 0).grid.join("")).not.toBe(renderThemedSigil(b, values, 0).grid.join(""));
    // a persona's sigil animates (breathing) across frames
    expect(renderThemedSigil(a, values, 0).intensity).not.toBe(renderThemedSigil(a, values, 3).intensity);
  });

  it("maps openness to drift (exploratory motion)", () => {
    const rigid = personaTheme(fm({ personality: { traits: { openness: { mean: 0 } } } }));
    const open = personaTheme(fm({ personality: { traits: { openness: { mean: 1 } } } }));
    expect(rigid.motion.drift).toBe(0);
    expect(open.motion.drift).toBeGreaterThan(0);
  });
});
