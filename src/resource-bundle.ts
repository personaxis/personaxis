import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { createTarGz, extractTarGz, type TarEntry } from "./tar.js";

const ENTRIES = ["memory.md", "memory", "references", "examples", "skills", "assets"] as const;

function walk(dir: string, base: string, out: TarEntry[]): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name.startsWith(".")) continue;
    const full = join(dir, name.name);
    const rel = `${base}/${name.name}`;
    if (name.isDirectory()) {
      walk(full, rel, out);
    } else if (name.isFile()) {
      out.push({ path: rel, content: readFileSync(full) });
    }
  }
}

/**
 * Bundles `memory.md`, `memory/`, `references/`, `examples/`, `skills/`, and
 * `assets/` from `baseDir` (`.personaxis/` or `.personaxis/personas/<slug>/`)
 * into a single gzip-compressed tarball for `push`/`pull`.
 */
export function buildResourceBundle(baseDir: string): Buffer {
  const entries: TarEntry[] = [];

  for (const name of ENTRIES) {
    const full = join(baseDir, name);
    if (!existsSync(full)) continue;

    const stat = statSync(full);
    if (stat.isFile()) {
      entries.push({ path: name, content: readFileSync(full) });
    } else if (stat.isDirectory()) {
      walk(full, name, entries);
    }
  }

  return createTarGz(entries);
}

/** Writes a bundle produced by `buildResourceBundle` back into `baseDir`. */
export function extractResourceBundle(baseDir: string, bundle: Buffer): void {
  for (const entry of extractTarGz(bundle)) {
    const dest = join(baseDir, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.content);
  }
}
