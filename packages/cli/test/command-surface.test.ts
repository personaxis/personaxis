/**
 * V7.B: the command surface is FOURTEEN grouped commands, plus /sandbox, /bg, /help and
 * /exit, so eighteen entries when you browse the palette with a bare `/`.
 *
 * The count is asserted from the code below rather than quoted from the plan (which said
 * "~12"): a headline number that nobody re-measures drifts away from the product.
 *
 * As few commands as possible, each one properly built. Everything else became a tab or an
 * action, and typing the old verb says where its capability lives now WITHOUT running it
 * (V8.A), so nothing vanishes silently: `/help moved` prints the whole map, and
 * `EXTERNAL_DOOR` names the non-interactive command for the verbs that took an argument.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paletteMatches, type SlashItem } from "@personaxis/tui/ink";
import { ABSORBED, EXTERNAL_DOOR, listCommands, runCommand } from "../src/repl/commands.js";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter, POSTURES } from "../src/repl/config.js";
import { writeTestPersona } from "./helpers/test-persona.js";

const PRIMARY = [
  "resume", "compact", "context",
  "persona", "status", "drift", "audit", "memory",
  "create", "compile", "skill",
  "model", "menu", "doctor",
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-surface-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const scaffold = () => {
  const ctx = makeCtx(writeTestPersona(dir, "Vega"), makeMeter());
  const out: string[] = [];
  ctx.out = (t: string) => void out.push(t);
  return { ctx, out };
};

describe("command surface (V7.B)", () => {
  it("the palette leads with the primary commands, in help order", () => {
    const names = listCommands().map((c) => c.name);
    expect(names.slice(0, PRIMARY.length)).toEqual(PRIMARY);
  });

  it("absorbed verbs are not commands any more, in any listing", () => {
    // V8.A: hiding a command that still runs is not removing it. A hidden
    // command that still works is the clutter this consolidation exists to remove, and
    // two ways to do one thing is how the implementations drifted in the first place.
    const names = listCommands().map((c) => c.name);
    for (const gone of ["cost", "dash", "state", "lint", "validate", "overseer", "goal", "mode"]) {
      expect(names, `/${gone} was absorbed and must no longer be a command`).not.toContain(gone);
    }
  });

  it("typing an absorbed verb says where it went, and does NOT run it", async () => {
    const { ctx, out } = scaffold();
    await runCommand("/cost", ctx);
    const text = out.join(String.fromCharCode(10));
    expect(text).toContain("now part of");
    expect(text).toContain("/status");
    // The external door is named too: an agent reading this must know what to call.
    expect(text).toContain("personaxis status");
  });

  it("/help moved prints the absorption map", async () => {
    const { ctx, out } = scaffold();
    await runCommand("/help moved", ctx);
    const text = out.join("\n");
    expect(text).toContain("became tabs or actions");
    expect(text).toContain("/cost");
    expect(text).toContain("/status → Usage");
    expect(text).toContain("/rewind");
  });

  it("/help lists the four groups and points at the moved map", async () => {
    const { ctx, out } = scaffold();
    await runCommand("/help", ctx);
    const text = out.join("\n");
    for (const g of ["Talk", "Identity", "Build", "Run"]) expect(text).toContain(g);
    expect(text).toContain("/help moved");
    // Absorbed verbs do not clutter the default listing.
    expect(text).not.toContain("/cost ");
  });

  it("searching for an absorbed verb answers where it went", async () => {
    const { ctx, out } = scaffold();
    await runCommand("/help rewind", ctx);
    expect(out.join("\n")).toContain("/audit → Timeline");
  });
});

/**
 * The bug that survived three rounds of "consolidate the commands": `/help` showed
 * the grouped surface while typing `/` offered all forty, because the palette built its own list
 * from raw COMMANDS instead of using listCommands(). The consolidation was real and
 * invisible exactly where a person looks for it.
 *
 * These assert the PALETTE, not the help text. Testing `listCommands()` alone is what
 * let this pass for a whole release.
 */
describe("the `/` palette shows the consolidated surface (V7.B, regression)", () => {
  const palette = (): SlashItem[] => listCommands();

  // Everything a bare `/` may offer, spelled out. A count would let a new command
  // slip in unnoticed, which is the class of drift this whole suite exists for.
  const BROWSE = [...PRIMARY, "sandbox", "bg", "help", "exit"];

  it("browsing with a bare `/` lists the primary commands only", () => {
    const shown = paletteMatches("/", palette());
    expect(shown.map((c) => c.name).sort()).toEqual([...BROWSE].sort());
    expect(shown.every((c) => !c.desc.startsWith("→")), "no absorbed verb may be offered while browsing").toBe(true);
    for (const name of ["cost", "usage", "state", "dash", "validate", "lint", "init", "mode", "overseer"]) {
      expect(shown.some((c) => c.name === name), `/${name} was absorbed and must not be in the browse list`).toBe(false);
    }
  });

  it("the palette does not offer absorbed verbs at all", () => {
    expect(paletteMatches("/val", palette()).map((c) => c.name)).not.toContain("validate");
    expect(paletteMatches("/cos", palette()).map((c) => c.name)).not.toContain("cost");
  });

  it("the browse list and /help agree, exactly", () => {
    const browsing = paletteMatches("/", palette()).map((c) => c.name).sort();
    const helped = listCommands().filter((c) => !c.hidden).map((c) => c.name).sort();
    expect(browsing).toEqual(helped);
  });
});

/**
 * V8.A: absorption is a CONTRACT, not a convention.
 *
 * It used to be a map of prose, and prose cannot be enforced: `/state` and `/cost` really
 * delegated, while `/lint` and `/validate` kept a SECOND implementation. They drifted exactly
 * as you would expect: "every finding carries its remedy" reached `doctor` and the `lint`
 * subcommand, and never reached the `/lint` slash command, so the same question answered
 * differently depending on where it was typed, and it was visible from the outside.
 */
describe("absorbed verbs delegate, they do not re-implement (V8.A)", () => {
  /**
   * Measured on 2026-09-23 (L12): this suite used to assert the MAP, not the behaviour. It
   * read `keepsBody`, a field the product never looked at, served by `absorbedRun`, a
   * function nothing called, so it passed while `/help moved` and the README both promised
   * these verbs still ran and `runCommand` refused to run them. A test that asserts a
   * declaration cannot catch a declaration that lies. So every one of them is typed here.
   */
  it("every absorbed verb, typed, says where it went and does not run", async () => {
    for (const [name, t] of Object.entries(ABSORBED)) {
      const { ctx, out } = scaffold();
      const handled = await runCommand(`/${name}`, ctx);
      expect(handled, `/${name} must not execute: the capability moved to ${t.where}`).toBe(false);
      expect(out.join(String.fromCharCode(10)), `/${name} must say where it went`).toContain(t.where);
    }
  });

  /**
   * A verb that took an argument (`/goal <text>`, `/rewind <n>`) cannot be answered with
   * "open this view" alone: without a door that accepts the argument, the ACTION is what
   * gets lost, quietly, and only for the people who used it.
   */
  it("a verb that took an argument names the command that still takes it", async () => {
    for (const name of ["arbitrate", "goal", "improve", "init", "loop", "mode", "rewind"]) {
      expect(Object.keys(EXTERNAL_DOOR), `/${name} took an argument`).toContain(name);
      const { ctx, out } = scaffold();
      await runCommand(`/${name} something`, ctx);
      expect(out.join(String.fromCharCode(10))).toContain(`personaxis ${EXTERNAL_DOOR[name]}`);
    }
  });

  it("/lint points at doctor, which owns the ONLY implementation", async () => {
    const { ctx, out } = scaffold();
    await runCommand("/lint", ctx);
    expect(out.join(String.fromCharCode(10))).toContain("/doctor");

    // And doctor really does carry the remedies the retired private renderer omitted,
    // which is the whole reason the duplicate had to go.
    const d = scaffold();
    await runCommand("/doctor", d.ctx);
    expect(d.out.join(String.fromCharCode(10))).toContain("fix:");
  });
});

describe("/sandbox replaces /mode (V7.B, E1.20)", () => {
  it("cycles the posture and explains what it allows", async () => {
    const { ctx, out } = scaffold();
    const before = ctx.postureIndex;
    await runCommand("/sandbox", ctx);
    expect(ctx.postureIndex).toBe((before + 1) % POSTURES.length);
    const text = out.join("\n");
    expect(text).toContain("sandbox →");
    expect(text).toMatch(/read|write|network/); // says what it permits, not just a label
  });

  it("/mode is gone: it points at /sandbox instead of cycling silently", async () => {
    const { ctx, out } = scaffold();
    const before = ctx.postureIndex;
    await runCommand("/mode", ctx);
    expect(ctx.postureIndex, "the retired name must not act").toBe(before);
    expect(out.join(String.fromCharCode(10))).toContain("/sandbox");
  });
});
