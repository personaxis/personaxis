import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import {
  buildSettingsFromAnswers,
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

describe("buildSettingsFromAnswers", () => {
  it("cloud + env var key stores apiKeyEnv, never the key", () => {
    const s = buildSettingsFromAnswers({ kind: "cloud", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", keyMode: "env", keyEnv: "OPENAI_API_KEY" });
    expect(s).toEqual({ endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" });
  });

  it("local + no key stores just endpoint + model", () => {
    const s = buildSettingsFromAnswers({ kind: "local", endpoint: "http://localhost:11434/v1", model: "llama3.1", keyMode: "none" });
    expect(s).toEqual({ endpoint: "http://localhost:11434/v1", model: "llama3.1" });
  });

  it("inline key stores apiKey and trims whitespace", () => {
    const s = buildSettingsFromAnswers({ kind: "cloud", endpoint: " https://x ", model: " m ", keyMode: "inline", keyInline: " sk-123 " });
    expect(s).toEqual({ endpoint: "https://x", model: "m", apiKey: "sk-123" });
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

  it("runModelSetup: cloud + env key → a saved, defaulted profile", async () => {
    // answers: kind=cloud, endpoint, model, key via env, env name, profile name, make default
    const rl = fakeRl(["2", "https://api.test/v1", "gpt-4o-mini", "1", "OPENAI_API_KEY", "openai", "y"]);
    const res = await runModelSetup(rl, { scope: "global", out: noop });
    expect(res.name).toBe("openai");
    const cfg = loadConfig("global");
    expect(cfg.profiles?.openai).toEqual({ endpoint: "https://api.test/v1", model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" });
    expect(cfg.defaultProfile).toBe("openai");
  });

  it("runConfigMenu: option 2 sets the default from the profile list", async () => {
    saveConfig({ profiles: { p1: { endpoint: "https://a", model: "m" } } }, "global");
    // menu: choose [2] set default, pick profile #1, then [5] done
    await runConfigMenu(fakeRl(["2", "1", "5"]), { cwd: home, out: noop });
    expect(loadConfig("global").defaultProfile).toBe("p1");
  });
});
