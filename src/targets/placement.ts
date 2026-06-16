import matter from "gray-matter";
import type { CompileTargetInfo } from "../compile-instructions.js";
import { tomlString } from "./codex.js";

export const PLACEMENT_PLATFORMS = ["claude-code", "codex"] as const;
export type PlacementPlatform = (typeof PLACEMENT_PLATFORMS)[number];

export interface PlacementResult {
  /** Relative path the placed document should be written to. */
  path: string;
  content: string;
}

/**
 * B.6: takes the canonical compiled document produced by `runCompile`
 * (Markdown, with a `name`/`description` YAML frontmatter for subagents) and
 * adapts it to a platform's subagent convention.
 *
 * Root-mode `PERSONA.md` is platform-agnostic (both Claude Code's CLAUDE.md
 * and Codex's AGENTS.md reference the same file), so this only changes
 * anything for subagent compiles.
 */
export function placeCompiledDocument(
  compiledText: string,
  target: CompileTargetInfo,
  platform: PlacementPlatform,
): PlacementResult {
  if (!target.isSubagent || platform === "claude-code") {
    return { path: target.outputPath, content: compiledText };
  }

  // codex: convert the canonical "---\nname/description\n---\nbody" document
  // into the .codex/agents/<slug>.toml convention.
  const slug = target.slug ?? "agent";
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
