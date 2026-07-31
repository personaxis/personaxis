import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAwarenessBlock } from "../src/repl/awareness.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-aware-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("buildAwarenessBlock (F2 + V5.P0.1 runtime context)", () => {
  it("marks the main persona and lists its sub-tree", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    const cmo = join(dir, ".personaxis", "personas", "cmo");
    const legal = join(cmo, "personas", "legal");
    mkdirSync(legal, { recursive: true });
    writeFileSync(root, "---\n---\n");
    writeFileSync(join(cmo, "personaxis.md"), "---\n---\n");
    writeFileSync(join(legal, "personaxis.md"), "---\n---\n");

    const block = buildAwarenessBlock(root);
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

    const block = buildAwarenessBlock(join(cmo, "personaxis.md"));
    expect(block).toContain("SUB-persona");
    expect(block).toContain("`@cmo`");
    expect(block).toContain("@legal"); // cmo's own child, addressed relative to cmo
    expect(block).not.toContain("@cmo/legal"); // not the root's perspective
  });

  it("includes a resource inventory and handles a persona with no subs", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    mkdirSync(join(dir, ".personaxis", "references"), { recursive: true });
    writeFileSync(join(dir, ".personaxis", "references", "spec.md"), "x");
    writeFileSync(root, "---\n---\n");

    const block = buildAwarenessBlock(root);
    expect(block).toContain("Your resource space");
    expect(block).toContain("references/");
    expect(block).toContain("(none, you have no sub-personas)");
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
      posture: "workspace-write",
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
    expect(block).toContain("Sandbox posture: workspace-write");
    expect(block).toContain("Model answering this session: command-a-03-2025");
    expect(block).toContain("Self-improvement mode: suggesting");
    expect(block).toContain("queue for human review");
    // Never part of the persona artifacts: the block says so.
    expect(block).toContain("not part of your persona files");
  });
});
