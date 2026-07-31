import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const built = existsSync(CLI);

const FIX = `---
apiVersion: personaxis.com/v1
kind: AgentPersona
spec_version: "1.1.0"
metadata: { name: t, version: 1.0.0 }
identity: { canonical_id: tester, display_name: Tester }
---
You are Tester.
`;

function run(args: string[], env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_UPDATE_CHECK: "1", ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe.skipIf(!built)("user hooks lifecycle (V2-F3.C14)", () => {
  let dir: string;
  let persona: string;
  let home: string;
  let marker: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-hooks-"));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    persona = join(dir, "personaxis.md");
    writeFileSync(persona, FIX);
    marker = join(dir, "hook-fired").replace(/\\/g, "/");
  });

  it("fires a UserPromptSubmit hook on a headless turn", { timeout: 90_000 }, () => {
    const hooks = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `node -e "require('fs').writeFileSync('${marker}','x')"` }] },
        ],
      },
    };
    // readHooksConfig reads hooks.json next to the persona file.
    writeFileSync(join(dir, "hooks.json"), JSON.stringify(hooks));
    const r = run(["-p", "hi", "--persona", persona], { PERSONAXIS_HOME: home });
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});
