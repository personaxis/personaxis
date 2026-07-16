/**
 * Custom slash commands (V2-F3.C12), the Claude Code convention: a persona can
 * ship reusable prompt templates as `.personaxis/commands/<name>.md`. Each file
 * is optional YAML frontmatter (`description`, `argument-hint`) + a markdown body
 * that becomes the prompt sent to the persona when the user types `/<name> args`.
 *
 * Argument substitution mirrors Claude Code: `$ARGUMENTS` = the whole arg string,
 * `$1`..`$9` = positional words. A body with no placeholder gets the args appended.
 * Commands are discovered fresh each turn (so editing a file takes effect live),
 * from the persona's own folder and, for the root, the project `.personaxis/`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import matter from "gray-matter";

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  path: string;
}

function commandsDir(personaPath: string): string {
  return join(dirname(personaPath), "commands");
}

/** Load one command file, or undefined if malformed/missing. */
function loadOne(file: string): CustomCommand | undefined {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = matter(raw);
    const data = parsed.data as { description?: string; "argument-hint"?: string; argumentHint?: string };
    const name = basename(file, ".md").toLowerCase();
    if (!name) return undefined;
    return {
      name,
      description: (data.description ?? "custom command").trim(),
      argumentHint: (data["argument-hint"] ?? data.argumentHint)?.trim(),
      body: parsed.content.trim(),
      path: file,
    };
  } catch {
    return undefined;
  }
}

/** Discover this persona's custom commands (its own folder wins over the project root). */
export function loadCustomCommands(personaPath: string): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  // Project root first (lower priority), then the persona's own folder (overrides).
  const dirs = [join(process.cwd(), ".personaxis", "commands"), commandsDir(personaPath)];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of entries) {
      const cmd = loadOne(join(dir, f));
      if (cmd) byName.set(cmd.name, cmd);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a single custom command by name (fresh read), or undefined. */
export function findCustomCommand(personaPath: string, name: string): CustomCommand | undefined {
  return loadCustomCommands(personaPath).find((c) => c.name === name.toLowerCase());
}

/**
 * Expand a command body with the invocation args. `$ARGUMENTS` → the full string,
 * `$1`..`$9` → positional words (empty when absent). If the body references no
 * placeholder and args were given, append them on a new line.
 */
export function expandCommand(cmd: CustomCommand, args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const hasPlaceholder = /\$ARGUMENTS\b|\$[1-9]\b/.test(cmd.body);
  let out = cmd.body.replace(/\$ARGUMENTS\b/g, args.trim());
  out = out.replace(/\$([1-9])\b/g, (_m, d: string) => words[Number(d) - 1] ?? "");
  if (!hasPlaceholder && args.trim()) out = `${out}\n\n${args.trim()}`;
  return out.trim();
}
