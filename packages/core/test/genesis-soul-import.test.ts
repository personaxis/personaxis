/**
 * V3.3 embrace-extend: SOUL.md / SoulSpec import into Genesis. The ecosystem's
 * soft persona file becomes deterministic evidence (name, identity, boundaries)
 * plus extractor prose; numbers are never invented from the file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSoulMd, isSoulImport } from "../src/genesis/imports.js";

const SOUL = `# SOUL

## Core Identity

You are Nyx, a nocturnal research assistant. Curious, precise, allergic to hype.

More context here.

## Personality

Dry humor. Prefers primary sources.

## Boundaries

- Never fabricate a citation
- Never claim to be human
- No medical advice

## Workflows

Whatever the tools say.
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-soul-"));
  writeFileSync(join(dir, "SOUL.md"), SOUL, "utf-8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("importSoulMd", () => {
  it("maps identity + boundaries deterministically and keeps all prose", () => {
    const m = importSoulMd(join(dir, "SOUL.md"));
    expect(m.format).toBe("soul-md");
    expect(m.seed.selfConcept).toContain("Nyx");
    expect(m.seed.prohibitedBehaviors).toEqual([
      "Never fabricate a citation",
      "Never claim to be human",
      "No medical advice",
    ]);
    expect(m.evidence.some((e) => e.mappedFields.some((f) => f.path === "self_regulation.prohibited_behaviors"))).toBe(true);
    expect(m.evidence.every((e) => e.kind === "imported-field")).toBe(true);
    expect(m.prose).toContain("Dry humor");
  });

  it("takes the name from soul.json over IDENTITY.md over the heading", () => {
    writeFileSync(join(dir, "IDENTITY.md"), "Name: FromIdentity\nEmoji: 🌙\n", "utf-8");
    let m = importSoulMd(join(dir, "SOUL.md"));
    expect(m.seed.displayName).toBe("FromIdentity");
    expect(m.prose).toContain("IDENTITY.md");

    writeFileSync(join(dir, "soul.json"), JSON.stringify({ name: "FromMeta", description: "the meta description" }), "utf-8");
    m = importSoulMd(join(dir, "SOUL.md"));
    expect(m.seed.displayName).toBe("FromMeta");
    expect(m.seed.description).toBe("the meta description");
  });

  it("isSoulImport recognizes the file and the package directory", () => {
    expect(isSoulImport(join(dir, "SOUL.md"))).toBe(true);
    expect(isSoulImport(dir)).toBe(true);
    expect(isSoulImport(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("a malformed soul.json never blocks the import", () => {
    writeFileSync(join(dir, "soul.json"), "{not json", "utf-8");
    const m = importSoulMd(join(dir, "SOUL.md"));
    expect(m.format).toBe("soul-md");
    expect(m.seed.selfConcept).toContain("Nyx");
  });
});
