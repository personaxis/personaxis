import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ProviderSource } from "./providers/types.js";

/**
 * `.personaxis/[personas/<slug>/]manifest.json` - tracks the last
 * compile/decompile operation that produced the `personaxis.md` /
 * `PERSONA.md`/`<slug>.md` pair, plus content hashes so `validate`/`push`
 * can detect hand-edits to either side.
 */
export interface PersonaManifest {
  spec_version: string;
  compiledPath: string;
  personaxisMdHash: string;
  compiledMdHash: string;
  lastOp: "compile" | "decompile";
  model: string;
  source: ProviderSource | "manual";
  timestamp: string;
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export function manifestPath(baseDir: string): string {
  return join(baseDir, "manifest.json");
}

export function loadManifest(baseDir: string): PersonaManifest | undefined {
  const p = manifestPath(baseDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PersonaManifest;
  } catch {
    return undefined;
  }
}

export function saveManifest(baseDir: string, manifest: PersonaManifest): void {
  writeFileSync(manifestPath(baseDir), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
