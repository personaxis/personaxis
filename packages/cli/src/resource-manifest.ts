import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const DEFAULT_LIMIT = 20;

export interface ResourceManifestOptions {
  /** Max entries listed per folder before collapsing to "... and N more". Default 20. */
  limit?: number;
}

interface FolderSection {
  folder: string;
  description: string;
  sortNewestFirst?: boolean;
}

const FOLDER_SECTIONS: FolderSection[] = [
  { folder: "memory", description: "date-stamped episodic sessions, newest first", sortNewestFirst: true },
  { folder: "references", description: "background material this persona draws on" },
  { folder: "examples", description: "worked outputs for voice/format calibration" },
  { folder: "skills", description: "Anthropic-compatible sub-skills" },
  { folder: "assets", description: "supporting raw files" },
];

function listTopLevelEntries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}

function formatFolderLine(section: FolderSection, entries: string[], limit: number): string {
  const { folder, description } = section;

  if (entries.length === 0) {
    return `- \`./${folder}/\` - ${description} (none).`;
  }

  const ordered = section.sortNewestFirst ? [...entries].sort().reverse() : entries;
  const shown = ordered.slice(0, limit);
  const remainder = ordered.length - shown.length;
  const list = shown.map((entry) => `\`${entry}\``).join(", ");
  const suffix = remainder > 0 ? `, ... and ${remainder} more` : "";
  const noun = ordered.length === 1 ? "entry" : "entries";

  return `- \`./${folder}/\` - ${description}: ${list}${suffix} (${ordered.length} ${noun}).`;
}

/**
 * Builds a capped, human/LLM-readable index of a persona's supporting
 * folders (`memory.md`, `memory/`, `references/`, `examples/`, `skills/`,
 * `assets/`) under `baseDir` (`.personaxis/` or `.personaxis/personas/<slug>/`).
 *
 * Never reads file contents - only names and counts. Used by `compile` and
 * `decompile` to give the provider a sense of what supporting material
 * exists without inlining it into the prompt.
 */
export function buildResourceManifest(baseDir: string, opts: ResourceManifestOptions = {}): string {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const lines: string[] = [];

  const memoryFile = join(baseDir, "memory.md");
  if (existsSync(memoryFile) && statSync(memoryFile).isFile()) {
    lines.push("- `./memory.md` - curated long-term semantic memory (read on demand).");
  }

  for (const section of FOLDER_SECTIONS) {
    const dir = join(baseDir, section.folder);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;

    const entries = listTopLevelEntries(dir);
    lines.push(formatFolderLine(section, entries, limit));
  }

  return lines.join("\n");
}
