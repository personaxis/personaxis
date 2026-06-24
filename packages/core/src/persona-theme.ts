/**
 * PersonaTheme — a persona's whole visual + behavioral signature, derived
 * DETERMINISTICALLY from its spec (plan/09-ascii-ux).
 *
 * The requirement was explicit: showing a persona must be differentiated per
 * persona — its look AND its behavior in the terminal — never a generic spinner.
 * So we map the quantitative layers to a theme:
 *
 *   affect.valence  -> palette hue (cold ↔ warm)
 *   affect.arousal  -> palette brightness + breath amplitude
 *   extraversion    -> breath rate + amplitude (how lively it "breathes")
 *   openness        -> drift (how much the sigil explores between frames)
 *   emotionality    -> jitter (instability)
 *   conscientiousness -> symmetry (crisp & ordered ↔ organic)
 *   identity hash   -> seed (stable per persona) + glyph set
 *   voice           -> terse | balanced | expansive output style
 *
 * Pure + dependency-free: returns data (ANSI-256 indices + params). The TUI/REPL
 * paint it; the engine never prints.
 */

import { createHash } from "node:crypto";
import type { PersonaFrontmatter } from "./persona.js";

export interface PersonaTheme {
  seed: number;
  palette: { primary: number; secondary: number; accent: number; dim: number };
  motion: { breathRate: number; amplitude: number; jitter: number; drift: number; symmetry: number };
  glyphs: string[];
  voice: { density: "terse" | "balanced" | "expansive"; flourish: number };
  size: number;
}

const GLYPH_SETS = [
  [" ", "·", ":", "*", "✦", "█"],
  [" ", ".", "+", "x", "#", "█"],
  [" ", "˙", "∘", "○", "◍", "●"],
  [" ", "·", "✶", "✷", "✸", "✹"],
  [" ", "░", "▒", "▓", "█", "█"],
  [" ", "⋄", "◇", "◈", "◆", "▰"],
  [" ", "`", "'", "^", "≈", "☵"],
  [" ", "·", "-", "=", "≡", "█"],
  [" ", "˙", "•", "◦", "◉", "⬢"],
  [" ", "·", "⋅", "∗", "✺", "✸"],
  [" ", ".", "·", "•", "●", "⬤"],
  [" ", "▁", "▃", "▅", "▇", "█"],
];

function seedFrom(fm: PersonaFrontmatter): number {
  const id = fm.identity as { canonical_id?: string; display_name?: string } | undefined;
  const meta = fm.metadata as { name?: string } | undefined;
  // A RICH fingerprint so two personas differ even if one identity field collides:
  // identity + name + the trait/affect signature. Never a bare "persona" fallback.
  const traits = (fm.personality as { traits?: Record<string, { mean?: number }> } | undefined)?.traits ?? {};
  const sig = Object.entries(traits)
    .map(([k, v]) => `${k}:${typeof v?.mean === "number" ? v.mean.toFixed(2) : "?"}`)
    .sort()
    .join(",");
  const key = [id?.canonical_id, id?.display_name, meta?.name, sig].filter(Boolean).join("|") || JSON.stringify(fm).slice(0, 200);
  return parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) >>> 0;
}

/** HSV → nearest ANSI-256 cube index (16..231). Gives the full color wheel. */
function hsvAnsi(h: number, s: number, v: number): number {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to6 = (n: number) => Math.max(0, Math.min(5, Math.round((n + m) * 5)));
  return 16 + 36 * to6(r) + 6 * to6(g) + to6(b);
}

/**
 * Palette derived from the SEED's hue (so two personas differ in color regardless
 * of affect), nudged by affect: valence warms/cools the hue, arousal raises
 * saturation/brightness. Returns [primary, secondary, accent].
 */
function colorFromSeed(seed: number, valence: number, arousal: number): readonly [number, number, number] {
  const baseHue = seed % 360;
  const hue = (baseHue + valence * 25 + 360) % 360;
  const sat = Math.min(1, 0.5 + arousal * 0.35);
  const val = 0.7 + arousal * 0.2;
  const primary = hsvAnsi(hue, sat, val);
  const secondary = hsvAnsi(hue, sat * 0.65, Math.min(1, val + 0.2));
  const accent = hsvAnsi((hue + 38) % 360, Math.min(1, sat + 0.25), Math.min(1, val + 0.1));
  return [primary, secondary, accent];
}

function traitMean(fm: PersonaFrontmatter, name: string, dflt: number): number {
  const t = (fm.personality as { traits?: Record<string, { mean?: number }> } | undefined)?.traits?.[name];
  return typeof t?.mean === "number" ? t.mean : dflt;
}

function affectMean(fm: PersonaFrontmatter, dim: string, dflt: number): number {
  const a = (fm.affect as { baseline?: { core_affect?: Record<string, { mean?: number }> } } | undefined)?.baseline?.core_affect?.[dim];
  return typeof a?.mean === "number" ? a.mean : dflt;
}

export interface ThemedSigil {
  grid: string[];
  intensity: number;
}

function rng(seed: number): () => number {
  let s = seed || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** Live "breathing" intensity from state, paced by the theme's motion params. */
export function themeIntensity(theme: PersonaTheme, values: Record<string, number>, frame = 0): number {
  const tone = values["mood.tone"] ?? 0;
  const valence = values["affect.valence"] ?? 0;
  const arousal = values["affect.arousal"] ?? 0;
  const base = 0.5 + (tone + valence) * 0.25 + arousal * 0.1;
  const pulse = Math.sin((frame * theme.motion.breathRate) / 2) * theme.motion.amplitude * (0.5 + arousal);
  return Math.max(0.05, Math.min(1, base + pulse));
}

/**
 * Render a persona's sigil for one animation frame. Motion params shape it:
 *  - drift: how much the glyph re-seeds between frames (openness = exploratory);
 *  - jitter: per-cell instability (emotionality);
 *  - symmetry: mirror vs organic (conscientiousness).
 */
export function renderThemedSigil(theme: PersonaTheme, values: Record<string, number>, frame = 0): ThemedSigil {
  const { size, glyphs, motion } = theme;
  const half = Math.ceil(size / 2);
  const intensity = themeIntensity(theme, values, frame);
  const density = 0.25 + intensity * 0.6;
  // Drift re-seeds slowly for open personas, never for rigid ones.
  const frameSeed = theme.seed + Math.floor(frame * motion.drift) * 0x1000193;
  const next = rng(frameSeed);
  const rows: string[] = [];

  for (let y = 0; y < size; y++) {
    let left = "";
    for (let x = 0; x < half; x++) {
      const cy = (y - (size - 1) / 2) / size;
      const cx = (x - (size - 1) / 2) / size;
      const radial = 1 - Math.min(1, Math.sqrt(cx * cx + cy * cy) * 1.4);
      const jitter = (next() - 0.5) * motion.jitter;
      const v = (next() * (0.5 + radial) + jitter) * density;
      const idx = Math.max(0, Math.min(glyphs.length - 1, Math.floor(v * glyphs.length)));
      left += glyphs[idx];
    }
    // symmetry: high -> mirror; low -> let the right half diverge organically.
    let right: string;
    if (next() <= motion.symmetry) {
      right = left.slice(0, size - half).split("").reverse().join("");
    } else {
      right = Array.from({ length: size - half }, () => {
        const idx = Math.floor(next() * density * glyphs.length);
        return glyphs[Math.max(0, Math.min(glyphs.length - 1, idx))];
      }).join("");
    }
    rows.push((left + right).slice(0, size));
  }
  return { grid: rows, intensity };
}

export function personaTheme(fm: PersonaFrontmatter): PersonaTheme {
  const seed = seedFrom(fm);
  const valence = affectMean(fm, "valence", 0);
  const arousal = affectMean(fm, "arousal", 0.4);

  const openness = traitMean(fm, "openness", 0.5);
  const extraversion = traitMean(fm, "extraversion", 0.5);
  const emotionality = traitMean(fm, "emotionality", 0.5);
  const conscientiousness = traitMean(fm, "conscientiousness", 0.5);

  // Color from the seed's hue (distinct per persona), nudged by affect.
  const [primary, secondary, accent] = colorFromSeed(seed, valence, arousal);

  const verbosity = extraversion * 0.5 + openness * 0.3 - conscientiousness * 0.25;
  const density = verbosity > 0.18 ? "expansive" : verbosity < -0.05 ? "terse" : "balanced";

  // Glyph set from a fingerprint of seed + trait signature (not seed % N alone),
  // so personas with seeds differing by a multiple of N don't share glyphs.
  const glyphIdx = (seed ^ (Math.floor(openness * 97) * 7) ^ (Math.floor(conscientiousness * 89) * 13) ^ (Math.floor(emotionality * 83) * 17)) >>> 0;

  return {
    seed,
    palette: { primary, secondary, accent, dim: 236 + (seed % 6) },
    motion: {
      breathRate: Number((0.6 + extraversion * 1.8).toFixed(3)),
      amplitude: Number((0.04 + (extraversion + arousal) * 0.06).toFixed(3)),
      jitter: Number((emotionality * 0.5).toFixed(3)),
      drift: Number((openness * 0.6).toFixed(3)),
      symmetry: Number(conscientiousness.toFixed(3)),
    },
    glyphs: GLYPH_SETS[glyphIdx % GLYPH_SETS.length],
    voice: { density, flourish: Number(openness.toFixed(3)) },
    size: 9,
  };
}
