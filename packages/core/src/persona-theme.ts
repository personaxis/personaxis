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
];

// Curated ANSI-256 palette families keyed by (valence, arousal) quadrant. Each is
// [primary, secondary, accent]; a 7th "dim" is derived. Hand-picked to read well.
const FAMILIES = {
  coolCalm: [24, 31, 37], // negative valence, low arousal — deep teal/blue
  coolSharp: [27, 33, 51], // negative valence, high arousal — electric blue/cyan
  warmCalm: [95, 137, 180], // positive valence, low arousal — earthy amber
  warmSharp: [202, 208, 220], // positive valence, high arousal — vivid orange/gold
  neutral: [60, 103, 146], // near-zero valence — muted violet
} as const;

function seedFrom(fm: PersonaFrontmatter): number {
  const id = fm.identity as { canonical_id?: string; display_name?: string } | undefined;
  const meta = fm.metadata as { name?: string } | undefined;
  const key = id?.canonical_id ?? id?.display_name ?? meta?.name ?? "persona";
  return parseInt(createHash("sha256").update(String(key)).digest("hex").slice(0, 8), 16) >>> 0;
}

function traitMean(fm: PersonaFrontmatter, name: string, dflt: number): number {
  const t = (fm.personality as { traits?: Record<string, { mean?: number }> } | undefined)?.traits?.[name];
  return typeof t?.mean === "number" ? t.mean : dflt;
}

function affectMean(fm: PersonaFrontmatter, dim: string, dflt: number): number {
  const a = (fm.affect as { baseline?: { core_affect?: Record<string, { mean?: number }> } } | undefined)?.baseline?.core_affect?.[dim];
  return typeof a?.mean === "number" ? a.mean : dflt;
}

function pickFamily(valence: number, arousal: number): readonly [number, number, number] {
  if (Math.abs(valence) < 0.12) return FAMILIES.neutral;
  if (valence < 0) return arousal >= 0.5 ? FAMILIES.coolSharp : FAMILIES.coolCalm;
  return arousal >= 0.5 ? FAMILIES.warmSharp : FAMILIES.warmCalm;
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

  const [primary, secondary, accent] = pickFamily(valence, arousal);

  const verbosity = extraversion * 0.5 + openness * 0.3 - conscientiousness * 0.25;
  const density = verbosity > 0.18 ? "expansive" : verbosity < -0.05 ? "terse" : "balanced";

  return {
    seed,
    palette: { primary, secondary, accent, dim: 240 + (seed % 4) },
    motion: {
      breathRate: Number((0.6 + extraversion * 1.8).toFixed(3)),
      amplitude: Number((0.04 + (extraversion + arousal) * 0.06).toFixed(3)),
      jitter: Number((emotionality * 0.5).toFixed(3)),
      drift: Number((openness * 0.6).toFixed(3)),
      symmetry: Number(conscientiousness.toFixed(3)),
    },
    glyphs: GLYPH_SETS[seed % GLYPH_SETS.length],
    voice: { density, flourish: Number(openness.toFixed(3)) },
    size: 9,
  };
}
