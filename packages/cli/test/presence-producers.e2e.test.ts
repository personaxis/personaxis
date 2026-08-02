/**
 * D6 against a real process: `serve` announces itself and lets go.
 *
 * The unit tests prove the holder behaves; this proves a producer USES it. That distinction
 * is the whole point of the item, because the defect being fixed was never a broken helper.
 * It was a helper only the REPL called, while every other surface held a persona in silence.
 *
 * It also exercises the one path no in-process test can reach: a long-running command does
 * not end by returning, it ends because someone pressed Ctrl+C, and a hold that only
 * released on a clean return would leave a marker claiming a server that is gone.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "index.js");
const built = existsSync(CLI);

// Windows has no POSIX signals: `process.kill` terminates outright rather than delivering
// something the child can handle. The clean-exit half is asserted where it can be, and the
// design already assumes a holder may die without cleaning up, which is why readers judge
// by heartbeat age and delete what has expired.
const signalsDelivered = process.platform !== "win32";

const FIX = `---
metadata: { name: t, version: 1.0.0 }
identity: { canonical_id: tester, display_name: Tester }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-0.2, 0.2] }
---
Tester body.
`;

/** The presence directory sits beside the persona, one file per instance. */
function markers(personaDir: string): string[] {
  const dir = join(personaDir, "presence");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe.skipIf(!built)("a running producer announces itself", () => {
  let home: string;
  let persona: string;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "pxs-presence-e2e-"));
    persona = join(home, "personaxis.md");
    writeFileSync(persona, FIX);
  });

  afterAll(() => {
    child?.kill();
    rmSync(home, { recursive: true, force: true });
  });

  it("shows up while serving and lets go when told to stop", { timeout: 90_000 }, async () => {
    // Port 0 is not an option here: `serve` prints the port it was given, so the test picks
    // a high one and a collision fails loudly rather than silently serving elsewhere.
    const port = 7000 + Math.floor(Math.random() * 900);
    child = spawn("node", [CLI, "serve", "--persona", persona, "--port", String(port)], {
      env: { ...process.env, FORCE_COLOR: "0", PERSONAXIS_NO_ANIM: "1" },
      stdio: "ignore",
    });

    expect(await until(() => markers(home).length === 1)).toBe(true);

    const file = join(home, "presence", markers(home)[0]);
    const entry = JSON.parse(readFileSync(file, "utf-8")) as { host: string; pid: number; activity?: string };
    expect(entry.host).toBe("serve");
    expect(entry.pid).toBe(child.pid);
    // The activity names the address, because "serving http" does not tell you which of two
    // servers you are looking at.
    expect(entry.activity).toContain(String(port));

    if (signalsDelivered) {
      child.kill("SIGTERM");
      expect(await until(() => markers(home).length === 0)).toBe(true);
    } else {
      child.kill();
    }
  });
});
