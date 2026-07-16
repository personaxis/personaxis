import { readFileSync, existsSync } from "fs";
import { resolve, relative, dirname, basename, join } from "path";
import { homedir } from "os";
import matter from "gray-matter";

const PERSONAXIS_DIR = ".personaxis";

/** Case-insensitive on Windows (drive letters and user dirs vary in case). */
function sameDir(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Walk up from `startDir` looking for `<dir>/.personaxis/personaxis.md` (like git
 * resolves its repo root). SPEC assumption (documented): the nearest ancestor wins;
 * inside the user's home the walk STOPS at the home directory itself (so
 * `~/.personaxis` acts as the global persona and the search never crosses into
 * other users' space); outside the home it stops at the filesystem root.
 */
function findRootSpecUpwards(startDir: string): string | undefined {
  if (process.env.PERSONAXIS_NO_INHERIT === "1") return undefined; // explicit opt-out (CI, tests, isolation)
  let dir = resolve(startDir);
  const home = resolve(homedir());
  const underHome = process.platform === "win32" ? dir.toLowerCase().startsWith(home.toLowerCase()) : dir.startsWith(home);
  for (;;) {
    const candidate = join(dir, PERSONAXIS_DIR, "personaxis.md");
    if (existsSync(candidate)) return candidate;
    if (underHome && sameDir(dir, home)) return undefined; // home itself was just checked
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

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
  self_regulation?: Record<string, unknown>; // v1.0 layer-9 name
  reflexive_self_regulation?: Record<string, unknown>; // legacy (≤0.10) layer-9 name
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

    // A slug address may be NESTED ("cmo/legal" => personas/cmo/personas/legal/…).
    const segs = target.split("/").filter(Boolean);
    const slugRel = "personas/" + segs.join("/personas/");
    const slugPath = resolve(process.cwd(), PERSONAXIS_DIR, slugRel, "personaxis.md");
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

  // Nothing at the cwd: walk up ancestors (like git), so a persona initialized at the
  // repo root (or the user's home) is found from any subdirectory.
  const inherited = findRootSpecUpwards(dirname(process.cwd()));
  if (inherited) return inherited;

  throw new Error(
    `No personaxis.md found. Expected:\n  ${rootSpec}\n` +
      `(also searched every ancestor directory of ${process.cwd()})\n` +
      `If this project uses the legacy v0.6 layout (root PERSONA.md with 10-layer frontmatter), ` +
      `run "personaxis migrate 0.6-to-0.7".`
  );
}

/**
 * Canonical location of the COMPILED document for a given quantitative spec:
 *   sub-persona -> `.personaxis/personas/<slug>/PERSONA.md` (inside its folder)
 *   root persona -> `<repo>/PERSONA.md` (one level ABOVE `.personaxis/`)
 *   root persona in the user's HOME -> `~/.personaxis/PERSONA.md`
 * The HOME exception is a documented assumption (SPEC is silent): the home directory is
 * not a project root, so a loose `~/PERSONA.md` would be litter the user never finds.
 * Single owner of this rule; compile (write) and the REPL (read) both use it.
 */
/**
 * Resolve a `-p/--persona` OPTION with a cwd-literal default: an explicit path wins
 * untouched; when the caller left the default and it does not exist at the cwd, fall
 * back to the walked-up root spec (same discovery `personaxis` itself uses).
 */
export function resolvePersonaOption(optPath: string, def = ".personaxis/personaxis.md"): string {
  const resolved = resolve(optPath);
  if (existsSync(resolved) || optPath !== def) return resolved;
  try {
    return resolvePersonaSourcePath();
  } catch {
    return resolved; // let the caller report "not found" at the literal location
  }
}

export function compiledPathFor(personaPath: string): string {
  const baseDir = dirname(personaPath);
  if (isSubagentPath(personaPath)) return join(baseDir, "PERSONA.md");
  const parent = dirname(baseDir);
  if (sameDir(parent, homedir())) return join(baseDir, "PERSONA.md");
  return join(parent, "PERSONA.md");
}

/** True if `filePath` belongs to a subagent persona under `.personaxis/personas/<slug>/`. */
export function isSubagentPath(filePath: string): boolean {
  return filePath.replace(/\\/g, "/").includes(`${PERSONAXIS_DIR}/personas/`);
}

/**
 * The full slug chain for a (possibly NESTED) sub-persona path. A persona at
 * `.personaxis/personas/cmo/personas/legal/personaxis.md` yields `["cmo", "legal"]`.
 * The root persona yields `[]`. Supports unlimited nesting depth.
 */
export function slugChainFromPath(filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.indexOf(`${PERSONAXIS_DIR}/personas/`);
  if (idx < 0) return [];
  const tail = normalized.slice(idx); // .personaxis/personas/<slug>[/personas/<slug>…]
  const chain: string[] = [];
  const re = /personas\/([^/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail))) chain.push(m[1]);
  return chain;
}

/** The hierarchical address for a sub-persona path, e.g. `"cmo/legal"` ("" for root). */
export function slugAddressFromPath(filePath: string): string {
  return slugChainFromPath(filePath).join("/");
}

/** The LAST slug segment (display name) of a `.personaxis/personas/.../<slug>/...` path. */
export function slugFromPath(filePath: string): string {
  const chain = slugChainFromPath(filePath);
  return chain.length ? chain[chain.length - 1] : basename(dirname(filePath));
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
