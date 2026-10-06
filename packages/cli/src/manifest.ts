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
/**
 * R5: where an installed persona came from, and what it looked like on arrival.
 *
 * ASI04 is supply chain, and a persona pulled from a registry is a supply chain with
 * one link. MEASURED on 2026-09-09: `personaxis pull` knew the registry, the slug and
 * the version (it prints all three), wrote the file verbatim, and **recorded none of
 * it**. So an installed persona could not answer either half of the question this row
 * asks: where it came from, and what changed since.
 *
 * It lives in the manifest rather than in a file of its own, and rather than in the
 * persona document. Not in the document, because `R6` fixed the rule that a persona's
 * definition must load in a host that is not ours, and "I was pulled from this
 * registry on Tuesday" is a fact about THIS COPY, not about the worker. Not in a new
 * sidecar, because the manifest is already the thing beside a persona that holds
 * hashes so a hand-edit can be detected, and a second file holding a second hash of
 * the same document is how two answers to one question start.
 */
export interface InstallProvenance {
  /** The registry it was pulled from, by base URL, so a private one is legible too. */
  registry: string;
  slug: string;
  /** What the registry said it was serving, verbatim. */
  version: string;
  /** ISO-8601. */
  at: string;
  /**
   * The hash of the file AS DELIVERED.
   *
   * This is the half that makes "what changed since" answerable rather than a promise:
   * without a baseline taken at the moment of arrival, a local edit and an upstream
   * difference are the same unknown.
   */
  hash: string;
}

export interface PersonaManifest {
  spec_version: string;
  /**
   * The compile half, absent on a manifest written by an install.
   *
   * Optional because a pulled persona has not been compiled yet, and filling these in
   * with empty strings would have been a manifest that claims a compile happened. Every
   * reader already handles a missing manifest, so handling missing halves is the same
   * branch one level in.
   */
  compiledPath?: string;
  personaxisMdHash?: string;
  compiledMdHash?: string;
  lastOp: "compile" | "decompile" | "install";
  model?: string;
  source?: ProviderSource | "manual";
  timestamp: string;
  /** Present when this copy was installed from a registry rather than written here. */
  installed?: InstallProvenance;
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

/**
 * R5: write down that this copy was installed, keeping whatever was already known.
 *
 * A named function rather than an object literal inside `pull`'s action, for the same
 * reason the sub-task session is one: the rule here can then be checked without a
 * network, a registry, or a process that calls `process.exit`.
 *
 * The rule is the MERGE. Pulling over a persona that has already been compiled must
 * not erase the compile baseline: those hashes are what `validate` and `push` read to
 * tell a hand-edit from a clean tree, and replacing the manifest outright would make
 * a re-pull look like a fresh checkout that nobody had ever touched.
 */
export function recordInstall(baseDir: string, installed: InstallProvenance): PersonaManifest {
  const previous = loadManifest(baseDir);
  const manifest: PersonaManifest = {
    ...(previous ?? { spec_version: "unknown" }),
    lastOp: "install",
    timestamp: installed.at,
    installed,
  };
  saveManifest(baseDir, manifest);
  return manifest;
}
