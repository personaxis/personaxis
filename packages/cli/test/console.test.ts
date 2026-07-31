/**
 * V9 / G.5: the external `console` serializes the SAME scope tree the navigator renders, so an
 * agent drives it headlessly. `ls` lists children, `get` shows a node, `do` runs an action and
 * honors the authority (a blocked/protected coordinate is refused). Targets one persona via
 * `--persona`, so it needs no project registry (temp fixtures are ephemeral by design).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStarterPersona } from "../src/starter.js";

// Each test spawns the CLI synchronously (execFileSync). A cold start is ~1.8s in isolation,
// but under the full suite's parallel spawns it can exceed the default 5s per-test timeout
// (pure CPU contention, not a real failure). Give these e2e spawns generous headroom so the
// gate is not flaky when the whole suite runs together.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { personaTree } from "../src/center/tree.js";

const CLI = join(process.cwd(), "dist", "index.js");

let dir: string;
let mainPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-console-"));
  mainPath = writeStarterPersona(dir, "Vega");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, "console", ...args, "--persona", mainPath], { encoding: "utf-8" });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

/** The id-path (from "main") of the first editable field, computed in-process. */
function firstFieldPath(): string {
  const person = personaTree(mainPath, "", []);
  const layers = person.children().find((c) => c.id === "layers")!;
  const field = layers.children().flatMap((l) => l.children()).find((f) => f.actions.some((a) => a.effect === "direct"))!;
  return field.path.join("/");
}

function identityPermPath(): string {
  const person = personaTree(mainPath, "", []);
  const perms = person.children().find((c) => c.id === "permissions")!;
  return perms.children().find((c) => c.id === "identity")!.path.join("/");
}

describe("personaxis console (G.5)", () => {
  it("ls lists a persona's facets", () => {
    const { out, code } = run(["ls", "main"]);
    expect(code).toBe(0);
    expect(out).toContain("layers");
    expect(out).toContain("permissions");
  });

  it("get a persona as JSON returns its identity and children", () => {
    const { out } = run(["get", "main", "--json"]);
    const node = JSON.parse(out);
    expect(node.level).toBe("persona");
    expect(node.title).toContain("Vega");
    expect(node.children.map((c: { id: string }) => c.id)).toContain("layers");
  });

  it("do edit on a coordinate applies an envelope-clamped mutation", () => {
    const { out, code } = run(["do", firstFieldPath(), "edit", "0.50", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out).ok).toBe(true);
  });

  it("do edit on a protected coordinate is REFUSED", () => {
    const { out, code } = run(["do", identityPermPath(), "edit", "0.9"]);
    expect(code).toBe(1);
    expect(out.toLowerCase()).toMatch(/refused|blocked|protected/);
  });
});
