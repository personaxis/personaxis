import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommands } from "../src/repl/index.js";
import { COMMANDS } from "../src/repl/commands.js";

function findCmd(name: string) {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new Error(`command ${name} not registered`);
  return cmd;
}

function fakeCtx(personaPath: string, frontmatter: unknown, out: string[]) {
  return { handle: { personaPath, frontmatter }, out: (s: string) => out.push(s) } as never;
}

describe("/skill command (V2-F3.C13)", () => {
  it("is registered in the slash-command menu", () => {
    expect(listCommands().map((c) => c.name)).toContain("skill");
  });

  it("lists declared local skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxs-skill-"));
    mkdirSync(join(dir, "skills", "summarize"), { recursive: true });
    writeFileSync(join(dir, "skills", "summarize", "SKILL.md"), "# Summarize\nSummarize the input.");
    const personaPath = join(dir, "personaxis.md");
    writeFileSync(personaPath, "irrelevant");
    const out: string[] = [];
    await findCmd("skill").run("", fakeCtx(personaPath, { extensions: { skills: ["summarize"] } }, out));
    const joined = out.join("\n");
    expect(joined).toContain("summarize");
    expect(joined.toLowerCase()).toContain("local");
  });

  it("reports an unknown skill name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxs-skill2-"));
    const personaPath = join(dir, "personaxis.md");
    writeFileSync(personaPath, "irrelevant");
    const out: string[] = [];
    await findCmd("skill").run("nope", fakeCtx(personaPath, {}, out));
    expect(out.join("\n")).toContain("no skill");
  });
});
