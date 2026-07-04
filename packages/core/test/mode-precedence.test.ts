/**
 * v1.0 improvement-mode precedence (SPEC.md §7.2): the inline
 * `improvement_policy.mode` is authoritative; a sibling policy.yaml may only
 * RESTRICT it (min-wins). Inline absent → policy.yaml governs; both absent →
 * locked. Ends the 0.x ambiguity of two files claiming the same knob.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMode } from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-mode-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function policy(mode?: string): void {
  writeFileSync(
    join(dir, ".personaxis", "policy.yaml"),
    mode ? `improvement_policy:\n  mode: ${mode}\n` : "applies_to:\n  persona_name: x\n",
  );
}

const fm = (mode?: string) =>
  (mode ? { improvement_policy: { mode } } : {}) as Record<string, unknown>;

describe("readMode min-wins precedence", () => {
  it("both absent → locked", () => {
    expect(readMode(fm(), personaPath)).toBe("locked");
  });

  it("inline only → inline governs", () => {
    expect(readMode(fm("autonomous"), personaPath)).toBe("autonomous");
  });

  it("policy.yaml only → policy governs (legacy 'auto' normalizes to autonomous)", () => {
    policy("suggesting");
    expect(readMode(fm(), personaPath)).toBe("suggesting");
    policy("auto");
    expect(readMode(fm(), personaPath)).toBe("autonomous");
  });

  it("policy.yaml can only RESTRICT the inline mode (min-wins)", () => {
    policy("locked");
    expect(readMode(fm("autonomous"), personaPath)).toBe("locked"); // restricted
    policy("autonomous");
    expect(readMode(fm("suggesting"), personaPath)).toBe("suggesting"); // cannot widen
    policy("suggesting");
    expect(readMode(fm("suggesting"), personaPath)).toBe("suggesting"); // equal
  });

  it("no personaPath → inline-only behavior (back-compat)", () => {
    expect(readMode(fm("suggesting"))).toBe("suggesting");
    expect(readMode(fm())).toBe("locked");
  });

  it("malformed policy.yaml never crashes mode resolution", () => {
    writeFileSync(join(dir, ".personaxis", "policy.yaml"), "improvement_policy: [broken\n  yaml: :::");
    expect(readMode(fm("suggesting"), personaPath)).toBe("suggesting");
  });
});
