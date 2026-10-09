/**
 * V3.3 embrace-extend: SOUL.md / SoulSpec import into Genesis. Since 2026-10-07 the package is read whole
 * and handed to the model as one source it cites; no field is mapped from the file's layout.
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
  it("keeps the whole SOUL.md as one source, nothing mapped by layout", () => {
    const m = importSoulMd(join(dir, "SOUL.md"));
    expect(m.format).toBe("soul-md");
    expect(m.text).toContain("You are Nyx");
    expect(m.text).toContain("Never fabricate a citation");
    expect(m.text).toContain("Dry humor");
  });

  it("adds IDENTITY.md and soul.json under their own names when they sit beside it", () => {
    writeFileSync(join(dir, "IDENTITY.md"), "Name: FromIdentity\n", "utf-8");
    writeFileSync(join(dir, "soul.json"), "{not json", "utf-8");
    const m = importSoulMd(join(dir, "SOUL.md"));
    expect(m.text).toContain("IDENTITY.md:\nName: FromIdentity");
    expect(m.text).toContain("soul.json:\n{not json");
  });

  it("isSoulImport recognizes the file and the package directory", () => {
    expect(isSoulImport(join(dir, "SOUL.md"))).toBe(true);
    expect(isSoulImport(dir)).toBe(true);
    expect(isSoulImport(join(dir, "AGENTS.md"))).toBe(false);
  });
});
