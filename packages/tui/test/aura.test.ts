import { describe, it, expect } from "vitest";
import chalk from "chalk";
import { auraRows, auraLines, auraFeatures, auraPalette, auraSpaceSize, AURA_WIDTH } from "../src/aura.js";
import { BANKS } from "../src/aura-parts.js";

// chalk disables color outside a TTY; the palette assertions need it on.
chalk.level = 3;

/**
 * V7.D7: the portrait with the whole face (brows, eyes, NOSE, mouth), EARS, hair in two
 * parts, a visible NECK between head and torso, and a breath that changes the chest's
 * outline so it can actually be seen.
 */
describe("the aura portrait (V7.D7)", () => {
  it("is deterministic: same seed + frame + state = identical rows", () => {
    expect(auraRows(0x8cdb4f71, 3, { drift: 0.2 })).toEqual(auraRows(0x8cdb4f71, 3, { drift: 0.2 }));
  });

  it("EVERY persona has the whole face: brows, eyes, nose and mouth", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const f = auraFeatures(seed * 7919);
      const rows = auraRows(seed * 7919, 0, {});
      // Each feature is asserted by its GLYPHS, not by the exact row: frame 0 already
      // carries whatever phase this persona starts on (a gaze shift, lifted brows, the
      // second mouth), so the row is not required to be the resting one.
      const glyphs = (s: string): string[] => [...s].filter((c) => c !== " ");
      for (const g of glyphs(f.eyes)) expect(rows[2], `seed ${seed} eyes`).toContain(g);
      for (const g of glyphs(f.nose)) expect(rows[3], `seed ${seed} nose`).toContain(g); // never missing again
      const mouthShown = glyphs(f.mouth).every((g) => rows[4].includes(g)) || glyphs(f.mouthAlt).every((g) => rows[4].includes(g));
      expect(mouthShown, `seed ${seed} mouth`).toBe(true);
      expect(rows[1].trim(), `seed ${seed} brows are blank`).not.toBe("");
      expect(f.nose.trim(), `seed ${seed} nose is blank`).not.toBe("");
    }
  });

  it("has ears, and hair in two parts (crown + side locks)", () => {
    let withEars = 0;
    let withLocks = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const f = auraFeatures(seed * 7919);
      const rows = auraRows(seed * 7919, 0, {});
      if (f.ears[0] !== " ") {
        withEars += 1;
        // Ears sit on the EYE row, outside the face walls.
        expect(rows[2], `seed ${seed} ears`).toContain(f.ears[0]);
        expect(rows[2]).toContain(f.ears[1]);
      }
      if (f.lock !== " ") {
        withLocks += 1;
        // The lock is drawn at whichever of its two sway positions this frame is on.
        const shown = rows[1].includes(f.lock) || rows[1].includes(f.lockAlt);
        expect(shown, `seed ${seed} side lock`).toBe(true);
      }
      expect(rows[0], `seed ${seed} crown`).toContain(f.crown);
    }
    expect(withEars).toBeGreaterThan(100); // most personas show ears
    expect(withLocks).toBeGreaterThan(50); // and many have side hair
  });

  /**
   * Motion has to be noticeable within a second or two. It is now five independent
   * rhythms, and two of them had defects that silently froze a part of the figure:
   * a lock could sway between " " and a glyph (hair popping into existence) and a mouth
   * could draw the same glyph twice (a mouth that never moves).
   */
  it("hair never appears out of nowhere, and the mouth always has a second position", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const f = auraFeatures(seed * 7919);
      // A bald persona stays bald; a persona with hair keeps it in both positions.
      expect(f.lock === " ", `seed ${seed} lock/lockAlt disagree`).toBe(f.lockAlt === " ");
      expect([...f.lockAlt], `seed ${seed} lockAlt width`).toHaveLength(1);
      // The mouth must actually be able to change.
      expect(f.mouthAlt, `seed ${seed} mouth is frozen`).not.toBe(f.mouth);
      expect([...f.mouthAlt]).toHaveLength(7);
    }
  });

  it("moves FAST: something changes in most consecutive frames, for every persona", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const s = seed * 104729;
      const frames = Array.from({ length: 8 }, (_, fr) => auraRows(s, fr, {}).join("|"));
      let changed = 0;
      for (let i = 1; i < frames.length; i++) if (frames[i] !== frames[i - 1]) changed += 1;
      // Five rhythms of 2-8 frames each: at worst a couple of frames repeat.
      expect(changed, `seed ${seed} only changed ${changed}/7 frames`).toBeGreaterThanOrEqual(4);
    }
  });

  it("every one of the five motions is real: gaze, brows, mouth, hair and breath", () => {
    // A seed with hair, so the sway is observable.
    const seed = [...Array(400).keys()].map((i) => (i + 1) * 7919).find((s) => auraFeatures(s).lock !== " ")!;
    const f = auraFeatures(seed);
    const span = 40;
    const frames = Array.from({ length: span }, (_, fr) => auraRows(seed, fr, {}));
    // GAZE: the eye row is drawn shifted at some point (leading blank consumed).
    const eyeVariants = new Set(frames.map((r) => r[2]));
    expect(eyeVariants.size, "the eyes never move").toBeGreaterThanOrEqual(3);
    // BROWS lift.
    expect(new Set(frames.map((r) => r[1])).size, "the brows never move").toBeGreaterThanOrEqual(2);
    // MOUTH alternates between its two positions.
    const mouths = frames.map((r) => r[4]);
    expect(mouths.some((m) => m.includes(f.mouth))).toBe(true);
    expect(mouths.some((m) => m.includes(f.mouthAlt))).toBe(true);
    // HAIR sways: both lock positions are drawn, and the figure NEVER shifts sideways
    // while doing it (the old bug: the lock jumped from one side to the other).
    const crowns = frames.map((r) => r[0]);
    expect(crowns.some((c) => c.includes(f.lock))).toBe(true);
    expect(crowns.some((c) => c.includes(f.lockAlt))).toBe(true);
    // Symmetry: the brow row is `lock│brows│lock`, 11 columns centred on 15, so the two
    // walls sit at fixed indices 2 and 12. Comparing the TRIMMED ends would pick up the
    // orbiting spark instead of the hair.
    for (const row of frames) {
      const c = [...row[1]];
      expect(c[2], "the lock jumped sides").toBe(c[12]);
    }
    // BREATH changes the chest's width.
    expect(new Set(frames.map((r) => r[8].trim().length)).size).toBeGreaterThanOrEqual(2);
  });

  it("the neck is its OWN row: the head is not glued to the torso", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const f = auraFeatures(seed * 104729);
      const rows = auraRows(seed * 104729, 0, {});
      expect(rows[6], `seed ${seed} neck`).toContain(f.neck);
      // And the neck is NARROWER than both the jaw above and the shoulders below,
      // which is what makes it read as a neck.
      expect(rows[6].trim().length).toBeLessThan(rows[5].trim().length);
      expect(rows[6].trim().length).toBeLessThan(rows[7].trim().length);
    }
  });

  it("the head is FLAT, not a tower: wider than it is tall", () => {
    // A terminal cell is ~2x taller than wide, so a head N rows tall reads as 2N.
    // Five rows of head (crown, brows, eyes, mouth, jaw) against nine columns reads
    // as roughly 9x10: square-ish. The earlier 5-wide, 6-row head read as a tower.
    for (let seed = 1; seed <= 40; seed++) {
      const f = auraFeatures(seed * 7919);
      expect([...f.brows]).toHaveLength(7);
      expect([...f.eyes]).toHaveLength(7);
      expect([...f.nose]).toHaveLength(7);
      expect([...f.mouth]).toHaveLength(7);
      expect([...f.jaw]).toHaveLength(9);
      const rows = auraRows(seed * 7919, 0, {});
      // The FACE (brows, eyes, mouth) is what the eye reads as the head's shape: three
      // rows against at least seven columns, so 7x6 in visual units, wider than tall.
      // The FACE is four rows (brows, eyes, nose, mouth) against at least nine
      // columns, so 9x8 in visual units: wider than tall.
      const faceWidth = Math.max(...rows.slice(1, 5).map((r) => r.trim().length));
      expect(faceWidth, `seed ${seed}`).toBeGreaterThanOrEqual(9);
      expect(faceWidth / (4 * 2), `seed ${seed} face is taller than wide`).toBeGreaterThan(1);
    }
  });

  it("the torso is FILLED, and the shoulders are solid (no stick arms)", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const f = auraFeatures(seed * 104729);
      const rows = auraRows(seed * 104729, 0, {});
      // Shoulder row: a solid wedge, not an outline.
      expect(rows[7]).toMatch(/[█▓▚▀]/);
      // Torso row: filled between the body's sides.
      expect(rows[8]).toContain(f.fill.slice(1, -1));
      expect([...f.fill]).toHaveLength(9);
      // No row may be two thin marks with a hole between them, which is what
      // "brazos delgadisimos" looked like.
      expect(rows[8].replace(/\s/g, "").length).toBeGreaterThanOrEqual(9);
    }
  });

  it("the figure is head, neck, shoulders, torso, in that order", () => {
    const rows = auraRows(0x8cdb4f71, 0, {});
    const f = auraFeatures(0x8cdb4f71);
    expect(rows[5]).toContain(f.jaw);
    expect(rows[6]).toContain(f.neck);
    expect(rows[7]).toContain(f.shoulders.slice(2, -2));
    expect(rows).toHaveLength(9); // 6 head+neck, 2 body
  });

  it("stays a fixed, narrow canvas", () => {
    for (let seed = 1; seed <= 200; seed++) {
      for (const row of auraRows(seed * 7919, 0, {})) {
        expect([...row].length, `seed ${seed}`).toBe(AURA_WIDTH);
      }
    }
    expect(AURA_WIDTH).toBe(15);
  });

  it("draws both archetypes evenly, never mixing their parts", () => {
    let human = 0;
    let android = 0;
    for (let s = 1; s <= 1000; s++) {
      const f = auraFeatures((s * 2654435761) % 4294967296);
      if (f.archetype === "human") {
        human += 1;
        expect(BANKS.human.eyes).toContain(f.eyes);
      } else {
        android += 1;
        expect(BANKS.android.eyes).toContain(f.eyes);
      }
    }
    expect(human).toBeGreaterThan(350);
    expect(android).toBeGreaterThan(350);
  });

  it("5000 personas, 5000 distinct shape+color identities", () => {
    expect(auraSpaceSize()).toBeGreaterThan(1_000_000_000);
    const identities = new Set<string>();
    for (let seed = 1; seed <= 5000; seed++) {
      const p = auraPalette(seed);
      identities.add(`${auraRows(seed, 0, {}).join("|")}#${p.crown}/${p.skin}/${p.garment}/${p.accent}`);
    }
    expect(identities.size).toBe(5000);
  });

  it("moves: it blinks, the shoulders breathe, and the spark orbits", () => {
    const seed = 0x8cdb4f71;
    const f = auraFeatures(seed);
    const span = Math.max(f.blink, f.breath, f.orbit * 10) + 2;
    const frames = Array.from({ length: span }, (_, fr) => auraRows(seed, fr, {}));
    expect(new Set(frames.map((r) => r.join("|"))).size).toBeGreaterThanOrEqual(3);
    // The eye row shows lids at some point (a blink) and eyes at others.
    const eyeRows = new Set(frames.map((r) => r[2]));
    expect(eyeRows.size).toBeGreaterThanOrEqual(2);
    // The BREATH changes the chest's outline, not a glyph in place: the torso row's
    // visible width must actually change.
    const chestWidths = new Set(frames.map((r) => r[8].trim().length));
    expect(chestWidths.size, "the breath must change the chest's width").toBeGreaterThanOrEqual(2);
  });

  it("no two personas move alike", () => {
    const sigs = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      sigs.add(Array.from({ length: 14 }, (_, fr) => auraRows(seed, fr, {}).join("|")).join("\n"));
    }
    expect(sigs.size).toBe(40);
  });

  it("live state shows: drift past the thresholds flares the mark", () => {
    expect(auraRows(7, 0, { drift: 0.9 }).join("\n")).toContain("✸");
    expect(auraRows(7, 0, { drift: 0.1 }).join("\n")).not.toContain("✸");
  });

  it("colored output keeps the row count and paints crown, face and garment apart", () => {
    const plain = auraRows(7, 0, {});
    const out = auraLines({ seed: 7, color: 100, charset: [" "], size: 7 }, 0, { intensity: 0.9 });
    expect(out.split("\n")).toHaveLength(plain.length);
    const codes = new Set([...out.matchAll(/\x1b\[38;5;(\d+)m/g)].map((m) => m[1]));
    expect(codes.size).toBeGreaterThanOrEqual(3);
  });
});
