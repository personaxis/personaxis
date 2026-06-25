/**
 * Multi-persona roster — project-local sub-personas under
 * `.personaxis/personas/<slug>/`, addressable from the REPL with `@slug` / `@all`.
 *
 * The root persona is who you talk to by default; sub-personas are specialists you
 * delegate to or converse with. Each sub keeps its OWN spec, compiled persona.md,
 * state, memory and improvements (the same layout as the root, one folder deeper),
 * so the structure recurses. Discovery is read-only and never mutates anything.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export interface SubPersonaRef {
  /** Last slug segment (display name), e.g. "legal". */
  slug: string;
  /** Hierarchical address from the root, e.g. "cmo/legal". */
  address: string;
  /** Nesting depth (1 = direct child of the root). */
  depth: number;
  /** Absolute path to the sub-persona's personaxis.md. */
  path: string;
}

/** The `.personaxis/personas` directory sibling to a persona's personaxis.md. */
export function personasDir(personaPath: string): string {
  return join(dirname(personaPath), "personas");
}

/** Discover the DIRECT sub-personas of a persona (each `personas/<slug>/personaxis.md`). */
export function discoverSubPersonas(personaPath: string): { slug: string; path: string }[] {
  const dir = personasDir(personaPath);
  if (!existsSync(dir)) return [];
  const out: { slug: string; path: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry, "personaxis.md");
    try {
      if (statSync(join(dir, entry)).isDirectory() && existsSync(sub)) out.push({ slug: entry, path: sub });
    } catch {
      /* skip unreadable entries */
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Discover the WHOLE sub-persona tree under a root, recursing to unlimited depth
 * (a sub can itself have `.../<slug>/personas/<sub2>/`). Returns a flat list addressed
 * hierarchically ("cmo", "cmo/legal", …), depth-first, read-only.
 */
export function discoverTree(rootPersonaPath: string): SubPersonaRef[] {
  const out: SubPersonaRef[] = [];
  const seen = new Set<string>(); // cycle guard (symlinks)
  const walk = (parentPath: string, prefix: string[]): void => {
    for (const ref of discoverSubPersonas(parentPath)) {
      const chain = [...prefix, ref.slug];
      const real = ref.path.replace(/\\/g, "/");
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ slug: ref.slug, address: chain.join("/"), depth: chain.length, path: ref.path });
      walk(ref.path, chain);
    }
  };
  walk(rootPersonaPath, []);
  return out;
}

// Fixed, distinct ANSI-256 colours for sub-persona replies. Curated to avoid red
// (reserved for errors) and the terminal default (reserved for the ROOT persona),
// and to stay legible on both light and dark backgrounds.
const SUB_PALETTE = [39, 78, 213, 214, 141, 45, 208, 156, 117, 199, 120, 222, 81, 170, 220, 51];

/**
 * Assign a FIXED colour to a slug: deterministic (hash of the slug) so it is stable
 * across sessions, with in-session collision avoidance via `taken`. Filling `taken`
 * in a stable order (discoverSubPersonas is sorted) keeps assignments reproducible.
 */
export function colorForSlug(slug: string, taken: Set<number>): number {
  let h = 7;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  for (let i = 0; i < SUB_PALETTE.length; i++) {
    const c = SUB_PALETTE[(h + i) % SUB_PALETTE.length];
    if (!taken.has(c)) {
      taken.add(c);
      return c;
    }
  }
  return SUB_PALETTE[h % SUB_PALETTE.length];
}
