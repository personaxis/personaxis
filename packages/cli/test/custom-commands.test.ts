/**
 * Custom slash commands (V2-F3.C12): discovery from .personaxis/commands/*.md and
 * argument expansion ($ARGUMENTS, $1..$9, append fallback).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCustomCommands, findCustomCommand, expandCommand } from "../src/repl/custom-commands.js";

let dir: string;
let personaPath: string;
let savedCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-cmds-"));
  // Root persona layout: .personaxis/personaxis.md + .personaxis/commands/*.md
  const pxs = join(dir, ".personaxis");
  mkdirSync(join(pxs, "commands"), { recursive: true });
  personaPath = join(pxs, "personaxis.md");
  writeFileSync(personaPath, "---\nmetadata: { name: t }\n---\nbody");
  savedCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(savedCwd);
  rmSync(dir, { recursive: true, force: true });
});

function writeCmd(name: string, content: string): void {
  writeFileSync(join(dir, ".personaxis", "commands", `${name}.md`), content);
}

describe("loadCustomCommands", () => {
  it("discovers command files with frontmatter", () => {
    writeCmd("review", `---\ndescription: Review a PR\nargument-hint: "<pr-url>"\n---\nReview this pull request thoroughly:\n$ARGUMENTS`);
    writeCmd("standup", "What did I do yesterday?");
    const cmds = loadCustomCommands(personaPath);
    expect(cmds.map((c) => c.name)).toEqual(["review", "standup"]);
    const review = cmds.find((c) => c.name === "review")!;
    expect(review.description).toBe("Review a PR");
    expect(review.argumentHint).toBe("<pr-url>");
    expect(review.body).toContain("Review this pull request");
    // A body-only file gets a default description.
    expect(cmds.find((c) => c.name === "standup")!.description).toBe("custom command");
  });

  it("returns [] when no commands dir exists", () => {
    rmSync(join(dir, ".personaxis", "commands"), { recursive: true, force: true });
    expect(loadCustomCommands(personaPath)).toEqual([]);
  });

  it("findCustomCommand resolves by name, case-insensitively", () => {
    writeCmd("deploy", "Deploy to $1 with strategy $2");
    expect(findCustomCommand(personaPath, "DEPLOY")?.name).toBe("deploy");
    expect(findCustomCommand(personaPath, "missing")).toBeUndefined();
  });
});

describe("expandCommand", () => {
  const mk = (body: string) => ({ name: "x", description: "", body, path: "" });

  it("substitutes $ARGUMENTS with the full arg string", () => {
    expect(expandCommand(mk("Summarize: $ARGUMENTS"), "the Q3 report")).toBe("Summarize: the Q3 report");
  });

  it("substitutes positional $1..$9", () => {
    expect(expandCommand(mk("Deploy $1 using $2"), "prod canary")).toBe("Deploy prod using canary");
    // Missing positionals become empty.
    expect(expandCommand(mk("Deploy $1 using $2"), "prod")).toBe("Deploy prod using");
  });

  it("appends args when the body has no placeholder", () => {
    expect(expandCommand(mk("Explain this code."), "src/foo.ts")).toBe("Explain this code.\n\nsrc/foo.ts");
  });

  it("leaves a placeholder-free body untouched with no args", () => {
    expect(expandCommand(mk("Run the standup routine."), "")).toBe("Run the standup routine.");
  });
});
