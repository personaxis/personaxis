/**
 * F3.2 — the host placement target registry (in core so the SaaS can place
 * documents server-side, not only the CLI).
 *
 * A COMPILE TARGET adapts the canonical compiled document (produced by the
 * stage-1 assembler + optional polish) into a specific host's identity/subagent
 * convention — computing both the path and the content. Targets are registered
 * as plugins: `registerTarget()` adds one, `getTarget()`/`listTargets()` read
 * the registry, and the four built-ins (claude-code, codex, openclaw, hermes)
 * are registered on import.
 *
 *   claude-code  root → <rootOutputPath> (shared)  · sub → .claude/agents/<slug>.md
 *   codex        root → <rootOutputPath> (shared)  · sub → .codex/agents/<slug>.toml
 *   openclaw     root → SOUL.md                     · sub → .openclaw/agents/<slug>/SOUL.md
 *   hermes       root → .hermes/SOUL.md             · sub → .hermes/agents/<slug>/SOUL.md
 *
 * SOUL.md hosts (openclaw, Hermes) read the file as the FIRST system-prompt
 * section and RE-READ it fresh at the start of every message/session — so a
 * recompile takes effect with no restart (hot reload). Claude Code / Codex read
 * the root document via an `@PERSONA.md` reference from CLAUDE.md / AGENTS.md,
 * so only a SUBAGENT compile places a new file for them.
 */

import matter from "gray-matter";

export interface PlacementContext {
  isSubagent: boolean;
  slug?: string;
  /** Where the canonical root document lives (e.g. "PERSONA.md") — used by shared-root targets. */
  rootOutputPath: string;
}

export interface PlacementResult {
  /** Relative path the placed document should be written to. */
  path: string;
  content: string;
}

export interface CompileTarget {
  /** Stable id used on the CLI (`--platform <id>`) and in configs. */
  id: string;
  /** True for hosts that read SOUL.md at the workspace/profile root (no @PERSONA.md baseline). */
  isSoul: boolean;
  /** Adapt the compiled document to this host's convention. */
  place(compiledText: string, ctx: PlacementContext): PlacementResult;
}

/** TOML string literal (JSON encoding is a valid TOML basic string). */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * SOUL.md placement — reuse the canonical compiled document (already a
 * second-person qualitative identity doc), stripping only the subagent
 * `name`/`description` frontmatter that openclaw/Hermes don't use.
 */
export function toSoulMd(compiledText: string): string {
  const { content } = matter(compiledText);
  const body = content.trim();
  return body.startsWith("#") ? body : `# SOUL\n\n${body}`;
}

const claudeCodeTarget: CompileTarget = {
  id: "claude-code",
  isSoul: false,
  place(compiledText, ctx) {
    if (!ctx.isSubagent) return { path: ctx.rootOutputPath, content: compiledText };
    return { path: `.claude/agents/${ctx.slug ?? "agent"}.md`, content: compiledText };
  },
};

const codexTarget: CompileTarget = {
  id: "codex",
  isSoul: false,
  place(compiledText, ctx) {
    if (!ctx.isSubagent) return { path: ctx.rootOutputPath, content: compiledText };
    const slug = ctx.slug ?? "agent";
    const { data, content } = matter(compiledText);
    const name = typeof data.name === "string" ? data.name : slug;
    const description = typeof data.description === "string" ? data.description : "";
    const toml =
      [
        `name = ${tomlString(name)}`,
        `description = ${tomlString(description)}`,
        `developer_instructions = ${tomlString(content.trim())}`,
      ].join("\n") + "\n";
    return { path: `.codex/agents/${slug}.toml`, content: toml };
  },
};

const openclawTarget: CompileTarget = {
  id: "openclaw",
  isSoul: true,
  place(compiledText, ctx) {
    const slug = ctx.slug ?? "agent";
    return {
      path: ctx.isSubagent ? `.openclaw/agents/${slug}/SOUL.md` : "SOUL.md",
      content: toSoulMd(compiledText),
    };
  },
};

const hermesTarget: CompileTarget = {
  id: "hermes",
  isSoul: true,
  place(compiledText, ctx) {
    const slug = ctx.slug ?? "agent";
    return {
      path: ctx.isSubagent ? `.hermes/agents/${slug}/SOUL.md` : ".hermes/SOUL.md",
      content: toSoulMd(compiledText),
    };
  },
};

const registry = new Map<string, CompileTarget>();

/** Register (or override) a compile target plugin. */
export function registerTarget(target: CompileTarget): void {
  registry.set(target.id, target);
}

/** Resolve a target by id (undefined when unknown). */
export function getTarget(id: string): CompileTarget | undefined {
  return registry.get(id);
}

/** All registered target ids, in registration order. */
export function listTargets(): string[] {
  return [...registry.keys()];
}

for (const t of [claudeCodeTarget, codexTarget, openclawTarget, hermesTarget]) registerTarget(t);

/** The built-in host ids (stable order), for CLI help and validation. */
export const BUILTIN_TARGETS = ["claude-code", "codex", "openclaw", "hermes"] as const;
export type BuiltinTarget = (typeof BUILTIN_TARGETS)[number];

/** Convenience: place a document for a host id. Throws on an unknown target. */
export function placeForTarget(
  compiledText: string,
  targetId: string,
  ctx: PlacementContext,
): PlacementResult {
  const target = getTarget(targetId);
  if (!target) throw new Error(`Unknown compile target "${targetId}". Known: ${listTargets().join(", ")}`);
  return target.place(compiledText, ctx);
}

/** Whether a host reads SOUL.md at the root (no @PERSONA.md baseline injection). */
export function isSoulTarget(targetId: string | undefined): boolean {
  return targetId ? getTarget(targetId)?.isSoul ?? false : false;
}
