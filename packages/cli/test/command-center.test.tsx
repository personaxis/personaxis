/**
 * Command Center (V2-F2): navigation + the Model section actually saving a
 * profile, driven through ink-testing-library's stdin (the real key path the
 * fullscreen TUI uses). PERSONAXIS_HOME is sandboxed so the config writes land
 * in a temp dir, not the developer's ~/.personaxis.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCenter, fleetRows } from "../src/command-center.js";
import { writeStarterPersona } from "../src/starter.js";
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

/**
 * V8.B: the Command Center must answer three questions without being asked, on every
 * screen: WHERE am I, WHAT does this act on, and WHAT happens if I press this. It
 * answered none of them: you could be three levels deep with no way to tell whether you
 * were configuring one persona, one project, or everything on the machine, and the fleet
 * showed the same generic footer on every row.
 */
describe("the Command Center says where you are and what you are acting on (V8.B)", () => {
  let dir: string;
  let personaPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-cc-proj-"));
    personaPath = writeStarterPersona(dir, "Vega");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("shows machine › project › persona, and what the section acts on", async () => {
    const { lastFrame } = render(<CommandCenter personaPath={personaPath} personas={[]} cwd={dir} />);
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("›"); // the three containers, in nesting order
    expect(out).toMatch(/acting on: this persona/);
  });

  it("the fleet is a table with a header and a row-specific Enter hint", async () => {
    const { lastFrame } = render(
      <CommandCenter personaPath={personaPath} personas={[]} cwd={dir} initialSection="fleet" />,
    );
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("reachable from");
    expect(out).toContain("who is using it");
    // Not a generic footer: it names the focused row.
    expect(out).toMatch(/Enter: open main/);
  });

  it("`/` searches the fleet, and `q` typed into it does not quit", async () => {
    writeStarterPersona(dir, "Helper", "helper");
    const { stdin, lastFrame } = render(
      <CommandCenter personaPath={personaPath} personas={["helper"]} cwd={dir} initialSection="fleet" />,
    );
    await flush();
    stdin.write("/");
    await flush();
    expect(lastFrame() ?? "").toContain("search:");
    stdin.write("q");
    await flush();
    expect(lastFrame() ?? "", "the filter owns the keyboard while open").toContain("search: q");
    stdin.write("\x1b");
    await flush();
    expect(lastFrame() ?? "").not.toContain("search:");
  });

  it("an empty fleet teaches how projects are registered instead of showing a zero", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pxs-empty-"));
    try {
      const { lastFrame } = render(<CommandCenter personas={[]} cwd={empty} initialSection="fleet" />);
      await flush();
      const out = lastFrame() ?? "";
      expect(out).toMatch(/register themselves as you use them/);
      expect(out).toContain("overseer scan");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fleetRows reports WHO is using a persona, not a bare boolean", () => {
    mkdirSync(join(dir, ".personaxis", "presence"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, ".personaxis", "presence", "laptop-77.json"),
      JSON.stringify({ deviceId: "laptop", machine: "MacBook", user: "me", pid: 77, host: "claude-code", since: now, ts: now }),
    );
    const rows = fleetRows("project", personaPath, []);
    expect(rows[0].detail).toContain("claude-code");
    expect(rows[0].detail).toContain("MacBook");
    expect(rows[0].awake).toBe(true);
  });
});
