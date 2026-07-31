import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import {
  installJsonStopHook,
  hasJsonStopHook,
  jsonStopHookPath,
  installHook,
  uninstallHook,
  hookStatus,
  hermesConfigPath,
  hermesHookDir,
  openclawHookDir,
  OBSERVE_CMD,
  HOSTS,
} from "../src/commands/hooks.js";

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

/**
 * openclaw and Hermes install a hook DIRECTORY rather than a JSON stanza, and until now
 * the only thing asserted about them was that their names appeared in a list. A host whose
 * installer is never exercised is a host we claim to support on paper. These run the real
 * installers against a redirected home.
 */
describe("hooks for the SOUL hosts (openclaw, Hermes)", () => {
  // `os.homedir()` reads HOME / USERPROFILE on every call, so pointing both at a temp dir
  // redirects the installers without mocking the module.
  let realHome: string | undefined;
  let realUserProfile: string | undefined;
  beforeEach(() => {
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
  });

  it("openclaw: installs HOOK.md + handler.ts, and reports how to enable it", () => {
    expect(hookStatus("openclaw", true).installed).toBe(false);
    const r = installHook("openclaw", true);
    expect(r.already).toBe(false);
    expect(r.extra).toContain("openclaw hooks enable");
    const hookMd = readFileSync(join(openclawHookDir(), "HOOK.md"), "utf-8");
    // openclaw discovers hooks by frontmatter: the event it binds must be declared.
    expect(hookMd).toContain("command:stop");
    expect(hookMd).toContain("personaxis-observe");
    expect(readFileSync(join(openclawHookDir(), "handler.ts"), "utf-8")).toContain(OBSERVE_CMD.split(" ")[0]);
    expect(hookStatus("openclaw", true).installed).toBe(true);
  });

  it("hermes: installs HOOK.yaml bound to agent:end, plus the python handler", () => {
    expect(hookStatus("hermes", true).installed).toBe(false);
    const r = installHook("hermes", true);
    expect(r.already).toBe(false);
    const yamlText = readFileSync(join(hermesHookDir(), "HOOK.yaml"), "utf-8");
    // agent:end is the per-TURN event; session:end only fires on /new or /reset, which
    // would make the persona learn once per session instead of once per turn.
    expect(yamlText).toContain("agent:end");
    expect(yamlText).not.toContain("session:end");
    expect(readFileSync(join(hermesHookDir(), "handler.py"), "utf-8")).toContain("async def handle");
    expect(hookStatus("hermes", true).installed).toBe(true);
  });

  it("both are idempotent: a second install reports `already` and does not duplicate", () => {
    for (const host of ["openclaw", "hermes"] as const) {
      installHook(host, true);
      expect(installHook(host, true).already, host).toBe(true);
    }
  });

  it("uninstall removes our directory, and is safe to run twice", () => {
    for (const host of ["openclaw", "hermes"] as const) {
      installHook(host, true);
      expect(uninstallHook(host, true).removed, host).toBe(true);
      expect(hookStatus(host, true).installed, host).toBe(false);
      expect(uninstallHook(host, true).removed, `${host} second uninstall`).toBe(false);
    }
  });

  /**
   * An older installer wrote a `hooks.on_session_end` stanza into ~/.hermes/config.yaml, a
   * shape Hermes never had. Install and uninstall both clean it up, and must leave the
   * user's own configuration untouched while doing so.
   */
  it("hermes: cleans up the legacy config stanza without touching the rest of the file", () => {
    const cfgPath = hermesConfigPath();
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(
      cfgPath,
      yaml.dump({
        model: "hermes-4",
        hooks: { on_session_end: [{ command: OBSERVE_CMD }, { command: "someone-elses-tool" }] },
      }),
      "utf-8",
    );
    installHook("hermes", true);
    const after = yaml.load(readFileSync(cfgPath, "utf-8")) as {
      model: string;
      hooks?: { on_session_end?: Array<{ command?: string }> };
    };
    expect(after.model, "unrelated config must survive").toBe("hermes-4");
    expect(after.hooks?.on_session_end?.map((h) => h.command)).toEqual(["someone-elses-tool"]);
  });

  it("every host reports a status without throwing, installed or not", () => {
    for (const host of HOSTS) {
      const s = hookStatus(host, true);
      expect(s.path, host).toBeTruthy();
      expect(typeof s.installed, host).toBe("boolean");
    }
  });
});
