/**
 * F3.2, the compile target plugin registry + `.dist/` consumer slices.
 */
import { describe, it, expect } from "vitest";
import {
  placeForTarget,
  getTarget,
  listTargets,
  registerTarget,
  isSoulTarget,
  toSoulMd,
  BUILTIN_TARGETS,
  distSlices,
  type PlacementContext,
} from "../src/index.js";

const DOC = "---\nname: Cmo\ndescription: A CMO\n---\n# Cmo\n\nYou are Cmo, a marketing lead.";
const root: PlacementContext = { isSubagent: false, rootOutputPath: "PERSONA.md" };
const sub: PlacementContext = { isSubagent: true, slug: "cmo", rootOutputPath: "PERSONA.md" };

describe("F3.2 target registry, built-ins", () => {
  it("registers the four focus hosts", () => {
    expect(listTargets()).toEqual([...BUILTIN_TARGETS]);
    for (const id of BUILTIN_TARGETS) expect(getTarget(id)).toBeDefined();
  });

  it("claude-code: shared root, .claude/agents/<slug>.md sub", () => {
    expect(placeForTarget(DOC, "claude-code", root).path).toBe("PERSONA.md");
    expect(placeForTarget(DOC, "claude-code", sub).path).toBe(".claude/agents/cmo.md");
  });

  it("codex sub converts to a .codex/agents/<slug>.toml with instructions", () => {
    const r = placeForTarget(DOC, "codex", sub);
    expect(r.path).toBe(".codex/agents/cmo.toml");
    expect(r.content).toContain('name = "Cmo"');
    expect(r.content).toContain("developer_instructions =");
  });

  it("openclaw/hermes emit SOUL.md and are flagged isSoul", () => {
    expect(placeForTarget(DOC, "openclaw", root).path).toBe("SOUL.md");
    expect(placeForTarget(DOC, "hermes", root).path).toBe(".hermes/SOUL.md");
    expect(placeForTarget(DOC, "openclaw", sub).path).toBe(".openclaw/agents/cmo/SOUL.md");
    expect(isSoulTarget("openclaw")).toBe(true);
    expect(isSoulTarget("claude-code")).toBe(false);
    expect(isSoulTarget(undefined)).toBe(false);
  });

  it("toSoulMd strips subagent frontmatter, keeps identity, adds a heading when missing", () => {
    expect(toSoulMd(DOC)).toBe("# Cmo\n\nYou are Cmo, a marketing lead.");
    expect(toSoulMd("You are plain.")).toBe("# SOUL\n\nYou are plain.");
  });

  it("throws on an unknown target", () => {
    expect(() => placeForTarget(DOC, "nope", root)).toThrow(/Unknown compile target/);
  });

  it("is a real plugin registry: a custom target registers and resolves", () => {
    registerTarget({
      id: "test-host",
      isSoul: false,
      place: (doc, ctx) => ({ path: `.test/${ctx.slug ?? "root"}.md`, content: doc }),
    });
    expect(listTargets()).toContain("test-host");
    expect(placeForTarget(DOC, "test-host", sub).path).toBe(".test/cmo.md");
  });
});

describe("F3.2 .dist/ slices", () => {
  const compiled = [
    "# You are Mira",
    "",
    "You are Mira, a marketing lead.",
    "",
    "## Who you are",
    "",
    "A long identity section with lots of prose.",
    "",
    "## How you speak",
    "",
    "Direct and concise.",
    "",
    "## What you always / never do",
    "",
    "**Always:**",
    "- anchor to a metric",
    "",
    "## In specific situations",
    "",
    "- a big cold-only section",
    "",
    "## Hard limits (never overridden)",
    "",
    "- No fabricated data.",
    "",
    "## Self-improvement",
    "",
    "Suggesting mode.",
  ].join("\n");

  it("cold is the full document; hot carries only the always-load essentials", () => {
    const { hot, cold } = distSlices(compiled);
    expect(cold.trim()).toBe(compiled.trim());
    // hot: opener + how-you-speak + anchors + hard limits
    expect(hot).toContain("# You are Mira");
    expect(hot).toContain("## How you speak");
    expect(hot).toContain("## What you always / never do");
    expect(hot).toContain("## Hard limits (never overridden)");
    // hot MUST NOT carry the cold-only sections
    expect(hot).not.toContain("## Who you are");
    expect(hot).not.toContain("## In specific situations");
    expect(hot).not.toContain("## Self-improvement");
    // and the hot slice is strictly smaller
    expect(hot.length).toBeLessThan(cold.length);
  });

  it("never drops the hard limits from the hot slice (safety)", () => {
    const { hot } = distSlices(compiled);
    expect(hot).toContain("No fabricated data.");
  });

  it("is deterministic", () => {
    expect(distSlices(compiled)).toEqual(distSlices(compiled));
  });
});
