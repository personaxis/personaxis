import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAwarenessBlock } from "../src/repl/awareness.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-aware-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildAwarenessBlock (F2 + V5.P0.1 runtime context, E79 work map)", () => {
  it("marks the main persona and lists its sub-tree", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    const cmo = join(dir, ".personaxis", "personas", "cmo");
    const legal = join(cmo, "personas", "legal");
    mkdirSync(legal, { recursive: true });
    writeFileSync(root, "---\n---\n");
    writeFileSync(join(cmo, "personaxis.md"), "---\n---\n");
    writeFileSync(join(legal, "personaxis.md"), "---\n---\n");

    const block = buildAwarenessBlock(root, { cwd: dir });
    expect(block).toContain("MAIN persona");
    expect(block).toContain("@cmo");
    expect(block).toContain("@cmo/legal");
  });

  it("marks a sub-persona with its address and lists ITS own subs", () => {
    const cmo = join(dir, ".personaxis", "personas", "cmo");
    const legal = join(cmo, "personas", "legal");
    mkdirSync(legal, { recursive: true });
    writeFileSync(join(cmo, "personaxis.md"), "---\n---\n");
    writeFileSync(join(legal, "personaxis.md"), "---\n---\n");

    const block = buildAwarenessBlock(join(cmo, "personaxis.md"), { cwd: dir });
    expect(block).toContain("SUB-persona");
    expect(block).toContain("`@cmo`");
    expect(block).toContain("@legal"); // cmo's own child, addressed relative to cmo
    expect(block).not.toContain("@cmo/legal"); // not the root's perspective
  });

  it("says what each resource is for, and handles a persona with nothing yet", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    mkdirSync(join(dir, ".personaxis", "references"), { recursive: true });
    writeFileSync(join(dir, ".personaxis", "references", "spec.md"), "# The field guide\n");
    writeFileSync(root, "---\n---\n");

    const block = buildAwarenessBlock(root, { cwd: dir });
    expect(block).toContain("What you have, and when to use it");
    expect(block).toContain("- .personaxis/references/spec.md: The field guide");
    expect(block).toContain("## Where things go");
    expect(block).not.toContain("Sub-personas you can hand work to");

    const empty = join(dir, "empty", ".personaxis", "personaxis.md");
    mkdirSync(join(dir, "empty", ".personaxis"), { recursive: true });
    writeFileSync(empty, "---\n---\n");
    expect(buildAwarenessBlock(empty, { cwd: join(dir, "empty") })).toContain("You have no skills, services, references, examples, assets or sub-personas yet.");
  });

  it("names the defining files, spec_version and session facts (runtime context)", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    mkdirSync(join(dir, ".personaxis"), { recursive: true });
    writeFileSync(root, "---\n---\n");

    const block = buildAwarenessBlock(root, {
      frontmatter: {
        spec_version: "1.1.0",
        apiVersion: "personaxis.com/v1",
        identity: { display_name: "Clio" },
        improvement_policy: { mode: "suggesting" },
      },
      model: "command-a-03-2025",
      cwd: dir,
    });
    expect(block).toContain("Runtime context");
    expect(block).toContain('"Clio"');
    expect(block).toContain("spec_version 1.1.0");
    expect(block).toContain("personaxis.com/v1");
    expect(block).toContain(".personaxis/personaxis.md");
    expect(block).toContain("PERSONA.md");
    expect(block).toContain("state.json");
    expect(block).toContain("Model answering this session: command-a-03-2025");
    expect(block).toContain("Self-improvement mode: suggesting");
    expect(block).toContain("queue for human review");
    // Never part of the persona artifacts: the block says so.
    expect(block).toContain("not part of your persona files");
  });

  it("leaves the posture and the session list out, so the cached prefix does not move (E79)", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    mkdirSync(join(dir, ".personaxis"), { recursive: true });
    writeFileSync(root, "---\n---\n");
    const before = buildAwarenessBlock(root, { cwd: dir });

    // The first turn of a session writes its transcript; the old listing named it.
    mkdirSync(join(dir, ".personaxis", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".personaxis", "sessions", "2026-09-14-first.jsonl"), "{}\n");

    const after = buildAwarenessBlock(root, { cwd: dir });
    expect(after).toBe(before);
    expect(after).not.toMatch(/Sandbox posture/);
  });
});

describe("every surface that gives a persona a working turn gives it the map (E79)", () => {
  // A shape check, and the only one available: `acp-bin.ts` starts serving over stdio the moment
  // it is imported, so no test can load it. Before E79 the ACP turn got no runtime context at all,
  // and the same persona knew less about itself in an editor than in the TUI.
  it.each([
    ["the TUI turn", "repl/turn.ts"],
    ["an editor over ACP", "acp-bin.ts"],
    ["a service step", "commands/service.ts"],
    ["the headless turn", "repl/headless.ts"],
  ])("%s passes the runtime context", (_surface, file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    expect(source).toMatch(/awareness:\s*buildAwarenessBlock\(/);
  });
});
