import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSubPersonas, discoverTree, colorForSlug } from "../src/repl/roster.js";
import { slugChainFromPath, slugAddressFromPath } from "../src/load.js";

const px = (...segs: string[]) => join(...segs, "personaxis.md");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-roster-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sub-persona discovery", () => {
  it("finds project-local sub-personas under .personaxis/personas, sorted", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    mkdirSync(join(dir, ".personaxis", "personas", "cmo"), { recursive: true });
    mkdirSync(join(dir, ".personaxis", "personas", "frontend"), { recursive: true });
    mkdirSync(join(dir, ".personaxis", "personas", "empty"), { recursive: true }); // no personaxis.md
    writeFileSync(root, "---\n---\n");
    writeFileSync(join(dir, ".personaxis", "personas", "cmo", "personaxis.md"), "---\n---\n");
    writeFileSync(join(dir, ".personaxis", "personas", "frontend", "personaxis.md"), "---\n---\n");

    const subs = discoverSubPersonas(root);
    expect(subs.map((s) => s.slug)).toEqual(["cmo", "frontend"]); // 'empty' skipped, sorted
  });

  it("returns [] when there is no personas/ dir", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    mkdirSync(join(dir, ".personaxis"), { recursive: true });
    writeFileSync(root, "---\n---\n");
    expect(discoverSubPersonas(root)).toEqual([]);
  });

  it("discovers the WHOLE nested tree (unlimited depth) with hierarchical addresses", () => {
    const root = join(dir, ".personaxis", "personaxis.md");
    const cmo = join(dir, ".personaxis", "personas", "cmo");
    const legal = join(cmo, "personas", "legal");
    mkdirSync(legal, { recursive: true });
    writeFileSync(root, "---\n---\n");
    writeFileSync(join(cmo, "personaxis.md"), "---\n---\n");
    writeFileSync(join(legal, "personaxis.md"), "---\n---\n");

    const tree = discoverTree(root);
    expect(tree.map((s) => s.address)).toEqual(["cmo", "cmo/legal"]);
    expect(tree.find((s) => s.address === "cmo/legal")?.depth).toBe(2);
  });
});

describe("slug chain / address (H2)", () => {
  it("extracts the full chain for nested paths", () => {
    expect(slugChainFromPath(px(".personaxis", "personas", "cmo"))).toEqual(["cmo"]);
    expect(slugChainFromPath(px(".personaxis", "personas", "cmo", "personas", "legal"))).toEqual(["cmo", "legal"]);
    expect(slugChainFromPath(px("anything"))).toEqual([]); // root
    expect(slugAddressFromPath(px(".personaxis", "personas", "cmo", "personas", "legal"))).toBe("cmo/legal");
  });
});

describe("per-persona reply colours (G8)", () => {
  it("is deterministic per slug (stable across sessions)", () => {
    expect(colorForSlug("cmo", new Set())).toBe(colorForSlug("cmo", new Set()));
  });

  it("assigns distinct colours within a roster (no repeats)", () => {
    const taken = new Set<number>();
    const slugs = ["cmo", "frontend", "legal", "growth", "ops", "design"];
    const colors = slugs.map((s) => colorForSlug(s, taken));
    expect(new Set(colors).size).toBe(slugs.length);
  });
});
