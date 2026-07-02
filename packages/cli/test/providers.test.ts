import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProvider } from "../src/providers/index.js";

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["PERSONAXIS_HOME", "PERSONAXIS_ENDPOINT", "PERSONAXIS_MODEL", "PERSONAXIS_API_KEY"];

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), "pxs-prov-"));
  process.env.PERSONAXIS_HOME = home;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("resolveProvider — smart default (no footgun)", () => {
  it("defaults to `agent` when NO model is configured", () => {
    expect(resolveProvider().name).toBe("agent");
  });

  it("defaults to `local` when a model IS configured (global config), without needing `provider`", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ local: { endpoint: "https://x", model: "m" } }));
    // The footgun was: model set but compile still used the `agent` handoff because provider was unset.
    expect(resolveProvider().name).toBe("local");
  });

  it("an explicit config `provider` still wins over the smart default", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "byok", local: { endpoint: "https://x", model: "m" } }));
    expect(resolveProvider().name).toBe("byok");
  });

  it("an explicit override wins over everything", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ local: { endpoint: "https://x", model: "m" } }));
    expect(resolveProvider("agent").name).toBe("agent");
  });
});
