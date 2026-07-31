/**
 * The AURA (V7.D7): the persona's portrait, composed layer by layer from its own hash.
 *
 * Corrections in this pass, each one straight from Design note:
 *
 *   the nose is BACK      removing it to flatten the head was the wrong trade. A head is
 *                         flattened by making it WIDER: the face interior went from 5 to
 *                         7 columns, so brows, eyes, nose and mouth all fit and the head
 *                         still reads as roughly square rather than as a tower.
 *   ears exist            their own slot, drawn either side of the eye row, where ears
 *                         actually sit on a face.
 *   hair has two parts    the crown on top and side locks down the temples.
 *   the neck is visible   its own narrow row between jaw and shoulders, so the head no
 *                         longer looks glued to the torso.
 *   the breath reads      the exhale steps BOTH sides of the chest inward a column, a
 *                         change of outline rather than of a glyph in place.
 *
 * Uniqueness is measured, not claimed: shape, palette and rhythm each come from
 * independent draws of the persona's hash. Deterministic: same seed + frame + state =
 * identical output.
 */

import chalk from "chalk";
import type { SigilParams } from "@personaxis/core";
import { BANKS, bankCombinations, type Archetype, type PartBank } from "./aura-parts.js";

export interface AuraState {
  /** 0..1 live affect; a lively persona holds a brighter face. */
  intensity?: number;
  /** Global drift D; past ~0.8 the figure carries a warning flare. */
  drift?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ANSI-256 index for a hue/sat/val inside the 216-color cube. */
function ansiFromHue(hue: number, sat: number, val: number): number {
  const h = ((hue % 360) + 360) % 360;
  const c = val * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = val - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const q = (v: number): number => Math.max(0, Math.min(5, Math.round((v + m) * 5)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export interface AuraPalette {
  /** Hair or shell. */
  crown: number;
  /** Face. */
  skin: number;
  /** Shoulders and torso. */
  garment: number;
  /** Eyes, marks and the spark. */
  accent: number;
  /** Base hue in degrees (exported so tests can prove the spread). */
  hue: number;
}

/** [garment offset, accent offset] harmony schemes, drawn per persona. */
const HARMONIES: Array<[number, number]> = [
  [180, 120],
  [150, 210],
  [120, 240],
  [210, 150],
  [90, 270],
  [30, 300],
];

/**
 * A palette that cannot collide: the base hue is placed by the GOLDEN-RATIO sequence (so
 * consecutive seeds land far apart on the circle), the harmony scheme is drawn per
 * persona, and each role's lightness is quantized into visibly distinct steps.
 */
export function auraPalette(seed: number): AuraPalette {
  const hue = ((seed >>> 0) * 0.6180339887498949 * 360) % 360;
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const [dGarment, dAccent] = HARMONIES[Math.floor(rnd() * HARMONIES.length)];
  const step = (): number => 0.45 + Math.floor(rnd() * 4) * 0.15;
  return {
    crown: ansiFromHue(hue, 0.55 + Math.floor(rnd() * 3) * 0.15, step()),
    skin: ansiFromHue(hue + (rnd() < 0.5 ? 22 : -22), 0.25 + Math.floor(rnd() * 3) * 0.1, 0.78 + Math.floor(rnd() * 2) * 0.12),
    garment: ansiFromHue(hue + dGarment, 0.45 + Math.floor(rnd() * 3) * 0.15, step()),
    accent: ansiFromHue(hue + dAccent, 0.9, 0.9),
    hue,
  };
}

export interface AuraFeatures {
  archetype: Archetype;
  crown: string;
  lock: string;
  ears: [string, string];
  brows: string;
  eyes: string;
  lids: string;
  nose: string;
  mouth: string;
  jaw: string;
  neck: string;
  shoulders: string;
  fill: string;
  spark: string;
  /** The mouth this persona wears while "speaking" (its second expression). */
  mouthAlt: string;
  /** The swayed position of the side lock (same width, different glyph). */
  lockAlt: string;
  /** Frames between blinks. */
  blink: number;
  /** Frames per gaze shift. */
  gaze: number;
  /** Frames per expression change (brows, mouth). */
  expressive: number;
  /** Frames per hair sway. */
  sway: number;
  /** Frames per breath (the chest widens and narrows). */
  breath: number;
  /** Frames per orbit position of the spark. */
  orbit: number;
  /** Starting phase, so two personas never move in step. */
  phase: number;
  palette: AuraPalette;
}

export function auraFeatures(seed: number): AuraFeatures {
  const rnd = mulberry32(seed);
  const archetype: Archetype = rnd() < 0.5 ? "human" : "android";
  const bank: PartBank = BANKS[archetype];
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  /**
   * The SECOND position of a moving part. Drawn from the same bank MINUS the resting
   * glyph, because a part whose two positions are identical simply never moves: the
   * mouth would look frozen for the ~10% of personas that drew the same one twice.
   */
  const pickOther = <T,>(arr: T[], first: T): T => {
    const rest = arr.filter((x) => x !== first);
    return rest.length === 0 ? first : rest[Math.floor(rnd() * rest.length)];
  };
  // The lock is drawn as a PAIR, so a persona with no side hair never grows any and one
  // with hair sways between two neighbouring glyphs instead of changing hairstyle.
  const [lock, lockAlt] = pick(bank.locks);
  const mouth = pick(bank.mouths);
  return {
    archetype,
    crown: pick(bank.crowns),
    lock,
    lockAlt,
    ears: pick(bank.ears),
    brows: pick(bank.brows),
    eyes: pick(bank.eyes),
    lids: pick(bank.lids),
    nose: pick(bank.noses),
    mouth,
    mouthAlt: pickOther(bank.mouths, mouth),
    jaw: pick(bank.jaws),
    neck: pick(bank.necks),
    shoulders: pick(bank.shoulders),
    fill: pick(bank.fills),
    spark: pick(bank.sparks),
    // Short, mutually offset periods: with five motions running at 2-5 frames each,
    // something visibly changes almost every frame, which is what "se mueve" means.
    blink: 4 + Math.floor(rnd() * 5),
    gaze: 2 + Math.floor(rnd() * 3),
    expressive: 3 + Math.floor(rnd() * 4),
    sway: 2 + Math.floor(rnd() * 3),
    breath: 2 + Math.floor(rnd() * 3),
    orbit: 1 + Math.floor(rnd() * 3),
    phase: Math.floor(rnd() * 24),
    palette: auraPalette(seed),
  };
}

/** Canvas width: the shoulders are the widest part, at 9, plus room for the orbit. */
export const AURA_WIDTH = 15;
const center = (s: string): string => {
  const chars = [...s];
  if (chars.length >= AURA_WIDTH) return chars.slice(0, AURA_WIDTH).join("");
  const left = Math.floor((AURA_WIDTH - chars.length) / 2);
  return " ".repeat(left) + s + " ".repeat(AURA_WIDTH - chars.length - left);
};

/**
 * Move the pupils inside a SEVEN-column eye row. The row looks like "  ◕ ◕  ", so
 * there is a blank column on each side to slide into; an earlier three-column face had
 * none, which is why the gaze used to push an eye off the head.
 */
function shiftEyes(row: string, dir: number): string {
  if (dir === 0) return row;
  const c = [...row];
  if (c.length !== 7) return row;
  return dir < 0 ? c.slice(1).join("") + " " : " " + c.slice(0, -1).join("");
}

/** Positions the spark orbits through, as [row, column] on the canvas. */
const ORBIT: Array<[number, number]> = [
  [0, 12],
  [1, 13],
  [2, 14],
  [3, 13],
  [4, 12],
  [4, 2],
  [3, 1],
  [2, 0],
  [1, 1],
  [0, 2],
];

/**
 * The portrait, one frame, as plain rows (uncolored). Pure and deterministic.
 *
 * Rows: 0 crown · 1 brows · 2 eyes (with ears) · 3 nose · 4 mouth · 5 jaw · 6 neck ·
 *       7 shoulders · 8 torso.
 */
export function auraRows(seed: number, frame = 0, state: AuraState = {}): string[] {
  const f = auraFeatures(seed);
  const t = frame + f.phase;
  const blinking = frame > 0 && t % f.blink === 0;
  const inhale = t % f.breath < Math.ceil(f.breath / 2);
  const flare = (state.drift ?? 0) >= 0.8;

  const lock = f.lock;
  const [earL, earR] = f.ears;
  const face = (inner: string, left = " ", right = " "): string => `${left}${lock}│${inner}│${lock}${right}`;

  // ── the figure is ALIVE (V7.D8) ──────────────────────────────────────────
  // Motion has to be noticed quickly. One slow animation is invisible; five,
  // each on its own short period, mean something changes almost every frame.

  // 1. GAZE. The seven-column face finally has room to move the eyes without pushing
  //    one off the edge (the reason this was dropped when the face was three wide).
  const gazeStep = Math.floor(t / f.gaze) % 6;
  const gaze = gazeStep === 1 ? -1 : gazeStep === 4 ? 1 : 0;
  const eyeRow = blinking ? f.lids : shiftEyes(f.eyes, gaze);

  // 2. BROWS lift now and then: the fastest way to make a face look like it is thinking.
  const browsUp = Math.floor(t / f.expressive) % 5 === 0;
  const brows = browsUp ? f.brows.replace(/[╌─╍▬═▭]/g, "▔").replace(/[╲╱]/g, "▔") : f.brows;

  // 3. The MOUTH shifts on its own beat (a breath in, a word), so the face is never
  //    frozen even between blinks.
  const talking = Math.floor(t / f.expressive) % 3 === 1;
  const mouth = talking ? f.mouthAlt : f.mouth;

  // 4. HAIR sways by CHANGING GLYPH, never by disappearing: dropping a lock shifted the
  //    whole figure sideways, which read as the persona jumping, not as hair moving.
  //    Both sides carry the SAME glyph and change together; alternating sides made the
  //    lock jump across the head instead of the hair moving.
  const sway = Math.floor(t / f.sway) % 2 === 1;
  const lockL = sway ? f.lockAlt : lock;
  const lockR = lockL;

  // 5. BREATH moves the chest's outline (both sides step inward on the exhale).
  const chest = inhale ? `▐${f.fill}▌` : ` ▐${f.fill.slice(1, -1)}▌ `;

  const rows = [
    center(` ${lockL}${f.crown}${lockR} `),
    center(`${lockL}│${brows}│${lockR}`),
    center(`${earL}${lockL}│${eyeRow}│${lockR}${earR}`),
    center(`${lockL}│${f.nose}│${lockR}`),
    center(`${lockL}│${mouth}│${lockR}`),
    center(` ${f.jaw} `),
    // The neck is its own row: without it the head sits glued to the shoulders.
    center(f.neck),
    center(f.shoulders),
    center(chest),
  ];

  // Place the mark at its orbit position; if the figure already occupies that cell, walk
  // the orbit forward until a free one is found, so the mark (and the drift flare, which
  // is a warning) is never silently dropped.
  const glyph = flare ? "✸" : f.spark;
  const start = Math.floor(t / f.orbit) % ORBIT.length;
  for (let i = 0; i < ORBIT.length; i++) {
    const [orow, ocol] = ORBIT[(start + i) % ORBIT.length];
    const chars = [...rows[orow]];
    if (chars[ocol] === " ") {
      chars[ocol] = glyph;
      rows[orow] = chars.join("");
      break;
    }
  }
  return rows;
}

/** How many distinct portraits the banks can compose. */
export function auraSpaceSize(): number {
  return bankCombinations(BANKS.human) + bankCombinations(BANKS.android);
}

/** The colored portrait: crown, face and garment each in their own hue. */
export function auraLines(params: SigilParams, frame = 0, state: AuraState = {}): string {
  const f = auraFeatures(params.seed);
  const rows = auraRows(params.seed, frame, state);
  const p = f.palette;
  const crown = chalk.ansi256(p.crown);
  const skin = chalk.ansi256(p.skin);
  const garment = chalk.ansi256(p.garment);
  const accent = chalk.ansi256(p.accent);
  const flare = (state.drift ?? 0) >= 0.8;
  const bright = (state.intensity ?? 0.5) >= 0.6;
  const glyph = flare ? "✸" : f.spark;
  const sparkPaint = flare ? chalk.red.bold : accent;

  return rows
    .map((row, i) => {
      const base = i === 0 ? crown : i <= 4 ? skin : garment;
      const lit = i === 2 && bright ? skin.bold : base;
      // Paint the spark and the eyes in the accent, everything else in its band's hue.
      return [...row]
        .map((ch) => {
          if (ch === " ") return ch;
          if (ch === glyph) return sparkPaint(ch);
          if (i === 2 && f.eyes.includes(ch)) return accent(ch);
          return lit(ch);
        })
        .join("");
    })
    .join("\n");
}
