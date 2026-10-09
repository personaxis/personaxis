import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { modelEnv, runCli, startFakeModel, type FakeModel } from "./helpers/fake-model.js";

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

describe.skipIf(!built)("user hooks lifecycle (V2-F3.C14)", () => {
  let dir: string;
  let persona: string;
  let home: string;
  let marker: string;
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel();
  });
  afterAll(() => model.close());
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pxs-hooks-"));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    persona = join(dir, "personaxis.md");
    writeFileSync(persona, FIX);
    marker = join(dir, "hook-fired").replace(/\\/g, "/");
  });

  it("fires a UserPromptSubmit hook on a headless turn", { timeout: 90_000 }, async () => {
    const hooks = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `node -e "require('fs').writeFileSync('${marker}','x')"` }] },
        ],
      },
    };
    // readHooksConfig reads hooks.json next to the persona file.
    writeFileSync(join(dir, "hooks.json"), JSON.stringify(hooks));
    const r = await runCli(CLI, ["-p", "hi", "--persona", persona], { env: { PERSONAXIS_HOME: home, ...modelEnv(model) } });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});
