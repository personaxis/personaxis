import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hashContent, isPinned, type ContentEntry } from "@personaxis/core";
import { join } from "path";
import matter from "gray-matter";
import type { PersonaData } from "../load.js";
import type { PlacementPlatform } from "./placement.js";
import { tomlString } from "./codex.js";

const GENERATED_MARKER = ".personaxis-generated";

export type DeclaredSkillKind = "local" | "registry" | "github";
export type SkillStatus = "materialized" | "missing-local" | "reference-only";

export interface DeclaredSkill {
  name: string;
  kind: DeclaredSkillKind;
  /** Source directory for `local` skills (`<baseDir>/skills/<name>`). */
  sourceDir?: string;
  /** Original `@org/name@version` or `github:org/repo[/path]` reference. */
  ref?: string;
  /** `local` skill whose `skills/<name>/SKILL.md` does not exist. */
  missing?: boolean;
}

export interface MaterializedSkill {
  name: string;
  destDir: string;
}

interface SkillsManifestEntry {
  name: string;
  kind: DeclaredSkillKind;
  ref?: string;
  status: SkillStatus;
  /**
   * sha256 over the skill's content, for a local skill that exists.
   *
   * A skill is code the persona runs and did not author, and the manifest is
   * where a reviewer sees what they were looking at. Without this the manifest
   * records that a skill was present, which is a weaker claim than recording
   * what it was.
   */
  contentHash?: string;
  fileCount?: number;
  /**
   * Whether the reference commits to a specific version.
   *
   * Not a refusal: refusing an unpinned reference would make the common case
   * impossible before anyone has a lockfile. It is stated so the surface
   * showing a persona's skills can say which of them can change without anyone
   * acting.
   */
  pinned?: boolean;
}

/**
 * Reads a skill directory into the entries the hash covers.
 *
 * Text only, and sorted by the hasher. A binary in a skill directory is a
 * different problem from an edited script and is out of scope here; what this
 * catches is the case that actually happens, which is a script changing under a
 * reference that did not move.
 */
function contentOf(dir: string, prefix = "", depth = 0): ContentEntry[] {
  // Bounded. A symlink loop in a fetched skill would otherwise walk forever,
  // and the failure would look like a hang rather than a bad skill.
  if (depth > 8 || !existsSync(dir)) return [];

  const entries: ContentEntry[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    const full = join(dir, item.name);

    if (item.isDirectory()) {
      entries.push(...contentOf(full, relative, depth + 1));
      continue;
    }
    if (!item.isFile()) continue;

    try {
      entries.push({ path: relative, content: readFileSync(full, "utf-8") });
    } catch {
      // Unreadable is not the same as absent, and it must not silently shrink
      // the hash: a placeholder keeps the file in the count and changes the
      // digest, so the mismatch is visible.
      entries.push({ path: relative, content: "[unreadable]" });
    }
  }
  return entries;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length ? values : undefined;
}

function localSkillName(entry: string): string {
  return entry.replace(/^\.?\/?skills\//, "").replace(/\/$/, "");
}

/**
 * Parses `extensions.skills` and classifies each entry:
 * - `./skills/<name>` (or `<name>` without prefix) -> `local`, resolved
 *   against `<baseDir>/skills/<name>/SKILL.md`.
 * - `@org/name@version` -> `registry`.
 * - `github:org/repo[/path]` -> `github`.
 */
export function resolveDeclaredSkills(data: PersonaData, baseDir: string): DeclaredSkill[] {
  const entries = asStringArray(data.extensions?.skills) ?? [];

  return entries.map((entry) => {
    if (entry.startsWith("github:")) {
      const ref = entry.slice("github:".length);
      const name = ref.split("/").pop() || ref;
      return { name, kind: "github", ref };
    }

    if (entry.startsWith("@")) {
      const versionSep = entry.lastIndexOf("@");
      const withoutVersion = versionSep > 0 ? entry.slice(0, versionSep) : entry;
      const name = withoutVersion.split("/").pop() || withoutVersion;
      return { name, kind: "registry", ref: entry };
    }

    const name = localSkillName(entry);
    const sourceDir = join(baseDir, "skills", name);
    const missing = !existsSync(join(sourceDir, "SKILL.md"));
    return { name, kind: "local", sourceDir, missing: missing || undefined };
  });
}

function ensureGeneratedDestination(destDir: string): void {
  const marker = join(destDir, GENERATED_MARKER);

  if (existsSync(destDir) && existsSync(marker)) {
    rmSync(destDir, { recursive: true, force: true });
  }

  mkdirSync(destDir, { recursive: true });
  writeFileSync(
    marker,
    "Generated by personaxis. Do not edit this directory directly; edit skills/<name>/ in the source persona and recompile.\n",
    "utf-8",
  );
}

/**
 * Copies every materializable `local` skill into the platform's skill
 * discovery directory (`.claude/skills/<name>/` for claude-code,
 * `.agents/skills/<name>/` for codex), marking each destination with
 * `.personaxis-generated` so future compiles can safely regenerate it.
 */
export function materializeLocalSkills(
  skills: DeclaredSkill[],
  baseDir: string,
  platform: PlacementPlatform,
): MaterializedSkill[] {
  const root = platform === "claude-code" ? join(".claude", "skills") : join(".agents", "skills");
  const materialized: MaterializedSkill[] = [];

  for (const skill of skills) {
    if (skill.kind !== "local" || skill.missing || !skill.sourceDir) continue;

    const destDir = join(root, skill.name);
    ensureGeneratedDestination(destDir);
    cpSync(skill.sourceDir, destDir, { recursive: true, force: true });
    materialized.push({ name: skill.name, destDir });
  }

  return materialized;
}

/**
 * D.3/D.3b: applies skill preload (`skills:` frontmatter) and access control
 * (`disallowedTools`/`[[skills.config]]`) to a compiled SUBAGENT document,
 * after `placeCompiledDocument` has produced the platform-specific output.
 *
 * - Claude Code: `skills:` lists materialized local skills (preload). If
 *   `extensions.skills` is non-empty, `Skill` is removed from
 *   `disallowedTools` (so the subagent can invoke skills). If empty (and no
 *   local `skills/`), `Skill` is added to `disallowedTools`.
 * - Codex: appends `[[skills.config]]` blocks - `enabled = true` for this
 *   subagent's own materialized skills, `enabled = false` for skills
 *   materialized by other personas under `.agents/skills/`. See
 *   openai/codex#14161 - per-subagent overrides may not be respected yet.
 */
export function applySkillsToSubagent(
  content: string,
  platform: PlacementPlatform,
  declaredSkills: DeclaredSkill[],
  materialized: MaterializedSkill[],
): string {
  if (platform === "claude-code") {
    const { data, content: body } = matter(content);
    const localNames = materialized.map((skill) => skill.name);

    if (localNames.length) {
      data.skills = localNames;
    } else {
      delete data.skills;
    }

    const hasDeclared = declaredSkills.length > 0;
    let disallowed = Array.isArray(data.disallowedTools) ? (data.disallowedTools as string[]) : [];
    if (hasDeclared) {
      disallowed = disallowed.filter((tool) => tool !== "Skill");
    } else if (!disallowed.includes("Skill")) {
      disallowed = [...disallowed, "Skill"];
    }

    if (disallowed.length) {
      data.disallowedTools = disallowed;
    } else {
      delete data.disallowedTools;
    }

    return matter.stringify(body, data).trimEnd() + "\n";
  }

  // codex: append [[skills.config]] blocks for own skills (enabled) and other
  // personas' materialized skills found under .agents/skills/ (disabled).
  const ownNames = new Set(materialized.map((skill) => skill.name));
  const lines = [content.trimEnd()];

  for (const skill of materialized) {
    lines.push("", "[[skills.config]]", `path = ${tomlString(`.agents/skills/${skill.name}/SKILL.md`)}`, "enabled = true");
  }

  const skillsRoot = join(".agents", "skills");
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || ownNames.has(entry.name)) continue;
      if (!existsSync(join(skillsRoot, entry.name, "SKILL.md"))) continue;
      lines.push("", "[[skills.config]]", `path = ${tomlString(`.agents/skills/${entry.name}/SKILL.md`)}`, "enabled = false");
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Writes `.personaxis/[personas/<slug>/]skills-manifest.json`: a snapshot of
 * `extensions.skills` resolution status, used by `personaxis skills list`
 * without re-walking the filesystem.
 */
export function writeSkillsManifest(skills: DeclaredSkill[], baseDir: string): void {
  const entries: SkillsManifestEntry[] = skills.map((skill) => {
    if (skill.kind === "local") {
      if (skill.missing || !skill.sourceDir) {
        return { name: skill.name, kind: skill.kind, status: "missing-local" as SkillStatus };
      }

      const content = contentOf(skill.sourceDir);
      return {
        name: skill.name,
        kind: skill.kind,
        status: "materialized" as SkillStatus,
        contentHash: hashContent(content),
        fileCount: content.length,
        // A local skill is as pinned as the working tree it sits in, which is
        // the same trust level as the persona document beside it.
        pinned: true,
      };
    }

    return {
      name: skill.name,
      kind: skill.kind,
      ref: skill.ref,
      status: "reference-only" as SkillStatus,
      pinned: skill.ref ? isPinned(skill.ref) : false,
    };
  });

  writeFileSync(join(baseDir, "skills-manifest.json"), JSON.stringify({ skills: entries }, null, 2) + "\n", "utf-8");
}
