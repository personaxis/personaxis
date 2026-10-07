import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

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
  let model: FakeModel;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxs-headless-"));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    persona = join(dir, "personaxis.md");
    writeFileSync(persona, FIX);
    model = await startFakeModel();
  });
  afterAll(() => model.close());

  it("prints the model's reply and exits 0", { timeout: 90_000 }, async () => {
    const r = await runCli(CLI, ["-p", "hi", "--persona", persona], { env: { PERSONAXIS_HOME: home, ...modelEnv(model) } });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout.trim()).toBe("Hello.");
  });

  it("emits valid JSON with --output-format json", { timeout: 90_000 }, async () => {
    const r = await runCli(CLI, ["-p", "hi", "--output-format", "json", "--persona", persona], { env: { PERSONAXIS_HOME: home, ...modelEnv(model) } });
    expect(r.code, r.out).toBe(0);
    const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const obj = JSON.parse(line) as { type: string; reply: unknown };
    expect(obj.type).toBe("result");
    expect(obj.reply).toBe("Hello.");
  });

  it("with no model, fails with exit 2 and says how to configure one, instead of printing that as the answer", { timeout: 90_000 }, async () => {
    const r = await runCli(CLI, ["-p", "hi", "--persona", persona], {
      env: { PERSONAXIS_HOME: home, PERSONAXIS_ENDPOINT: "", PERSONAXIS_MODEL: "", PERSONAXIS_API_KEY: "" },
    });
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toMatch(/needs a model/);
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
