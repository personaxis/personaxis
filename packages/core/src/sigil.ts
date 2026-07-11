/**
 * Persona sigil, a deterministic, per-persona visual identity.
 *
 * Requirement: showing a persona must be *differentiated per
 * persona*, never generic. We derive a stable seed from the persona's identity
 * (canonical_id / display_name) and shape parameters from its quantitative
 * layers (personality, affect, values), then render a symmetric ASCII glyph plus
 * a color. The same persona always renders the same sigil; different specs render
 * visibly different sigils.
 *
 * The sigil also "breathes": given the live state.json values (mood/affect) it
 * shifts density and character set, so a *living* persona looks alive, and looks
 * alive in a way that is its own, not a shared spinner.
 *
 * Pure + dependency-free: returns data; the CLI applies ANSI color.
 */

import { createHash } from "node:crypto";
import type { PersonaFrontmatter } from "./persona.js";

export interface SigilParams {
  seed: number;
  /** 0..255 ANSI-256 color index derived from the persona. */
  color: number;
  /** Glyph palette (light -> dense) chosen by the seed. */
  charset: string[];
  size: number;
}

export interface Sigil {
  params: SigilParams;
  /** Rows of the rendered glyph (already mirrored / symmetric). */
  grid: string[];
}

const CHARSETS = [
  [" ", "·", ":", "*", "✦", "█"],
  [" ", ".", "+", "x", "#", "█"],
  [" ", "˙", "∘", "○", "◍", "●"],
  [" ", "·", "✶", "✷", "✸", "✹"],
  [" ", "░", "▒", "▓", "█", "█"],
  [" ", "⋄", "◇", "◈", "◆", "▰"],
];

function seedFrom(frontmatter: PersonaFrontmatter): number {
  const id = frontmatter.identity as
    | { canonical_id?: string; display_name?: string }
    | undefined;
  const meta = frontmatter.metadata as { name?: string } | undefined;
  const key =
    id?.canonical_id ?? id?.display_name ?? meta?.name ?? "persona";
  const hex = createHash("sha256").update(String(key)).digest("hex").slice(0, 8);
  return parseInt(hex, 16) >>> 0;
}

/** A tiny xorshift PRNG so the whole sigil is reproducible from one seed. */
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

export function sigilParams(frontmatter: PersonaFrontmatter, size = 7): SigilParams {
  const seed = seedFrom(frontmatter);
  return {
    seed,
    color: 17 + (seed % 214), // skip the dim 0-16 range
    charset: CHARSETS[seed % CHARSETS.length],
    size: size % 2 === 0 ? size + 1 : size,
  };
}

/**
 * Render a symmetric glyph. `intensity` in [0,1] shifts how dense the glyph is
 * (driven by live mood/affect for the "breathing" effect).
 */
export function renderSigil(params: SigilParams, intensity = 0.5): Sigil {
  const { size, charset } = params;
  const half = Math.ceil(size / 2);
  const next = rng(params.seed);
  const rows: string[] = [];
  const density = 0.25 + intensity * 0.6;

  for (let y = 0; y < size; y++) {
    let left = "";
    for (let x = 0; x < half; x++) {
      const r = next();
      // radial falloff so the glyph reads as a centered sigil
      const cy = (y - (size - 1) / 2) / size;
      const cx = (x - (size - 1) / 2) / size;
      const radial = 1 - Math.min(1, Math.sqrt(cx * cx + cy * cy) * 1.4);
      const v = r * (0.5 + radial) * density;
      const idx = Math.max(0, Math.min(charset.length - 1, Math.floor(v * charset.length)));
      left += charset[idx];
    }
    const mid = size % 2 === 1 ? left[left.length - 1] : "";
    const right = left.slice(0, size - half).split("").reverse().join("");
    rows.push((left + (mid ? "" : "") + right).slice(0, size));
  }
  return { params, grid: rows };
}

/**
 * Map live state values to a breathing intensity. Higher valence/tone/energy =>
 * a denser, brighter glyph. Phase animates a subtle pulse over `frame`.
 */
export function liveIntensity(values: Record<string, number>, frame = 0): number {
  const tone = values["mood.tone"] ?? 0;
  const valence = values["affect.valence"] ?? 0;
  const arousal = values["affect.arousal"] ?? values["mood.energy"] ?? 0;
  const base = 0.5 + (tone + valence) * 0.25 + arousal * 0.1;
  const pulse = Math.sin(frame / 2) * 0.08 * (0.5 + arousal);
  return Math.max(0.05, Math.min(1, base + pulse));
}
