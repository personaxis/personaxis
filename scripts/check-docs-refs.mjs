#!/usr/bin/env node
// The architecture docs cite code that exists.
//
//   pnpm check-docs-refs
//
// `docs/architecture/` is 24 documents that explain the engine to somebody running it on
// their own machine, and they explain it by pointing: "this happens in
// `packages/core/src/agent.ts`". A pointer is the most useful sentence in a design
// document and the first one to rot, because renaming a module does not touch the prose
// that named it.
//
// Measured on 2026-09-23: the 24 documents make 108 such citations and two were already
// dead. `core/src/skill-activation.ts` was announced as a "New module" in a document whose
// own header promises "so the two never drift", and what got built was called
// `tools/use-skill.ts` and `tools/find-tools.ts` instead. `session-writer.ts` never
// separated from `sessions.ts`. Neither is a big error on its own; both are the kind that
// accumulates silently, because nobody re-follows a path they wrote themselves.
//
// The rule is CODE ONLY: a citation ending in `.ts`, `.tsx` or `.mjs`. The first version of
// this measurement also counted `CLAUDE.md`, `state.json` and `AGENTS.md`, and reported 31
// failures. Those are files the product GENERATES in the user's folder, and they are
// supposed to be absent from this tree; counting them would have made the gate report
// noise, and a gate that reports noise gets switched off. A source file, by contrast, is
// either here or the sentence is wrong.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DOCS = join(ROOT, "docs", "architecture");

// A citation inside backticks that ends in a source extension. The path may be partial
// (`core/src/agent.ts` for `packages/core/src/agent.ts`), which is how the documents are
// written, so a partial one has to match the END of a real path.
const CITATION = /`([A-Za-z0-9_./@-]+\.(?:ts|tsx|mjs))`/g;

const SKIP = new Set(["node_modules", "dist", ".git", "runs", "results", "coverage"]);

/** Every source file in the tree, indexed by basename: `{ "agent.ts": ["packages/core/src/agent.ts"] }`. */
function sourceIndex(dir, into = new Map()) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceIndex(full, into);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) {
      const shown = relative(ROOT, full).split(sep).join("/");
      into.set(entry, [...(into.get(entry) ?? []), shown]);
    }
  }
  return into;
}

const index = sourceIndex(ROOT);
const dead = [];
let cited = 0;

for (const name of readdirSync(DOCS).sort()) {
  if (!/\.mdx?$/.test(name)) continue;
  const body = readFileSync(join(DOCS, name), "utf8");
  for (const cite of new Set([...body.matchAll(CITATION)].map((m) => m[1]))) {
    cited += 1;
    const paths = index.get(cite.split("/").pop()) ?? [];
    const found = cite.includes("/") ? paths.some((p) => p.endsWith(cite)) : paths.length > 0;
    if (!found) dead.push({ name, cite });
  }
}

if (dead.length > 0) {
  for (const { name, cite } of dead) {
    console.error(`docs/architecture/${name} cites \`${cite}\`, which is not in this tree.`);
  }
  console.error(
    `\ndocs refs: ${dead.length} of ${cited} citations point at code that is gone. Name what` +
      ` replaced it, or delete the sentence; do not leave the reader following a path to nothing.`,
  );
  process.exit(1);
}

console.log(`docs refs: ${cited} code citations across the architecture docs, all present.`);
