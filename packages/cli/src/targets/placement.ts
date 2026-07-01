import matter from "gray-matter";
import type { CompileTargetInfo } from "../compile-instructions.js";
import { tomlString } from "./codex.js";
import { toSoulMd } from "./soul-md.js";

export const PLACEMENT_PLATFORMS = ["claude-code", "codex", "openclaw", "hermes"] as const;
export type PlacementPlatform = (typeof PLACEMENT_PLATFORMS)[number];

export interface PlacementResult {
  /** Relative path the placed document should be written to. */
  path: string;
  content: string;
}

/**
 * Takes the canonical compiled document produced by `runCompile` (Markdown, with a
 * `name`/`description` YAML frontmatter for subagents) and adapts it to a host's identity/subagent
 * convention. Computes BOTH the path and the content, for the root persona and sub-personas:
 *
 *   claude-code  root → PERSONA.md (shared)      · sub → .claude/agents/<slug>.md
 *   codex        root → PERSONA.md (shared)      · sub → .codex/agents/<slug>.toml
 *   openclaw     root → SOUL.md                  · sub → .openclaw/agents/<slug>/SOUL.md
 *   hermes       root → .hermes/SOUL.md          · sub → .hermes/agents/<slug>/SOUL.md
 *
 * openclaw and Hermes both read SOUL.md as the first system-prompt section, so their placement emits
 * SOUL.md for root too (not just subagents). Claude Code / Codex root docs are platform-agnostic
 * (`@PERSONA.md` is referenced from CLAUDE.md / AGENTS.md), so those return the canonical PERSONA.md.
 */
export function placeCompiledDocument(
  compiledText: string,
  target: CompileTargetInfo,
  platform: PlacementPlatform,
): PlacementResult {
  const slug = target.slug ?? "agent";

  if (platform === "openclaw") {
    return { path: target.isSubagent ? `.openclaw/agents/${slug}/SOUL.md` : "SOUL.md", content: toSoulMd(compiledText) };
  }
  if (platform === "hermes") {
    return { path: target.isSubagent ? `.hermes/agents/${slug}/SOUL.md` : ".hermes/SOUL.md", content: toSoulMd(compiledText) };
  }

  // claude-code / codex: the root document is shared (referenced via @PERSONA.md), so only a
  // SUBAGENT compile changes anything.
  if (!target.isSubagent) {
    return { path: target.outputPath, content: compiledText };
  }
  if (platform === "claude-code") {
    return { path: `.claude/agents/${slug}.md`, content: compiledText };
  }

  // codex subagent: convert "---\nname/description\n---\nbody" into .codex/agents/<slug>.toml.
  const { data, content } = matter(compiledText);
  const name = typeof data.name === "string" ? data.name : slug;
  const description = typeof data.description === "string" ? data.description : "";
  const body = content.trim();
  const toml = [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlString(body)}`,
  ].join("\n") + "\n";
  return { path: `.codex/agents/${slug}.toml`, content: toml };
}

/** Hosts that read SOUL.md at the workspace/profile root — their root compile emits a placement file
 * (not just subagents), and they do NOT use the @PERSONA.md CLAUDE.md/AGENTS.md baseline injection. */
export function isSoulPlatform(platform: PlacementPlatform | undefined): boolean {
  return platform === "openclaw" || platform === "hermes";
}
