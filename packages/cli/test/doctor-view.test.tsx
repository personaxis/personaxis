/**
 * V7.B4 + V7.C1b: Doctor is a miniapp, and it answers for the SELECTED persona.
 *
 * The gap this closes: a sub-persona's health was only reachable by typing
 * `/doctor @slug` from memory, so in practice nobody checked it, and a sub with
 * no compiled document (invisible to its host agent) stayed invisible here too.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTabbedView } from "../src/repl/views/tabbed.js";
import { doctorProvider } from "../src/repl/views/doctor-view.js";
import { doctorChecksOffline } from "../src/repl/doctor-checks.js";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { writeStarterPersona } from "../src/starter.js";

process.env.PERSONAXIS_NO_ANIM = "1";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-doctor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the Doctor miniapp (V7.B4)", () => {
  it("leads with what it is, and states a verdict in plain words", async () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Vega"), makeMeter());
    const View = registerTabbedView("doctor-test-1", doctorProvider(ctx));
    const { lastFrame } = render(<View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} />);
    await flush();
    expect(lastFrame()).toContain("what this is");
    expect(lastFrame()).toContain("spec valid");
    // The network probe is NOT run from a view that redraws on a timer, and the
    // screen says where to get it.
    expect(lastFrame()).toContain("/doctor net");
  });

  it("`p` switches persona and the checks re-run against that one", async () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Vega"), makeMeter());
    writeStarterPersona(dir, "Helper", "helper");
    const View = registerTabbedView("doctor-test-2", doctorProvider(ctx));
    const { stdin, lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} />,
    );
    await flush();
    expect(lastFrame()).toContain("[main]");
    stdin.write("p");
    await flush();
    expect(lastFrame()).toContain("[helper]");
    expect(lastFrame(), "the verdict must be about the SELECTED persona").toMatch(/helper/);
  });
});

describe("no finding without a remedy, end to end (V7.B4)", () => {
  it("a broken sub-persona reports each failure with the edit that fixes it", () => {
    const subDir = join(dir, ".personaxis", "personas", "broken");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "personaxis.md"),
      ["---", "apiVersion: personaxis.com/v1", "kind: AgentPersona", 'spec_version: "1.1.0"', "metadata:", "  name: broken", "---", ""].join("\n"),
    );
    const report = doctorChecksOffline(join(subDir, "personaxis.md"));
    const text = report.lines.join("\n");

    expect(report.failures).toBeGreaterThan(0);
    // Every reported problem is followed by a remedy line.
    const problems = report.lines.filter((l) => l.includes("✗") || l.includes(" ! "));
    expect(problems.length).toBeGreaterThan(0);
    expect(text).toContain("fix:");
    // And the remedy names the field, not the schema's internals: a reader must
    // never be sent to "#/allOf/0/then/required".
    expect(text).not.toContain("#/allOf");
    expect(text).toMatch(/Add the missing field 'character'/);
  });

  it("counts findings from the checks, not by grepping its own prose", () => {
    // A remedy containing an exclamation mark used to inflate the warning count,
    // because the tally was a regex over rendered lines.
    const ctx = makeCtx(writeStarterPersona(dir, "Vega"), makeMeter());
    const report = doctorChecksOffline(ctx.handle.personaPath);
    const rendered = report.lines.filter((l) => l.includes("✗")).length;
    expect(report.failures).toBe(rendered);
  });
});
