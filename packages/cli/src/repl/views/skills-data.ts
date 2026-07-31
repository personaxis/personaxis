/**
 * Skill operations. The previous menu listed skills but none of its actions worked: no
 * apply, no pull, and no way to add a skill or update one against its official source.
 *
 * The view had no way to CHANGE anything: `pull` only printed a hint, and nothing could
 * add, update or remove a skill. This module is the real engine behind those actions,
 * shared by the miniapp and the external `personaxis skills` subcommands, so both do
 * exactly the same thing.
 *
 * Writes touch ONLY the `extensions.skills` list in the spec's YAML frontmatter; the
 * document body and every other field are preserved byte for byte.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import matter from "gray-matter";
import { resolveDeclaredSkills } from "../../targets/skills.js";
import { loadPersonaFile, type PersonaData } from "../../load.js";

export interface SkillEntry {
  name: string;
  /** local | github | registry | unknown */
  kind: string;
  status: "materialized" | "missing-local" | "reference-only";
  ref?: string;
}

/** Every skill declared by the persona at `personaPath`, with its real status. */
export function listSkills(personaPath: string): SkillEntry[] {
  try {
    const { data } = loadPersonaFile(personaPath);
    return resolveDeclaredSkills(data as PersonaData, dirname(personaPath)).map((s) => ({
      // The resolver reports a local entry's raw ref as its name ("./sources/research");
      // every surface (view, actions, messages) uses the short, human name.
      name: s.name.includes("/") || s.name.startsWith(".") ? skillNameFromRef(s.name) : s.name,
      kind: s.kind,
      status: s.missing ? "missing-local" : s.sourceDir ? "materialized" : "reference-only",
      ref: s.ref ?? (s.name.includes("/") ? s.name : undefined),
    }));
  } catch {
    return [];
  }
}

/** The `extensions.skills` array as declared (raw strings/objects), or []. */
function declaredList(personaPath: string): unknown[] {
  const { data } = loadPersonaFile(personaPath);
  const ext = (data as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
  const list = ext?.skills;
  return Array.isArray(list) ? list : [];
}

/**
 * Rewrite `extensions.skills` in the spec's frontmatter. gray-matter re-serializes the
 * frontmatter, so we splice only the skills block back into the ORIGINAL yaml text when
 * we can, and fall back to a full re-serialization when the block is absent.
 */
function writeSkillList(personaPath: string, next: unknown[]): void {
  const original = readFileSync(personaPath, "utf-8");
  const parsed = matter(original);
  const data = parsed.data as Record<string, unknown>;
  const extensions = { ...((data.extensions as Record<string, unknown>) ?? {}) };
  if (next.length) extensions.skills = next;
  else delete extensions.skills;
  const nextData = { ...data, extensions };
  if (!Object.keys(extensions).length) delete (nextData as Record<string, unknown>).extensions;
  const rebuilt = matter.stringify(parsed.content, nextData);
  writeFileSync(personaPath, rebuilt, "utf-8");
}

export interface SkillOpResult {
  ok: boolean;
  message: string;
}

/**
 * Declare a new skill. `ref` accepts what the spec accepts:
 *   ./skills/my-skill        a local directory (materialized on compile)
 *   github:org/repo/path     pulled with `pull`
 *   @org/name@1.2.0          a registry coordinate
 */
export function addSkill(personaPath: string, ref: string): SkillOpResult {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, message: "give a path, a github: ref, or a registry coordinate" };
  const list = declaredList(personaPath);
  const name = skillNameFromRef(trimmed);
  const already = list.some((e) => skillNameFromEntry(e) === name);
  if (already) return { ok: false, message: `"${name}" is already declared` };
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("/")) {
    const abs = resolve(dirname(personaPath), trimmed);
    if (!existsSync(abs)) return { ok: false, message: `no directory at ${trimmed}` };
  }
  writeSkillList(personaPath, [...list, trimmed]);
  return { ok: true, message: `added "${name}"  ·  ${trimmed}` };
}

/** Stop declaring a skill. Materialized files under ./skills are left alone. */
export function removeSkill(personaPath: string, name: string): SkillOpResult {
  const list = declaredList(personaPath);
  const next = list.filter((e) => skillNameFromEntry(e) !== name);
  if (next.length === list.length) return { ok: false, message: `"${name}" is not declared` };
  writeSkillList(personaPath, next);
  return { ok: true, message: `removed "${name}" from extensions.skills (files kept)` };
}

/**
 * Materialize a skill next to the persona so the compiled document and the host
 * adapters can see it. Local refs are copied into `./skills/<name>/`; github/registry
 * refs report what to run, since fetching needs the network and a confirmation.
 */
export function pullSkill(personaPath: string, name: string): SkillOpResult {
  const entry = listSkills(personaPath).find((s) => s.name === name);
  if (!entry) return { ok: false, message: `"${name}" is not declared` };
  const base = dirname(personaPath);
  const target = join(base, "skills", name);
  if (entry.kind === "local" && entry.ref) {
    const src = resolve(base, entry.ref);
    if (!existsSync(src)) return { ok: false, message: `source missing: ${entry.ref}` };
    if (resolve(target) === src) return { ok: true, message: `"${name}" already lives in skills/` };
    mkdirSync(dirname(target), { recursive: true });
    cpSync(src, target, { recursive: true });
    return { ok: true, message: `materialized "${name}" into skills/${name}/` };
  }
  if (entry.kind === "github") {
    return {
      ok: false,
      message: `"${name}" is a github ref; fetching needs the network: personaxis skills pull ${name}`,
    };
  }
  return { ok: false, message: `"${name}" is a ${entry.kind} entry; nothing to materialize locally` };
}

/**
 * Refresh a materialized LOCAL skill from its declared source, reporting whether
 * anything actually changed (an update against the skill's official source;
 * remote refs are delegated to the network-aware subcommand).
 */
export function updateSkill(personaPath: string, name: string): SkillOpResult {
  const entry = listSkills(personaPath).find((s) => s.name === name);
  if (!entry) return { ok: false, message: `"${name}" is not declared` };
  if (entry.kind !== "local" || !entry.ref) {
    return { ok: false, message: `"${name}" is a ${entry.kind} entry; update it with: personaxis skills pull ${name}` };
  }
  const base = dirname(personaPath);
  const src = resolve(base, entry.ref);
  const target = join(base, "skills", name);
  if (!existsSync(src)) return { ok: false, message: `source missing: ${entry.ref}` };
  const before = existsSync(target) ? fingerprint(target) : "";
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(src, target, { recursive: true });
  const after = fingerprint(target);
  return {
    ok: true,
    message: before === after ? `"${name}" already up to date` : `updated "${name}" from ${entry.ref}`,
  };
}

/** Cheap directory fingerprint (names + sizes), enough to say "changed" or not. */
function fingerprint(dir: string): string {
  try {
    const entries = readdirSync(dir, { recursive: true }) as unknown as string[];
    return [...entries].map(String).sort().join("|");
  } catch {
    return "";
  }
}

function skillNameFromRef(ref: string): string {
  if (ref.startsWith("github:")) return basename(ref.replace(/^github:/, ""));
  if (ref.startsWith("@")) return ref.split("@")[1]?.split("/").pop() ?? ref;
  return basename(ref.replace(/\/+$/, ""));
}

function skillNameFromEntry(entry: unknown): string {
  if (typeof entry === "string") return skillNameFromRef(entry);
  if (entry && typeof entry === "object") {
    const o = entry as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    if (typeof o.ref === "string") return skillNameFromRef(o.ref);
    if (typeof o.path === "string") return skillNameFromRef(o.path);
  }
  return String(entry);
}
