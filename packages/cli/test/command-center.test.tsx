/**
 * Command Center (V2-F2): navigation + the Model section actually saving a
 * profile, driven through ink-testing-library's stdin (the real key path the
 * fullscreen TUI uses). PERSONAXIS_HOME is sandboxed so the config writes land
 * in a temp dir, not the developer's ~/.personaxis.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCenter } from "../src/command-center.js";
import { loadConfig } from "../src/config.js";

const DOWN = "[B";
const ENTER = "\r";
const ESC = "";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PERSONAXIS_HOME;
  home = mkdtempSync(join(tmpdir(), "pxs-center-"));
  process.env.PERSONAXIS_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("CommandCenter navigation", () => {
  it("renders the section hub with the frame chrome", async () => {
    const { lastFrame } = render(<CommandCenter cwd={home} />);
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("◉ personaxis");
    expect(out).toContain("command center");
    expect(out).toContain("Model");
    expect(out).toContain("Memory");
    expect(out).toContain("Fleet");
  });

  it("enters a section and Esc returns to the hub", async () => {
    const { lastFrame, stdin } = render(<CommandCenter cwd={home} initialSection="home" />);
    await flush();
    stdin.write(ENTER); // open Model (first item)
    await flush();
    expect(lastFrame() ?? "").toContain("Add a model");
    stdin.write(ESC); // back to hub
    await flush();
    expect(lastFrame() ?? "").toContain("State"); // hub items visible again
  });
});

describe("CommandCenter Model section saves a profile", () => {
  it("walks add → provider → form and writes a defaulted profile", async () => {
    const { stdin, lastFrame } = render(<CommandCenter cwd={home} initialSection="model" />);
    await flush();
    // Model menu: item 0 = "Add a model".
    stdin.write(ENTER);
    await flush();
    expect(lastFrame() ?? "").toContain("Local / OpenAI-compatible");
    // Provider picker: choose OpenAI (item index 1).
    stdin.write(DOWN);
    await flush();
    stdin.write(ENTER);
    await flush();
    // Form step 1: model name (blank → default gpt-4o-mini).
    stdin.write(ENTER);
    await flush();
    // Form step 2: env var (blank → default OPENAI_API_KEY).
    stdin.write(ENTER);
    await flush();
    // Form step 3: profile name (blank → default "openai").
    stdin.write(ENTER);
    await flush();
    // Form step 4: make default? (select, item 0 = yes).
    stdin.write(ENTER);
    await flush();

    const cfg = loadConfig("global");
    expect(cfg.profiles?.openai).toEqual({
      provider: "byok",
      apiProvider: "openai",
      model: "gpt-4o-mini",
      endpoint: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(cfg.defaultProfile).toBe("openai");
    // The Center shows the saved-profile toast + landed on the profiles view.
    expect(lastFrame() ?? "").toContain("saved");
  });
});
