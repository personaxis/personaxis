import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel, isLocalEndpoint } from "../src/model-config.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pxs-fallback-home-"));
  cwd = mkdtempSync(join(tmpdir(), "pxs-fallback-cwd-"));
  prevHome = process.env.PERSONAXIS_HOME;
  process.env.PERSONAXIS_HOME = home;
  delete process.env.PERSONAXIS_API_KEY;
  delete process.env.NOPE_KEY_ENV;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeGlobal(cfg: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg, null, 2));
}

describe("resolveModel fallback (V5.FIX.2: a broken default can no longer strand the session)", () => {
  it("falls back from a keyless remote default profile to the first USABLE profile", () => {
    writeGlobal({
      defaultProfile: "broken",
      profiles: {
        broken: { endpoint: "https://api.example.com/v1", model: "x", apiKeyEnv: "NOPE_KEY_ENV" },
        good: { endpoint: "https://api.cohere.ai/compatibility/v1", model: "command-a", apiKey: "k-123" },
      },
    });
    const r = resolveModel({ cwd });
    expect(r?.model).toBe("command-a");
    expect(r?.apiKey).toBe("k-123");
    expect(r?.profile).toBe("good");
    expect(r?.fallback).toBe(true);
  });

  it("a LOCAL endpoint is usable with no key (Ollama/LM Studio class)", () => {
    writeGlobal({
      defaultProfile: "ollama",
      profiles: { ollama: { endpoint: "http://localhost:11434/v1", model: "llama3.1" } },
    });
    const r = resolveModel({ cwd });
    expect(r?.model).toBe("llama3.1");
    expect(r?.apiKey).toBeUndefined();
    expect(r?.fallback).toBeUndefined();
  });

  it("with NO default at all, the first usable profile is picked", () => {
    writeGlobal({
      profiles: {
        remoteNoKey: { endpoint: "https://api.example.com/v1", model: "x", apiKeyEnv: "NOPE_KEY_ENV" },
        local: { endpoint: "http://127.0.0.1:1234/v1", model: "qwen" },
      },
    });
    const r = resolveModel({ cwd });
    expect(r?.model).toBe("qwen");
    expect(r?.profile).toBe("local");
  });

  it("an explicit ENV override is respected verbatim (no silent switching)", () => {
    writeGlobal({
      profiles: { good: { endpoint: "http://localhost:11434/v1", model: "llama3.1" } },
    });
    process.env.PERSONAXIS_ENDPOINT = "https://forced.example.com/v1";
    process.env.PERSONAXIS_MODEL = "forced-model";
    try {
      const r = resolveModel({ cwd });
      expect(r?.endpoint).toBe("https://forced.example.com/v1");
      expect(r?.model).toBe("forced-model");
      expect(r?.fallback).toBeUndefined();
    } finally {
      delete process.env.PERSONAXIS_ENDPOINT;
      delete process.env.PERSONAXIS_MODEL;
    }
  });

  it("nothing usable anywhere → the direct (keyless) resolution surfaces truthfully", () => {
    writeGlobal({
      defaultProfile: "broken",
      profiles: { broken: { endpoint: "https://api.example.com/v1", model: "x", apiKeyEnv: "NOPE_KEY_ENV" } },
    });
    const r = resolveModel({ cwd });
    expect(r?.endpoint).toBe("https://api.example.com/v1");
    expect(r?.apiKey).toBeUndefined();
  });
});

describe("isLocalEndpoint", () => {
  it("recognizes localhost variants and rejects remotes", () => {
    for (const e of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1"]) {
      expect(isLocalEndpoint(e)).toBe(true);
    }
    for (const e of ["https://api.cohere.ai/compatibility/v1", "https://localhost.evil.com/v1"]) {
      expect(isLocalEndpoint(e)).toBe(false);
    }
  });
});
