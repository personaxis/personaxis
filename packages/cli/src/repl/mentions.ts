/**
 * `@path` file mentions (V2-F3.A5). Expand any `@path` token in a user message
 * into inlined, fenced file contents so the persona can see a file the user
 * pointed at. Only tokens that resolve to an existing readable file are
 * expanded; `@slug` persona mentions and non-file tokens are left untouched
 * (parseMentions only routes LEADING known sub-persona addresses, so a
 * `@src/foo.ts` path never collides with routing).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MENTION = /@([^\s@]+)/g;

export function expandFileMentions(input: string, cwd = process.cwd(), maxBytes = 100_000): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(MENTION)) {
    const ref = match[1].replace(/[.,;:)]+$/, ""); // trim trailing punctuation
    if (seen.has(ref)) continue;
    const p = resolve(cwd, ref);
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        let content = readFileSync(p, "utf-8");
        if (content.length > maxBytes) content = content.slice(0, maxBytes) + "\n... (truncated)";
        blocks.push(`<file path="${ref}">\n${content}\n</file>`);
        seen.add(ref);
      }
    } catch {
      /* not readable, leave the mention as plain text */
    }
  }
  return blocks.length ? `${input}\n\n${blocks.join("\n\n")}` : input;
}
