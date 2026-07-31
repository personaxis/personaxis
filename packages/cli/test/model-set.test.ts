import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setModelSetting } from "../src/config.js";

let dir: string;
let home: string;
let prevCwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-modelset-"));
  home = mkdtempSync(join(tmpdir(), "pxs-modelhome-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  prevCwd = process.cwd();
  prevHome = process.env.PERSONAXIS_HOME;
  process.chdir(dir);
  process.env.PERSONAXIS_HOME = home;
});
afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

describe("setModelSetting (V5.P1.8: per-persona + per-project scopes)", () => {
  it("writes the shared local section by default (project scope)", () => {
    setModelSetting("model", "test-model", false);
    const cfg = readJson(join(dir, ".personaxis", "config.json"));
    expect((cfg.local as Record<string, unknown>).model).toBe("test-model");
  });

  it("writes a per-persona override under personas.<slug> (project scope)", () => {
    setModelSetting("model", "sub-model", false, "cmo");
    const cfg = readJson(join(dir, ".personaxis", "config.json"));
    const personas = cfg.personas as Record<string, Record<string, unknown>>;
    expect(personas.cmo.model).toBe("sub-model");
    // The shared section is untouched.
    expect((cfg.local as Record<string, unknown> | undefined)?.model).toBeUndefined();
  });

  it("merges fields per persona instead of clobbering them", () => {
    setModelSetting("model", "m1", false, "cmo");
    setModelSetting("endpoint", "http://x", false, "cmo");
    const cfg = readJson(join(dir, ".personaxis", "config.json"));
    const cmo = (cfg.personas as Record<string, Record<string, unknown>>).cmo;
    expect(cmo.model).toBe("m1");
    expect(cmo.endpoint).toBe("http://x");
  });

  it("rejects unknown fields", () => {
    expect(() => setModelSetting("nope", "x", false)).toThrow(/unknown model setting/);
  });
});
