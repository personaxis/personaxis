import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectRootBaselines } from "../src/commands/compile.js";
import { placeCompiledDocument, isSoulPlatform, PLACEMENT_PLATFORMS } from "../src/targets/placement.js";
import { toSoulMd } from "../src/targets/soul-md.js";
import type { CompileTargetInfo } from "../src/compile-instructions.js";

const root: CompileTargetInfo = { label: "root", outputPath: "PERSONA.md", isSubagent: false };
const sub: CompileTargetInfo = { label: "sub", outputPath: ".personaxis/personas/cmo/PERSONA.md", isSubagent: true, slug: "cmo" };
const DOC = "---\nname: Cmo\ndescription: A CMO\n---\n# Cmo\n\nYou are Cmo, a marketing lead.";

describe("compile targets, the four focus hosts", () => {
  it("PLACEMENT_PLATFORMS includes the four focus hosts", () => {
    expect([...PLACEMENT_PLATFORMS]).toEqual(["claude-code", "codex", "openclaw", "hermes"]);
  });

  it("openclaw emits SOUL.md at the workspace root (and per-agent for subs)", () => {
    expect(placeCompiledDocument(DOC, root, "openclaw").path).toBe("SOUL.md");
    expect(placeCompiledDocument(DOC, sub, "openclaw").path).toBe(".openclaw/agents/cmo/SOUL.md");
    // the subagent frontmatter is stripped; the qualitative identity is kept
    const c = placeCompiledDocument(DOC, root, "openclaw").content;
    expect(c).not.toContain("description: A CMO");
    expect(c).toContain("You are Cmo");
  });

  it("hermes emits SOUL.md under the profile dir (.hermes/SOUL.md; per-agent for subs)", () => {
    expect(placeCompiledDocument(DOC, root, "hermes").path).toBe(".hermes/SOUL.md");
    expect(placeCompiledDocument(DOC, sub, "hermes").path).toBe(".hermes/agents/cmo/SOUL.md");
  });

  it("claude-code root is the shared PERSONA.md; sub is .claude/agents/<slug>.md", () => {
    expect(placeCompiledDocument(DOC, root, "claude-code").path).toBe("PERSONA.md");
    expect(placeCompiledDocument(DOC, sub, "claude-code").path).toBe(".claude/agents/cmo.md");
  });

  it("codex sub converts to a .codex/agents/<slug>.toml", () => {
    const r = placeCompiledDocument(DOC, sub, "codex");
    expect(r.path).toBe(".codex/agents/cmo.toml");
    expect(r.content).toContain("developer_instructions =");
    expect(r.content).toContain('name = "Cmo"');
  });

  it("isSoulPlatform flags only openclaw/hermes (they skip @PERSONA.md baseline injection)", () => {
    expect(isSoulPlatform("openclaw")).toBe(true);
    expect(isSoulPlatform("hermes")).toBe(true);
    expect(isSoulPlatform("claude-code")).toBe(false);
    expect(isSoulPlatform(undefined)).toBe(false);
  });
});

describe("toSoulMd", () => {
  it("strips subagent frontmatter and keeps the identity body", () => {
    expect(toSoulMd(DOC)).toBe("# Cmo\n\nYou are Cmo, a marketing lead.");
  });
  it("adds a # SOUL heading when the body has none", () => {
    expect(toSoulMd("You are a plain persona.")).toBe("# SOUL\n\nYou are a plain persona.");
  });
});

/**
 * V7.C5, found by dogfooding all four hosts end to end: `compile --root --platform codex`
 * reported success while writing a CLAUDE.md and no AGENTS.md, so the main persona was
 * unreachable from Codex. The default policy (only refresh baselines that already exist,
 * and create CLAUDE.md when a project has none) is right for an unqualified compile: it
 * keeps us from littering a project with baselines for hosts it does not use. It is wrong
 * for an EXPLICIT --platform, which is a request, not a guess.
 */
describe("root baseline injection follows the requested platform (V7.C5)", () => {
  // No `process.chdir` here: it is process-global, and vitest shares a worker between
  // suites, so changing it leaked into another suite and made it load a different persona.
  // `injectRootBaselines` takes the directory instead.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-baseline-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("--platform codex CREATES AGENTS.md in a project that has no baseline", () => {
    injectRootBaselines("codex", dir);
    expect(existsSync(join(dir, "AGENTS.md")), "codex must get its own baseline").toBe(true);
    expect(existsSync(join(dir, "CLAUDE.md")), "and not another host's").toBe(false);
  });

  it("--platform claude-code creates CLAUDE.md, and only that", () => {
    injectRootBaselines("claude-code", dir);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("with no platform, it still defaults to CLAUDE.md and litters nothing else", () => {
    injectRootBaselines(undefined, dir);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("refreshes an EXISTING baseline of the other host rather than ignoring it", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# my agents file\n", "utf-8");
    injectRootBaselines(undefined, dir);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(agents, "the user's own content survives").toContain("# my agents file");
    expect(agents).toMatch(/PERSONA:(BASELINE|CODEX)/);
  });
});
