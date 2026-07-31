import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const built = existsSync(CLI);

const FIX = `---
apiVersion: personaxis.com/v1
kind: AgentPersona
spec_version: "1.1.0"
metadata: { name: t, version: 1.0.0 }
identity: { canonical_id: tester, display_name: Tester }
---
Tester body.
`;

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_ANIM: "1", PERSONAXIS_NO_UPDATE_CHECK: "1" },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe.skipIf(!built)("personaxis sign/verify (V2-F8 wedge)", () => {
  let dir: string;
  let persona: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-sign-"));
    persona = join(dir, "personaxis.md");
    writeFileSync(persona, FIX);
  });

  it("signs a persona, verifies it, then detects tampering", { timeout: 90_000 }, () => {
    const signed = run(["sign", "--persona", persona]);
    expect(signed.code).toBe(0);
    expect(existsSync(join(dir, "personaxis.sig.json"))).toBe(true);

    const ok = run(["verify", "--persona", persona]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("VERIFIED");

    appendFileSync(persona, "\n# tampered\n");
    const bad = run(["verify", "--persona", persona]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("TAMPERED");
  });

  it("verify errors (exit 2) when no signature exists", { timeout: 90_000 }, () => {
    const r = run(["verify", "--persona", persona]);
    expect(r.code).toBe(2);
  });
});
