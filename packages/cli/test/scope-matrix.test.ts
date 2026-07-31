/**
 * V7.C: persona scopes and the configuration matrix.
 *
 * These tests exist because of Design note: "todas estas opciones la mayoria
 * funcionan sobre el ai persona main, no sobre los ai sub personas". A test that only ever
 * exercises the main persona would let that regress silently, so every case here builds a
 * project with SUB-personas and asserts they are reachable and answered for individually.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import chalk from "chalk";
import matter from "gray-matter";
import { readMode, listTargets } from "@personaxis/core";
import { runMode } from "../src/commands/improve.js";
import { BASELINE_SECTION } from "../src/targets/claude-code.js";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { writeStarterPersona } from "../src/starter.js";
import {
  personaScopes,
  scopeByAddress,
  scopedCtx,
  settingFor,
  invalidateScopeCache,
  hostsFor,
  MATRIX_SETTINGS,
} from "../src/repl/scope.js";
import { configMatrixLines, settingDetailLines, configMatrixText } from "../src/repl/views/config-matrix.js";
import { personaLines } from "../src/repl/views/persona-data.js";
import { isRow, lineText, type TabLine } from "../src/repl/views/tabbed.js";

chalk.level = 0; // assert on text, not on escape codes

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-scope-"));
  invalidateScopeCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A project with a main persona and two sub-personas, one of them nested. */
function projectWithSubs(): ReturnType<typeof makeCtx> {
  const main = writeStarterPersona(dir, "Main");
  writeStarterPersona(dir, "Legal", "legal");
  writeStarterPersona(dir, "Ventas", "ventas");
  return makeCtx(main, makeMeter());
}

const asText = (lines: TabLine[]): string => lines.map(lineText).join("\n");

describe("persona scopes (V7.C1)", () => {
  it("lists the main persona FIRST, then every sub, each addressable", () => {
    const ctx = projectWithSubs();
    const scopes = personaScopes(ctx);
    expect(scopes).toHaveLength(3);
    expect(scopes[0].address).toBe("");
    expect(scopes[0].label).toBe("main");
    expect(scopes[0].depth).toBe(0);
    expect(scopes.map((s) => s.label).sort()).toEqual(["legal", "main", "ventas"]);
    for (const s of scopes.slice(1)) expect(s.depth).toBe(1);
  });

  it("a lone persona still yields exactly one scope (no phantom subs)", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Solo"), makeMeter());
    expect(personaScopes(ctx)).toHaveLength(1);
  });

  it("scopedCtx re-points the persona files WITHOUT moving the session", () => {
    const ctx = projectWithSubs();
    const legal = scopeByAddress(personaScopes(ctx), "legal");
    const sub = scopedCtx(ctx, legal);
    // It reads the sub's files…
    expect(sub.handle.personaPath).toBe(legal.personaPath);
    expect(sub.handle.statePath).toContain("legal");
    expect(sub.handle.frontmatter).not.toBe(ctx.handle.frontmatter);
    // …while the session itself (posture, meter, conversation, the loop that can actually
    // make a persona speak or evolve) is untouched. A scoped view displays; it never acts.
    expect(sub.postureIndex).toBe(ctx.postureIndex);
    expect(sub.meter).toBe(ctx.meter);
    expect(sub.loop).toBe(ctx.loop);
    expect(sub.conversation).toBe(ctx.conversation);
  });

  /**
   * Found by the V7.C1 selector the moment it could point at a sub: a freshly created
   * sub-persona has a spec but no state.json, `readState` throws on the missing file, and
   * the WHOLE Persona view went blank instead of rendering that persona. A view must
   * degrade to "not initialized yet", never to nothing.
   */
  it("renders a persona that has no state.json yet, and says so", () => {
    const ctx = projectWithSubs();
    const legal = scopeByAddress(personaScopes(ctx), "legal");
    expect(existsSync(join(dirname(legal.personaPath), "state.json"))).toBe(false);
    const sub = scopedCtx(ctx, legal);
    for (let tab = 0; tab < 6; tab++) {
      expect(() => personaLines(sub, tab), `tab ${tab} threw on a stateless persona`).not.toThrow();
    }
    const identity = personaLines(sub, 0).join("\n");
    expect(identity).toContain("not initialized yet");
    expect(identity, "a warning must carry its remedy").toContain("personaxis state init");
  });

  it("an unknown address falls back to main instead of throwing", () => {
    const ctx = projectWithSubs();
    expect(scopeByAddress(personaScopes(ctx), "does-not-exist").address).toBe("");
  });

  it("re-reads a spec after it changes on disk (cache is mtime-keyed, not permanent)", () => {
    const ctx = projectWithSubs();
    const legal = scopeByAddress(personaScopes(ctx), "legal");
    expect(settingFor(ctx, legal, "improve").value).toBe("locked");
    runMode(legal.personaPath, "suggesting"); // the real write path, not a regex
    invalidateScopeCache(legal.personaPath);
    expect(settingFor(ctx, legal, "improve").value).toBe("suggesting");
  });
});

describe("settings resolve per persona, with their origin (V7.C2, V7.C3)", () => {
  it("improve is PER PERSONA and reads from that persona's own spec", () => {
    const ctx = projectWithSubs();
    const scopes = personaScopes(ctx);
    const legal = scopeByAddress(scopes, "legal");
    runMode(legal.personaPath, "suggesting");
    invalidateScopeCache(legal.personaPath);

    const legalMode = settingFor(ctx, legal, "improve");
    const mainMode = settingFor(ctx, scopes[0], "improve");
    expect(legalMode.value).toBe("suggesting");
    expect(legalMode.own).toBe(true);
    expect(legalMode.origin).toBe("spec");
    // The two personas genuinely differ: this is the jerarquía the design chose.
    expect(mainMode.value).not.toBe("suggesting");
  });

  /**
   * Found while writing these tests: the matrix originally read
   * `improvement_policy.mode` straight from the frontmatter, but the RUNTIME resolves the
   * mode with `readMode`, which also consults a sibling policy.yaml and applies the
   * STRICTER of the two. A persona whose spec asked for "autonomous" under a policy that
   * caps it at "locked" would have been displayed as autonomous while behaving as locked.
   * A configuration view that disagrees with the gate is worse than no view at all, so
   * this pins the two together.
   */
  it("shows the mode the GATE will actually apply, not the one the spec asks for", () => {
    const ctx = projectWithSubs();
    const legal = scopeByAddress(personaScopes(ctx), "legal");
    runMode(legal.personaPath, "autonomous");
    writeFileSync(
      join(dirname(legal.personaPath), "policy.yaml"),
      "improvement_policy:\n  mode: locked\n",
      "utf-8",
    );
    invalidateScopeCache(legal.personaPath);

    const shown = settingFor(ctx, legal, "improve");
    const enforced = readMode(
      matter(readFileSync(legal.personaPath, "utf-8")).data as Record<string, unknown>,
      legal.personaPath,
    );
    expect(shown.value).toBe(enforced);
    expect(shown.value).toBe("locked");
    // And it must SAY why the spec's request is not what is in force.
    expect(shown.readonly).toMatch(/policy\.yaml/);
  });

  it("sandbox is PER SESSION: same for every persona, and marked non-editable per persona", () => {
    const ctx = projectWithSubs();
    const values = personaScopes(ctx).map((s) => settingFor(ctx, s, "sandbox"));
    expect(new Set(values.map((v) => v.value)).size).toBe(1);
    for (const v of values) {
      expect(v.origin).toBe("session");
      expect(v.own).toBe(false);
      expect(v.readonly, "the UI must say WHY it cannot be set per persona").toMatch(/session/i);
    }
  });

  it("every setting resolves for every persona without throwing", () => {
    const ctx = projectWithSubs();
    for (const scope of personaScopes(ctx)) {
      for (const setting of MATRIX_SETTINGS) {
        const eff = settingFor(ctx, scope, setting);
        expect(eff.value, `${scope.label}/${setting}`).toBeTruthy();
        expect(eff.origin).toBeTruthy();
      }
    }
  });
});

/**
 * V7.C5, Design note: "puedo tener varios activos en local, o funcionando en x
 * aplicacion, como claude code, o codex". A host counts as reached only when the compiled
 * document actually EXISTS where that host looks for it: claiming reach from configuration
 * would be claiming an integration we have not verified.
 */
describe("host reach (V7.C5)", () => {
  it("reports no hosts until a persona is actually compiled into one", () => {
    const ctx = projectWithSubs();
    for (const scope of personaScopes(ctx)) expect(hostsFor(scope.personaPath)).toEqual([]);
  });

  /**
   * A baseline host reaches the MAIN persona INDIRECTLY: CLAUDE.md / AGENTS.md must carry
   * the managed block that points at the compiled document. The first version of this
   * check accepted any CLAUDE.md at all, which reported reach for a project that merely
   * happened to have one — a false claim about an integration.
   */
  it("does NOT claim reach from a baseline file that does not reference the persona", () => {
    const ctx = projectWithSubs();
    const main = personaScopes(ctx)[0];
    writeFileSync(join(dir, "PERSONA.md"), "# compiled\n", "utf-8");
    writeFileSync(join(dir, "CLAUDE.md"), "# someone else's baseline\n", "utf-8");
    expect(hostsFor(main.personaPath)).toEqual([]);
  });

  it("finds the MAIN persona once the baseline carries the managed block", () => {
    const ctx = projectWithSubs();
    const main = personaScopes(ctx)[0];
    writeFileSync(join(dir, "PERSONA.md"), "# compiled\n", "utf-8");
    writeFileSync(join(dir, "CLAUDE.md"), `# baseline\n${BASELINE_SECTION}\n`, "utf-8");
    expect(hostsFor(main.personaPath)).toEqual(["claude-code"]);
    writeFileSync(join(dir, "AGENTS.md"), `# baseline\n${BASELINE_SECTION}\n`, "utf-8");
    expect(hostsFor(main.personaPath).sort()).toEqual(["claude-code", "codex"]);
  });

  it("finds a SUB-persona through the host's agents directory, and only that sub", () => {
    const ctx = projectWithSubs();
    const scopes = personaScopes(ctx);
    const legal = scopeByAddress(scopes, "legal");
    const ventas = scopeByAddress(scopes, "ventas");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "legal.md"), "# legal\n", "utf-8");
    expect(hostsFor(legal.personaPath)).toEqual(["claude-code"]);
    expect(hostsFor(ventas.personaPath), "reach must not leak between siblings").toEqual([]);
  });

  /**
   * openclaw and Hermes were supported by the compiler from the start; the first version
   * of `hostsFor` kept its own two-host list and silently reported them as unreachable.
   * The list is now derived from the compile-target registry, so these two are covered by
   * the same code path as the other two.
   */
  it("covers EVERY registered compile target, not a hand-kept subset", () => {
    expect(listTargets().sort()).toEqual(["claude-code", "codex", "hermes", "openclaw"]);
  });

  it("finds a SOUL host (openclaw) at the workspace root, no baseline needed", () => {
    const ctx = projectWithSubs();
    const main = personaScopes(ctx)[0];
    writeFileSync(join(dir, "SOUL.md"), "# SOUL\n", "utf-8");
    expect(hostsFor(main.personaPath)).toEqual(["openclaw"]);
  });

  it("finds Hermes at its profile path, and a sub under the host's agents dir", () => {
    const ctx = projectWithSubs();
    const scopes = personaScopes(ctx);
    mkdirSync(join(dir, ".hermes"), { recursive: true });
    writeFileSync(join(dir, ".hermes", "SOUL.md"), "# SOUL\n", "utf-8");
    expect(hostsFor(scopes[0].personaPath)).toEqual(["hermes"]);

    const legal = scopeByAddress(scopes, "legal");
    mkdirSync(join(dir, ".openclaw", "agents", "legal"), { recursive: true });
    writeFileSync(join(dir, ".openclaw", "agents", "legal", "SOUL.md"), "# SOUL\n", "utf-8");
    expect(hostsFor(legal.personaPath)).toEqual(["openclaw"]);
  });

  it("reports all four hosts at once when a persona is compiled into all of them", () => {
    const ctx = projectWithSubs();
    const main = personaScopes(ctx)[0];
    writeFileSync(join(dir, "PERSONA.md"), "# compiled\n", "utf-8");
    writeFileSync(join(dir, "CLAUDE.md"), `${BASELINE_SECTION}\n`, "utf-8");
    writeFileSync(join(dir, "AGENTS.md"), `${BASELINE_SECTION}\n`, "utf-8");
    writeFileSync(join(dir, "SOUL.md"), "# SOUL\n", "utf-8");
    mkdirSync(join(dir, ".hermes"), { recursive: true });
    writeFileSync(join(dir, ".hermes", "SOUL.md"), "# SOUL\n", "utf-8");
    expect(hostsFor(main.personaPath).sort()).toEqual(["claude-code", "codex", "hermes", "openclaw"]);
  });

  it("the Fleet view carries the host column for every persona of the project", async () => {
    const ctx = projectWithSubs();
    const { fleetRows } = await import("../src/command-center.js");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "legal.md"), "# legal\n", "utf-8");
    // The main persona is reached by codex only through a baseline carrying the managed
    // block AND the compiled document it points at.
    writeFileSync(join(dir, "PERSONA.md"), "# compiled\n", "utf-8");
    writeFileSync(join(dir, "AGENTS.md"), `${BASELINE_SECTION}\n`, "utf-8");

    const rows = fleetRows("project", ctx.handle.personaPath, ["legal", "ventas"]);
    expect(rows.map((r) => r.label)).toEqual(["main", "@legal", "@ventas"]);
    expect(rows[0].hosts).toEqual(["codex"]); // the main persona, via AGENTS.md
    expect(rows[1].hosts).toEqual(["claude-code"]); // the sub, via .claude/agents
    expect(rows[2].hosts).toEqual([]); // not compiled anywhere
  });

  it("the matrix's hooks row reports exactly the same reach", () => {
    const ctx = projectWithSubs();
    const legal = scopeByAddress(personaScopes(ctx), "legal");
    expect(settingFor(ctx, legal, "hooks").value).toBe("(not compiled into any host)");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "legal.md"), "# legal\n", "utf-8");
    expect(settingFor(ctx, legal, "hooks").value).toBe("claude-code");
  });
});

describe("the configuration matrix (V7.C2)", () => {
  it("has one selectable row per setting, and every row drills down", () => {
    const ctx = projectWithSubs();
    const lines = configMatrixLines(ctx, 120);
    const rows = lines.filter(isRow);
    expect(rows.map((r) => r.label)).toEqual([...MATRIX_SETTINGS]);
    for (const r of rows) expect(r.onEnter, `${r.label} must drill down`).toBeDefined();
  });

  it("names EVERY persona, including ones too narrow to fit as columns", () => {
    const ctx = projectWithSubs();
    // A terminal too narrow for three columns must still not hide personas silently.
    const narrow = asText(configMatrixLines(ctx, 46));
    expect(narrow).toMatch(/more persona\(s\) do not fit/);
    // …and the drill-down, which is the view that scales, lists all of them.
    const detail = asText(settingDetailLines(ctx, "improve"));
    for (const label of ["main", "legal", "ventas"]) expect(detail).toContain(label);
  });

  it("the drill-down states where each value comes from, and how to change it", () => {
    const ctx = projectWithSubs();
    const text = asText(settingDetailLines(ctx, "model"));
    expect(text).toMatch(/↳ /); // an origin line per persona
    expect(text).toMatch(/change it:/); // no value shown without the way to change it
  });

  it("a read-only setting says why instead of offering a change", () => {
    const ctx = projectWithSubs();
    const text = asText(settingDetailLines(ctx, "sandbox"));
    expect(text).toMatch(/per SESSION/);
    expect(text).not.toMatch(/change it:/);
  });

  it("lists every persona as a row, but only the editable ones carry an action", () => {
    const ctx = projectWithSubs();
    const lines = settingDetailLines(ctx, "improve", (scope) =>
      scope.address === "legal" ? () => ({ kind: "toast", text: "ok" }) : undefined,
    );
    const rows = lines.filter(isRow);
    // Uniform rows: a mixed list of rows and plain text renders through two different
    // paths in the host and comes out misaligned.
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.onEnter)).toHaveLength(1);
    expect(rows.find((r) => r.onEnter)!.label).toContain("legal");
    // And a non-editable row still explains itself instead of going silent.
    for (const r of rows) expect(r.hint, `${r.label} has no hint`).toBeTruthy();
  });

  it("the pipe projection covers every setting x every persona", () => {
    const ctx = projectWithSubs();
    const text = configMatrixText(ctx).join("\n");
    for (const setting of MATRIX_SETTINGS) expect(text).toContain(setting);
    for (const label of ["main", "legal", "ventas"]) expect(text).toContain(label);
    expect(text).toMatch(/\(own: |\(inherited: /);
  });
});
