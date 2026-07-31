/**
 * V9 / G.1: the scope tree is a uniform, navigable hierarchy over REAL persona data. This pins
 * the shape (persona → layers → layer → field), that attributes reflect the persona, that a
 * protected coordinate is read-only, and that sub-personas nest recursively as persona nodes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEnvelopes, type PersonaFrontmatter } from "@personaxis/core";
import { writeStarterPersona } from "../src/starter.js";
import { loadPersonaFile } from "../src/load.js";
import { personaTree, type ScopeNode } from "../src/center/tree.js";
import { CANONICAL_LAYERS } from "../src/center/authority.js";

let dir: string;
let mainPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-center-"));
  mainPath = writeStarterPersona(dir, "Vega");
  writeStarterPersona(dir, "Legal", "legal"); // a sub-persona under .personaxis/personas/legal
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const child = (n: ScopeNode, id: string): ScopeNode | undefined => n.children().find((c) => c.id === id);

describe("scope tree (G.1)", () => {
  it("builds a persona node with identity attributes and a live status", () => {
    const p = personaTree(mainPath, "");
    expect(p.level).toBe("persona");
    expect(p.title).toContain("Vega");
    expect(p.title).toContain("(main)");
    expect(p.path).toEqual(["machine", "main"]);
    expect(p.attributes.find((a) => a.key === "name")?.value).toBe("Vega");
    expect(p.live).toBeDefined();
    expect(p.live!.summary).toBe("idle"); // nothing running against the fixture
  });

  it("nests sub-personas as persona nodes (recursive, same shape)", () => {
    const p = personaTree(mainPath, "");
    const sub = p.children().find((c) => c.level === "persona");
    expect(sub, "the sub-persona should appear as a persona child").toBeDefined();
    expect(sub!.id).toBe("legal");
    expect(sub!.title).toContain("@legal");
  });

  it("drills persona → layers → layer → field over real envelope coordinates", () => {
    const layers = child(personaTree(mainPath, ""), "layers");
    expect(layers, "a persona with envelopes has a Layers node").toBeDefined();
    const layerChildren = layers!.children();
    expect(layerChildren.length, "there is at least one layer with coordinates").toBeGreaterThan(0);

    // Find a layer that has fields, then a field, and check its attributes.
    const layerWithFields = layerChildren.find((l) => l.children().length > 0)!;
    expect(layerWithFields.level).toBe("layer");
    const field = layerWithFields.children()[0];
    expect(field.level).toBe("field");
    expect(field.attributes.map((a) => a.key)).toContain("current");
    expect(field.attributes.map((a) => a.key)).toContain("range");
    // The breadcrumb path is the real address the external gate will use.
    expect(field.path.slice(0, 3)).toEqual(["machine", "main", "layers"]);
  });

  it("exposes a Permissions facet with per-layer authority; identity/character are blocked (G.3)", () => {
    const perms = child(personaTree(mainPath, ""), "permissions");
    expect(perms, "the persona has a Permissions facet").toBeDefined();
    const layers = perms!.children();
    expect(layers.map((l) => l.id)).toEqual([...CANONICAL_LAYERS]);
    // The safety floor: identity and character can never be edited, whatever the mode.
    for (const id of ["identity", "character"]) {
      const layer = layers.find((l) => l.id === id)!;
      expect(layer.actions.find((a) => a.kind === "edit")!.effect, `${id} must be blocked`).toBe("blocked");
    }
    // Every layer declares an effect in the allowed set.
    for (const l of layers) {
      expect(["direct", "proposal", "blocked"]).toContain(l.actions.find((a) => a.kind === "edit")!.effect);
    }
  });

  it("classifies field editability by the persona's protected coordinates (the mechanism)", () => {
    const fm = loadPersonaFile(mainPath).data as PersonaFrontmatter;
    const { protectedFields = [] } = extractEnvelopes(fm);
    const layers = child(personaTree(mainPath, ""), "layers")!;
    const allFields = layers.children().flatMap((l) => l.children());
    expect(allFields.length).toBeGreaterThan(0);
    for (const f of allFields) {
      const edit = f.actions.find((a) => a.kind === "edit")!;
      // A field is read-only exactly when the spec marks its coordinate protected.
      expect(edit.effect === "blocked", `${f.id} blocked?`).toBe(protectedFields.includes(f.id));
      if (edit.effect === "blocked") expect(edit.authority).toMatch(/protected/);
    }
    // At least one coordinate is editable in principle (authority resolved later in G.3).
    expect(allFields.some((f) => f.actions.some((a) => a.effect === "direct"))).toBe(true);
  });
});
