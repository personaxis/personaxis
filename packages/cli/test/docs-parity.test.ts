/**
 * V6.7: the docs can never fall behind the CLI again. Every subcommand
 * registered in src/index.ts must have a page under docs/commands/ (a few share
 * a combined page, mapped below). This is the CI gate that keeps every command
 * documented: a new subcommand without a page fails the build.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const docsDir = join(repoRoot, "docs", "commands");
const indexTs = join(here, "..", "src", "index.ts");

/** Commands documented on a shared/combined page. */
const PAGE_ALIAS: Record<string, string> = {
  push: "push-pull",
  pull: "push-pull",
};

describe("docs/commands parity (V6.7)", () => {
  const src = readFileSync(indexTs, "utf-8");
  const commands = [...src.matchAll(/addCommand\((\w+)Command/g)].map((m) => m[1]);

  it("finds the registered command list", () => {
    expect(commands.length).toBeGreaterThan(30);
  });

  // The INDEX (docs/commands/README.md) must list every command, not just have a per-command page.
  // Without this the index silently drifts, as it did (console/mcp/ps/card/goal/review/credential
  // all had pages but no index row). A command is listed as `cmd` or `/cmd`, backtick-wrapped.
  it("lists every command in the docs/commands index (README)", () => {
    const index = readFileSync(join(docsDir, "README.md"), "utf-8");
    const missing = [...new Set(commands)].filter((c) => !new RegExp("`/?" + c + "[` ]").test(index));
    expect(missing, `commands missing from docs/commands/README.md: ${missing.join(", ")}`).toEqual([]);
  });

  for (const cmd of [...new Set(commands)]) {
    it(`docs/commands/${PAGE_ALIAS[cmd] ?? cmd}.md exists for \`personaxis ${cmd}\``, () => {
      const page = join(docsDir, `${PAGE_ALIAS[cmd] ?? cmd}.md`);
      expect(existsSync(page), `missing docs page for "${cmd}" (${page})`).toBe(true);
    });
  }

  // The reverse direction: no page may linger for a command that no longer exists. Without
  // this, a removed/renamed command leaves a stale page the forward check never notices, which
  // is exactly how docs rot. Concept pages (not a subcommand) are declared, not guessed.
  const CONCEPT_PAGES = new Set([
    "README", // the index
    "parity", // the TUI ↔ external parity table
    "repl", // the no-subcommand REPL
    "sessions", // session persistence + /resume (a REPL concept, not a subcommand)
  ]);

  it("has no stale page (every page maps to a real command or a declared concept)", () => {
    const expected = new Set<string>(CONCEPT_PAGES);
    for (const c of commands) expected.add(PAGE_ALIAS[c] ?? c);
    const pages = readdirSync(docsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
    const orphans = pages.filter((p) => !expected.has(p));
    expect(orphans, `stale docs/commands pages (no command, no declared concept): ${orphans.join(", ")}`).toEqual([]);
  });
});
