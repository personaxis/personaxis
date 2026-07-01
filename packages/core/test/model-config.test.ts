import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel, slugFromPersonaPath } from "../src/index.js";

let home: string;
let project: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["PERSONAXIS_HOME", "PERSONAXIS_ENDPOINT", "PERSONAXIS_MODEL", "PERSONAXIS_API_KEY", "COHERE_API_KEY"];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), "pxs-home-"));
  project = mkdtempSync(join(tmpdir(), "pxs-proj-"));
  process.env.PERSONAXIS_HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function writeGlobal(cfg: unknown): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
}
function writeProject(cfg: unknown): void {
  mkdirSync(join(project, ".personaxis"), { recursive: true });
  writeFileSync(join(project, ".personaxis", "config.json"), JSON.stringify(cfg));
}

describe("resolveModel — layered precedence (env > frontmatter > persona > project > global)", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveModel({ cwd: project })).toBeUndefined();
  });

  it("uses the global default", () => {
    writeGlobal({ local: { endpoint: "https://g", model: "g-model" } });
    expect(resolveModel({ cwd: project })).toEqual({ endpoint: "https://g", model: "g-model" });
  });

  it("project default overrides the global default", () => {
    writeGlobal({ local: { endpoint: "https://g", model: "g-model" } });
    writeProject({ local: { endpoint: "https://p", model: "p-model" } });
    expect(resolveModel({ cwd: project })).toMatchObject({ endpoint: "https://p", model: "p-model" });
  });

  it("a per-persona override (personas[slug]) beats the project default", () => {
    writeProject({ local: { endpoint: "https://p", model: "p-model" }, personas: { cmo: { model: "cmo-model" } } });
    const personaPath = join(project, ".personaxis", "personas", "cmo", "personaxis.md");
    expect(resolveModel({ cwd: project, personaPath })).toMatchObject({ endpoint: "https://p", model: "cmo-model" });
  });

  it("frontmatter.runtime overrides config, and env overrides everything", () => {
    writeProject({ local: { endpoint: "https://p", model: "p-model" } });
    const fm = { runtime: { model: "fm-model" } };
    expect(resolveModel({ cwd: project, frontmatter: fm })).toMatchObject({ model: "fm-model" });
    process.env.PERSONAXIS_ENDPOINT = "https://env";
    process.env.PERSONAXIS_MODEL = "env-model";
    expect(resolveModel({ cwd: project, frontmatter: fm })).toMatchObject({ endpoint: "https://env", model: "env-model" });
  });

  it("needs BOTH endpoint and model to resolve", () => {
    writeGlobal({ local: { endpoint: "https://g" } }); // no model
    expect(resolveModel({ cwd: project })).toBeUndefined();
  });
});

describe("resolveModel — API key resolution (never required in a file)", () => {
  it("reads the key from the env var named by apiKeyEnv (preferred)", () => {
    writeProject({ local: { endpoint: "https://p", model: "m", apiKeyEnv: "COHERE_API_KEY" } });
    process.env.COHERE_API_KEY = "secret-from-env";
    expect(resolveModel({ cwd: project })?.apiKey).toBe("secret-from-env");
  });

  it("falls back to PERSONAXIS_API_KEY, then to an inline key", () => {
    writeProject({ local: { endpoint: "https://p", model: "m", apiKey: "inline-dev-key" } });
    expect(resolveModel({ cwd: project })?.apiKey).toBe("inline-dev-key");
    process.env.PERSONAXIS_API_KEY = "env-key";
    expect(resolveModel({ cwd: project })?.apiKey).toBe("env-key"); // env wins over inline
  });
});

describe("slugFromPersonaPath", () => {
  it("extracts the last persona slug from a nested path", () => {
    expect(slugFromPersonaPath("/x/.personaxis/personas/cmo/personaxis.md")).toBe("cmo");
    expect(slugFromPersonaPath("/x/.personaxis/personas/cmo/personas/legal/personaxis.md")).toBe("legal");
    expect(slugFromPersonaPath("/x/.personaxis/personaxis.md")).toBeUndefined();
    expect(slugFromPersonaPath(undefined)).toBeUndefined();
  });
});
