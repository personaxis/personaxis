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
  slug: string;
  /** Absolute path to the sub-persona's personaxis.md. */
  path: string;
}

/** The `.personaxis/personas` directory sibling to the (root) personaxis.md. */
export function personasDir(rootPersonaPath: string): string {
  return join(dirname(rootPersonaPath), "personas");
}

/** Discover project-local sub-personas (each `<slug>/personaxis.md`). Sorted, read-only. */
export function discoverSubPersonas(rootPersonaPath: string): SubPersonaRef[] {
  const dir = personasDir(rootPersonaPath);
  if (!existsSync(dir)) return [];
  const out: SubPersonaRef[] = [];
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
