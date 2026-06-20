import { readFileSync, existsSync } from "fs";
import { resolve, relative, dirname, basename } from "path";
import matter from "gray-matter";

const PERSONAXIS_DIR = ".personaxis";

export interface PersonaMetadata {
  name?: string;
  version?: string;
  display_name?: string;
  description?: string;
  created?: string;
  owner_tenant_id?: string;
  tags?: string[];
  license?: "private" | "public" | "custom";
}

/**
 * Extensions bloc. v0.6 renamed `refs` to `references`, removed
 * `knowledge_anchors`, and added `examples` + `assets`. We keep the
 * v0.5 fields as deprecated-optional so the CLI can still read old
 * personas and emit migration warnings.
 */
export interface PersonaExtensions {
  skills?: string[];
  tools?: string[];
  references?: string[];                  // v0.6
  examples?: string[];                    // v0.6
  assets?: string[];                      // v0.6
  refs?: string[];                        // v0.5 (deprecated)
  samples?: string[];                     // v0.5 (deprecated)
  knowledge_anchors?: string[];           // v0.5 (deprecated)
}

export interface PersonaData {
  apiVersion?: string;
  kind?: "AgentPersona" | "UserPersona";
  spec_version?: string;
  metadata?: PersonaMetadata;
  extensions?: PersonaExtensions;
  identity?: Record<string, unknown>;
  character?: Record<string, unknown>;
  personality?: Record<string, unknown>;
  values_and_drives?: Record<string, unknown>;
  affect?: Record<string, unknown>;
  cognition?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  metacognition?: Record<string, unknown>;
  reflexive_self_regulation?: Record<string, unknown>;
  persona?: Record<string, unknown>;
  governance?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  security?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoadResult {
  data: PersonaData;
  raw: string;
  path: string;
}

/**
 * Resolves the path to a `personaxis.md` (v0.7.0 quantitative spec).
 *
 * - `target` undefined -> root mode: `.personaxis/personaxis.md`, falling
 *   back to a legacy v0.6 root `PERSONA.md`/`persona.md` (10-layer
 *   frontmatter at the repo root).
 * - `target` an existing file path -> used directly.
 * - `target` anything else -> treated as a subagent slug:
 *   `.personaxis/personas/<slug>/personaxis.md`.
 */
export function resolvePersonaSourcePath(target?: string): string {
  if (target) {
    const resolved = resolve(target);
    if (existsSync(resolved)) return resolved;

    const slugPath = resolve(process.cwd(), PERSONAXIS_DIR, "personas", target, "personaxis.md");
    if (existsSync(slugPath)) return slugPath;

    throw new Error(
      `No personaxis.md found for "${target}". Searched:\n  ${resolved}\n  ${slugPath}`
    );
  }

  const rootSpec = resolve(process.cwd(), PERSONAXIS_DIR, "personaxis.md");
  if (existsSync(rootSpec)) return rootSpec;

  const legacy = [
    resolve(process.cwd(), "PERSONA.md"),
    resolve(process.cwd(), "persona.md"),
  ].find((p) => existsSync(p));
  if (legacy) return legacy;

  throw new Error(
    `No personaxis.md found. Expected:\n  ${rootSpec}\n` +
      `If this project uses the legacy v0.6 layout (root PERSONA.md with 10-layer frontmatter), ` +
      `run "personaxis migrate 0.6-to-0.7".`
  );
}

/** True if `filePath` belongs to a subagent persona under `.personaxis/personas/<slug>/`. */
export function isSubagentPath(filePath: string): boolean {
  return filePath.replace(/\\/g, "/").includes(`${PERSONAXIS_DIR}/personas/`);
}

/** Extracts `<slug>` from a `.personaxis/personas/<slug>/...` path. */
export function slugFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\.personaxis\/personas\/([^/]+)\//);
  return match?.[1] ?? basename(dirname(filePath));
}

export function loadPersonaFile(filePath?: string): LoadResult {
  const found = resolvePersonaSourcePath(filePath);
  const raw = readFileSync(found, "utf-8");

  if (raw.trimStart().startsWith("---")) {
    const parsed = matter(raw);
    return { data: parsed.data as PersonaData, raw, path: found };
  }

  throw new Error(
    `${relative(process.cwd(), found)} must use YAML frontmatter (delimited by ---).\n` +
      "If this is a v0.7.0 compiled PERSONA.md, point at .personaxis/personaxis.md instead.\n" +
      "See: https://github.com/personaxis/persona.md for the format."
  );
}

export function getPersonaName(data: PersonaData): string {
  return data.metadata?.name ?? data.metadata?.display_name ?? "persona";
}

export function getPersonaDisplayName(data: PersonaData): string {
  return data.metadata?.display_name ?? data.metadata?.name ?? "Agent";
}
