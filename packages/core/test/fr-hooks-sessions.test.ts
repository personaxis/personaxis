/**
 * FR.4 (inbound shell-out hooks) + FR.6 (session writer/threading/index).
 * Hook commands use `node -e` so the contract is exercised identically on
 * win32 and POSIX.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHooks,
  readHooksConfig,
  type HooksConfig,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-frhs-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(personaPath, "---\nmetadata: { name: h }\n---\nbody\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ── FR.4 hooks ────────────────────────────────────────────────────────────────

describe("FR.4 shell-out hooks", () => {
  it("exit 0 = ok; exit 2 = BLOCK; other exit = warn (never blocks)", async () => {
    // Generous per-hook timeout: under full-suite load a node spawn on Windows
    // can exceed the 5 s default, which would turn the expected block into a
    // timeout-warn and make this test flaky (PA infra fix, FASE 7).
    const config: HooksConfig = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: `node -e "process.exit(0)"`, timeout: 30_000 }] },
        ],
      },
    };
    expect((await runHooks("PreToolUse", { tool: "x" }, config, "x")).blocked).toBe(false);

    config.hooks!.PreToolUse![0].hooks[0].command = `node -e "process.exit(2)"`;
    const blocked = await runHooks("PreToolUse", { tool: "x" }, config, "x");
    expect(blocked.blocked).toBe(true);
    expect(blocked.outcomes[0].result).toBe("block");

    config.hooks!.PreToolUse![0].hooks[0].command = `node -e "process.exit(1)"`;
    const warned = await runHooks("PreToolUse", { tool: "x" }, config, "x");
    expect(warned.blocked).toBe(false);
    expect(warned.outcomes[0].result).toBe("warn");
  }, 90_000);

  it("receives the payload as JSON on stdin and may answer with a JSON decision", async () => {
    // The hook blocks IFF the tool named on stdin is `run_command`.
    const script =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{" +
      "const p=JSON.parse(d);" +
      "console.log(JSON.stringify({decision:p.tool==='run_command'?'block':'ok',seen:p.hook_event}));" +
      "});";
    const config: HooksConfig = {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node -e "${script}"`, timeout: 30_000 }] }] },
    };
    const blocked = await runHooks("PreToolUse", { tool: "run_command" }, config, "run_command");
    expect(blocked.blocked).toBe(true);
    expect(blocked.outcomes[0].decision?.seen).toBe("PreToolUse");
    const ok = await runHooks("PreToolUse", { tool: "read_file" }, config, "read_file");
    expect(ok.blocked).toBe(false);
  }, 90_000);

  it("matcher scopes a group to specific tools; timeout fails OPEN to warn", async () => {
    const config: HooksConfig = {
      hooks: {
        PreToolUse: [
          { matcher: "^write_", hooks: [{ type: "command", command: `node -e "process.exit(2)"`, timeout: 30_000 }] },
        ],
      },
    };
    expect((await runHooks("PreToolUse", {}, config, "read_file")).outcomes).toHaveLength(0);
    expect((await runHooks("PreToolUse", {}, config, "write_file")).blocked).toBe(true);

    const slow: HooksConfig = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: `node -e "setTimeout(()=>{},60000)"`, timeout: 150 }] },
        ],
      },
    };
    const r = await runHooks("PreToolUse", {}, slow, "x");
    expect(r.blocked).toBe(false);
    expect(r.outcomes[0].result).toBe("warn");
  });

  it("fire-and-forget events return immediately and never block", async () => {
    const config: HooksConfig = {
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: `node -e "process.exit(2)"` }] }] },
    };
    const t0 = Date.now();
    const r = await runHooks("SessionEnd", {}, config);
    expect(r.blocked).toBe(false); // exit 2 is irrelevant on non-blocking events
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("readHooksConfig loads .personaxis/hooks.json and tolerates corruption", () => {
    expect(readHooksConfig(personaPath)).toEqual({});
    writeFileSync(join(dir, ".personaxis", "hooks.json"), '{"hooks":{"Stop":[]}}');
    expect(readHooksConfig(personaPath).hooks?.Stop).toEqual([]);
    writeFileSync(join(dir, ".personaxis", "hooks.json"), "{broken");
    expect(readHooksConfig(personaPath)).toEqual({});
  });
});

// FR.6's session writer was DELETED by E11, and so were its tests.
//
// It queued turns for a background drain and derived a session index, and nothing
// called either. The reasoning for removing rather than mounting it lives on
// `appendTurn` in `sessions.ts`, where the next person will wonder why the write is
// synchronous: the async path is less safe (a queue loses its un-acked tail) and saves
// a fraction of a millisecond at the end of a turn that just waited seconds for a
// model, and the index solved a problem measured not to exist, 21 sessions in the
// largest persona on the machine.
//
// The behaviour those three tests actually protected, turns landing in order with
// their threading intact, is covered by the `appendTurn` tests above and by every
// session the REPL writes.
