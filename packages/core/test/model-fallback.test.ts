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

  /**
   * E86, 2026-09-17: the settings a fallback profile declared must survive the fallback.
   *
   * `rounds` did not. The direct path carried it and this one silently dropped it, so a profile reached
   * through a fallback lost its rounds of fresh context without a word, and the only way to notice was to
   * wonder why a switch that was on behaved as if it were off. That is the fault `E96` recorded two lines
   * above the same code ("a field this function forgets is a setting that silently does nothing"), repeated in
   * the function next door, which is what a copy-by-hand seam does when nothing counts its fields.
   *
   * `rounds` itself was retired on 2026-09-21, and this case was reaimed rather than deleted: the field is
   * gone and the seam is not. `contextWindow` crosses it today and would go missing the same way, which is
   * the whole reason to keep a case here instead of a case about one setting.
   *
   * Nothing asserted on these here before, which is why a whole class of setting could go missing unseen: the
   * cases above check the endpoint, the model, the key and the flag, and stop there.
   */
  it("keeps the settings the fallback profile declared, which one of them did not until this was written", () => {
    writeGlobal({
      defaultProfile: "broken",
      profiles: {
        broken: { endpoint: "https://api.example.com/v1", model: "x", apiKeyEnv: "NOPE_KEY_ENV" },
        good: {
          endpoint: "https://api.cohere.ai/compatibility/v1",
          model: "command-a",
          apiKey: "k-123",
          maxTokens: 4096,
          scaffold: "small",
          contextWindow: 8192,
        },
      },
    });

    const r = resolveModel({ cwd });

    expect(r?.fallback).toBe(true);
    expect(r?.maxTokens).toBe(4096);
    expect(r?.scaffold).toBe("small");
    // The one this case exists for now: the window a small model declares, which decides when the loop
    // compacts. A session that lost it would measure itself against a window nobody asked for.
    expect(r?.contextWindow).toBe(8192);
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
