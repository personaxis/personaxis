import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installJsonStopHook, hasJsonStopHook, jsonStopHookPath, OBSERVE_CMD, HOSTS } from "../src/commands/hooks.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-hooks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hooks, the four focus hosts", () => {
  it("supports all four focus hosts", () => {
    expect([...HOSTS]).toEqual(["claude-code", "codex", "openclaw", "hermes"]);
  });

  it("installs a Stop hook running `personaxis observe --stdin` (Claude Code / Codex shape)", () => {
    const path = join(dir, "settings.json");
    const r = installJsonStopHook(path);
    expect(r.already).toBe(false);
    const s = JSON.parse(readFileSync(path, "utf-8"));
    expect(s.hooks.Stop[0].hooks[0].command).toBe(OBSERVE_CMD);
    expect(s.hooks.Stop[0].hooks[0].type).toBe("command");
  });

  it("is idempotent, a second install detects the existing hook", () => {
    const path = join(dir, "settings.json");
    installJsonStopHook(path);
    expect(installJsonStopHook(path).already).toBe(true);
    const s = JSON.parse(readFileSync(path, "utf-8"));
    expect(s.hooks.Stop).toHaveLength(1); // not duplicated
  });

  it("merges into an existing settings file without clobbering other hooks", () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "some-other-tool" }] }] }, other: 1 }));
    installJsonStopHook(path);
    const s = JSON.parse(readFileSync(path, "utf-8"));
    expect(s.other).toBe(1); // preserved
    expect(hasJsonStopHook(s)).toBe(true);
    expect(s.hooks.Stop.some((g: { hooks?: { command: string }[] }) => g.hooks?.some((h) => h.command === "some-other-tool"))).toBe(true); // the other hook survived
  });

  it("codex and claude-code map to their own config files (project + global)", () => {
    expect(jsonStopHookPath("claude-code", false)).toMatch(/[\\/]\.claude[\\/]settings\.json$/);
    expect(jsonStopHookPath("codex", false)).toMatch(/[\\/]\.codex[\\/]hooks\.json$/);
    expect(jsonStopHookPath("codex", true)).toMatch(/[\\/]\.codex[\\/]hooks\.json$/);
  });
});
