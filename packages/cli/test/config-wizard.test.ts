import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import {
  buildProfileFromAnswers,
  upsertProfile,
  setDefaultProfile,
  assignProfileToPersona,
  removeProfile,
  profileNames,
  runModelSetup,
  runConfigMenu,
} from "../src/config-wizard.js";
import { loadConfig, saveConfig, type PersonaxisConfig } from "../src/config.js";

/** A readline stub that answers questions from a fixed queue (for the interactive flows). */
function fakeRl(answers: string[]): ReadlineInterface {
  const queue = [...answers];
  return { question: async () => queue.shift() ?? "" } as unknown as ReadlineInterface;
}
const noop = (): void => {};

describe("buildProfileFromAnswers (all provider kinds)", () => {
  it("local + no key stores provider + endpoint + model", () => {
    const p = buildProfileFromAnswers({ kind: "local", endpoint: "http://localhost:11434/v1", model: "llama3.1", keyMode: "none" });
    expect(p).toEqual({ provider: "local", endpoint: "http://localhost:11434/v1", model: "llama3.1" });
  });

  it("local inline key stores apiKey and trims whitespace", () => {
    const p = buildProfileFromAnswers({ kind: "local", endpoint: " https://x ", model: " m ", keyMode: "inline", keyInline: " sk-123 " });
    expect(p).toEqual({ provider: "local", endpoint: "https://x", model: "m", apiKey: "sk-123" });
  });

  it("openai → byok + an OpenAI-compatible endpoint (so the live REPL can use it too)", () => {
    const p = buildProfileFromAnswers({ kind: "openai", model: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" });
    expect(p).toEqual({ provider: "byok", apiProvider: "openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" });
  });

  it("anthropic → byok + Anthropic's OpenAI-compatible endpoint (so it reasons live too)", () => {
    const p = buildProfileFromAnswers({ kind: "anthropic", model: "claude-sonnet-4-6" });
    expect(p).toEqual({ provider: "byok", apiProvider: "anthropic", model: "claude-sonnet-4-6", endpoint: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY" });
  });

  it("huggingface → local provider pointed at the HF OpenAI-compatible router", () => {
    const p = buildProfileFromAnswers({ kind: "huggingface", model: "meta-llama/Llama-3.1-8B-Instruct" });
    expect(p).toEqual({ provider: "local", endpoint: "https://router.huggingface.co/v1", model: "meta-llama/Llama-3.1-8B-Instruct", apiKeyEnv: "HF_TOKEN" });
  });

  it("remote → provider remote + apiBase default", () => {
    const p = buildProfileFromAnswers({ kind: "remote" });
    expect(p).toEqual({ provider: "remote", apiBase: "https://api.personaxis.com" });
  });

  it("agent → provider agent only", () => {
    expect(buildProfileFromAnswers({ kind: "agent" })).toEqual({ provider: "agent" });
  });
});

describe("profile mutations (pure)", () => {
  const base: PersonaxisConfig = {};

  it("upsertProfile adds then overwrites by name", () => {
    let c = upsertProfile(base, "openai", { endpoint: "https://a", model: "m1" });
    expect(profileNames(c)).toEqual(["openai"]);
    c = upsertProfile(c, "openai", { endpoint: "https://a", model: "m2" });
    expect(c.profiles?.openai.model).toBe("m2");
  });

  it("setDefaultProfile + assignProfileToPersona set references", () => {
    let c = upsertProfile(base, "big", { endpoint: "https://a", model: "m" });
    c = setDefaultProfile(c, "big");
    c = assignProfileToPersona(c, "cmo", "big");
    expect(c.defaultProfile).toBe("big");
    expect(c.personas?.cmo.profile).toBe("big");
  });

  it("removeProfile drops the profile and cleans dangling references", () => {
    let c = upsertProfile(base, "big", { endpoint: "https://a", model: "m" });
    c = setDefaultProfile(c, "big");
    c = assignProfileToPersona(c, "cmo", "big");
    c = assignProfileToPersona(c, "legal", "other");
    c = removeProfile(c, "big");
    expect(c.profiles?.big).toBeUndefined();
    expect(c.defaultProfile).toBeUndefined();
    expect(c.personas?.cmo.profile).toBeUndefined(); // reference cleaned
    expect(c.personas?.legal.profile).toBe("other"); // untouched
  });
});

describe("interactive flows (driven by a fake readline)", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.PERSONAXIS_HOME;
    home = mkdtempSync(join(tmpdir(), "pxs-wiz-"));
    process.env.PERSONAXIS_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.PERSONAXIS_HOME;
    else process.env.PERSONAXIS_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("runModelSetup: OpenAI provider → a saved, defaulted byok profile with an endpoint", async () => {
    // answers: provider=[2]OpenAI, model, env var name, profile name, make default
    const rl = fakeRl(["2", "gpt-4o-mini", "OPENAI_API_KEY", "openai", "y"]);
    const res = await runModelSetup(rl, { scope: "global", out: noop });
    expect(res.name).toBe("openai");
    const cfg = loadConfig("global");
    expect(cfg.profiles?.openai).toEqual({ provider: "byok", apiProvider: "openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" });
    expect(cfg.defaultProfile).toBe("openai");
  });

  it("runModelSetup: local provider, no key → a local profile", async () => {
    // answers: provider=[1]local, endpoint, model, key=[3]none, profile name, make default
    const rl = fakeRl(["1", "http://localhost:11434/v1", "llama3.1", "3", "local", "y"]);
    await runModelSetup(rl, { scope: "global", out: noop });
    const cfg = loadConfig("global");
    expect(cfg.profiles?.local).toEqual({ provider: "local", endpoint: "http://localhost:11434/v1", model: "llama3.1" });
    expect(cfg.defaultProfile).toBe("local");
  });

  it("runConfigMenu: option 2 sets the default from the profile list", async () => {
    saveConfig({ profiles: { p1: { endpoint: "https://a", model: "m" } } }, "global");
    // menu: choose [2] set default, pick profile #1, then [5] done
    await runConfigMenu(fakeRl(["2", "1", "5"]), { cwd: home, out: noop });
    expect(loadConfig("global").defaultProfile).toBe("p1");
  });
});
