import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
You are Tester.
`;

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_UPDATE_CHECK: "1", ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe.skipIf(!built)("headless -p (V2-F3.A6)", () => {
  let home: string;
  let persona: string;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "pxs-headless-"));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    persona = join(dir, "personaxis.md");
    writeFileSync(persona, FIX);
  });

  it("prints a text reply and exits 0", { timeout: 90_000 }, () => {
    const r = run(["-p", "hi", "--persona", persona], { PERSONAXIS_HOME: home });
    expect(r.code).toBe(0);
    expect(r.out.trim().length).toBeGreaterThan(0);
  });

  it("emits valid JSON with --output-format json", { timeout: 90_000 }, () => {
    const r = run(["-p", "hi", "--output-format", "json", "--persona", persona], { PERSONAXIS_HOME: home });
    expect(r.code).toBe(0);
    const line = r.out.trim().split("\n").filter(Boolean).pop() ?? "";
    const obj = JSON.parse(line) as { type: string; reply: unknown };
    expect(obj.type).toBe("result");
    expect(typeof obj.reply).toBe("string");
  });

  it("rejects an unknown --output-format (exit 2)", { timeout: 90_000 }, () => {
    const r = run(["-p", "x", "--output-format", "yaml", "--persona", persona], { PERSONAXIS_HOME: home });
    expect(r.code).toBe(2);
  });

  /**
   * A slash command used to be forwarded to the MODEL as prose, so
   * `personaxis -p "/help"` returned an invented help text with exit 0. An agent
   * driving the CLI cannot tell that from the real thing, which makes it worse
   * than an error: the whole point of the external surface is that an agent can
   * TRUST what comes back.
   */
  it("never answers a slash command with the model (exit 2, names the real door)", { timeout: 90_000 }, () => {
    const r = run(["-p", "/status", "--persona", persona], { PERSONAXIS_HOME: home });
    expect(r.code).toBe(2);
    expect(r.out).toContain("personaxis status");
    expect(r.out.toLowerCase()).not.toContain("i am");
  });

  it("says WHY a session-only command has no external form", { timeout: 90_000 }, () => {
    const r = run(["-p", "/compact", "--persona", persona], { PERSONAXIS_HOME: home });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/live conversation/i);
  });

  it("rejects an unknown slash command instead of improvising", { timeout: 90_000 }, () => {
    const r = run(["-p", "/notacommand", "--persona", persona], { PERSONAXIS_HOME: home });
    expect(r.code).toBe(2);
    expect(r.out).toContain("not a command");
  });
});
