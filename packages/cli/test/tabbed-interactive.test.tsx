/**
 * V6.1: the tabbed host stops being passive text. The cursor moves over
 * SELECTABLE rows only, Enter runs the row's action (toast or drill-down),
 * Esc pops the drill before it leaves the view, and the Settings provider's
 * Config actions edit real state in place (posture cycles and persists on ctx).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTabbedView, lineText, type TabAction } from "../src/repl/views/tabbed.js";
import { settingsProvider, personaProvider } from "../src/repl/views/interactive.js";
import { scopedProvider } from "../src/repl/views/scoped.js";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter, POSTURES } from "../src/repl/config.js";
import { writeStarterPersona } from "../src/starter.js";

const ESC = "";
const UP = "[A";
const DOWN = "[B";
const ENTER = "\r";
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

process.env.PERSONAXIS_NO_ANIM = "1";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-inter-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const scaffoldCtx = () => makeCtx(writeStarterPersona(dir, "Vega"), makeMeter());

describe("tabbed host v2 (V6.1)", () => {
  const View = registerTabbedView("v61-host-test", {
    title: "host",
    tabs: ["Main"],
    lines: () => [
      "  plain text",
      { label: "toastme", value: "v", onEnter: (): TabAction => ({ kind: "toast", text: "toasted!" }) },
      "  more text",
      { label: "drillme", value: "d", onEnter: (): TabAction => ({ kind: "drill", title: "deep", lines: () => ["  inside-the-drill"] }) },
    ],
  });

  it("cursor skips text lines; Enter fires the focused row's toast", async () => {
    const { stdin, lastFrame } = render(<View personaPath="" active={true} onBack={() => {}} />);
    await flush();
    expect(lastFrame()).toContain("❯ toastme");
    stdin.write(ENTER);
    await flush();
    expect(lastFrame()).toContain("toasted!");
  });

  it("Enter drills down; Esc pops the drill, not the view", async () => {
    let backs = 0;
    const { stdin, lastFrame } = render(<View personaPath="" active={true} onBack={() => void (backs += 1)} />);
    await flush();
    stdin.write(DOWN); // -> drillme
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(lastFrame()).toContain("inside-the-drill");
    expect(lastFrame()).toContain("› deep");
    stdin.write(ESC);
    await flush();
    expect(backs).toBe(0); // popped the drill, still in the view
    expect(lastFrame()).toContain("❯ toastme");
    stdin.write(UP); // cursor already at first row, stays
    stdin.write(ESC);
    await flush();
    expect(backs).toBe(1); // now it left the view
  });
});

describe("Settings provider interactivity (V6.1)", () => {
  /**
   * V7.C2: Config now OPENS on the matrix (one row per setting, one column per persona),
   * and the posture is changed through the sandbox row's drill-down rather than from a
   * duplicate "Actions" row that only ever applied to the active persona.
   */
  it("Config tab: the matrix leads, and the sandbox drill cycles the session posture", async () => {
    const ctx = scaffoldCtx();
    const before = ctx.postureIndex;
    const View = registerTabbedView("v61-settings-test", settingsProvider(ctx));
    const { stdin, lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} params={{ tab: "Config" }} />,
    );
    await flush();
    // The matrix is the first thing on the tab, and `model` is its first selectable row.
    expect(lastFrame()).toContain("every setting, for every persona");
    expect(lastFrame()).toContain("❯ model");
    for (const setting of ["model", "improve", "sandbox", "memory", "hooks"]) {
      expect(lastFrame()).toContain(setting);
    }
    // model → improve → sandbox, then open it.
    stdin.write(DOWN);
    stdin.write(DOWN);
    await flush();
    expect(lastFrame()).toContain("❯ sandbox");
    stdin.write(ENTER);
    await flush();
    // Inside the drill the main persona's row cycles the posture for the whole session.
    stdin.write(ENTER);
    await flush();
    expect(ctx.postureIndex).toBe((before + 1) % POSTURES.length);
    expect(lastFrame()).toContain(POSTURES[ctx.postureIndex]);
  });

  it("Status tab: the inspect-state row drills into per-coordinate detail", async () => {
    const ctx = scaffoldCtx();
    const View = registerTabbedView("v61-status-test", settingsProvider(ctx));
    const { stdin, lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} params={{ tab: "Status" }} />,
    );
    await flush();
    // V7.H2 put `daemons` above it, so Status opens on that row; both are selectable.
    expect(lastFrame()).toContain("❯ daemons");
    expect(lastFrame()).toContain("inspect state");
    stdin.write(DOWN);
    await flush();
    expect(lastFrame()).toContain("❯ inspect state");
    stdin.write(ENTER);
    await flush();
    expect(lastFrame()).toContain("› state");
    expect(lastFrame()).toContain("every live coordinate");
  });
});

describe("Persona provider Anatomy drill (V6.1)", () => {
  it("layers are rows; Enter opens the declared layer detail", async () => {
    const ctx = scaffoldCtx();
    const View = registerTabbedView("v61-persona-test", personaProvider(ctx));
    const { stdin, lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} params={{ tab: "Anatomy" }} />,
    );
    await flush();
    expect(lastFrame()).toContain("1 identity");
    stdin.write(ENTER); // first layer row: identity
    await flush();
    expect(lastFrame()).toContain("› identity");
    expect(lastFrame()).toContain("as declared in personaxis.md");
  });
});

/**
 * V7.C1: the persona selector belongs to the HOST, so every miniapp that can show more
 * than one persona gets it in the same place, with the same key. Without this test the
 * contract degrades back to "everything shows the main persona".
 */
describe("the host's persona selector (V7.C1)", () => {
  it("shows every persona, and `p` switches which one the view answers for", async () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Vega"), makeMeter());
    writeStarterPersona(dir, "Helper", "helper");
    const View = registerTabbedView("v7c1-scope-test", personaProvider(ctx));
    const { stdin, lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} params={{ tab: "Identity" }} />,
    );
    await flush();
    // The selector is visible, with the main persona marked as the current one.
    expect(lastFrame()).toContain("persona");
    expect(lastFrame()).toContain("[main]");
    expect(lastFrame()).toContain("helper");
    // `p` moves to the sub, and the view now answers for IT.
    stdin.write("p");
    await flush();
    expect(lastFrame()).toContain("[helper]");
    expect(lastFrame()).not.toContain("[main]");
    // and back around.
    stdin.write("p");
    await flush();
    expect(lastFrame()).toContain("[main]");
  });

  it("wraps ANY provider, so a view gets the selector in one line", async () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Vega"), makeMeter());
    writeStarterPersona(dir, "Helper", "helper");
    // A minimal provider that simply reports which persona it was handed: this is the
    // contract the Ledger, Skills and the rest are wired through.
    const View = registerTabbedView(
      "v7c1b-wrap-test",
      scopedProvider(ctx, (c) => ({
        title: "Wrapped",
        tabs: ["One"],
        lines: () => [`  answering for ${c.handle.personaPath}`],
      })),
    );
    const { stdin, lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} params={{}} />,
    );
    await flush();
    expect(lastFrame()).not.toContain("helper" + "\\personaxis.md");
    stdin.write("p");
    await flush();
    expect(lastFrame()).toContain("[helper]");
    expect(lastFrame(), "the wrapped provider must receive the SELECTED persona").toMatch(
      /answering for .*helper/,
    );
  });

  it("stays out of the way when there is only one persona", async () => {
    const ctx = scaffoldCtx();
    const View = registerTabbedView("v7c1-solo-test", personaProvider(ctx));
    const { lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} params={{ tab: "Identity" }} />,
    );
    await flush();
    expect(lastFrame()).not.toContain("p switches");
  });
});

describe("Persona provider Sub-personas rows (V6.6)", () => {
  it("lists main + subs as rows and drills into a sub's card", async () => {
    const ctx = scaffoldCtx();
    const subDir = join(dir, ".personaxis", "personas", "helper");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "personaxis.md"), "---\nspec_version: 1.1.0\n---\n");
    const View = registerTabbedView("v66-subs-test", personaProvider(ctx));
    const { stdin, lastFrame } = render(
      <View personaPath={ctx.handle.personaPath} active={true} onBack={() => {}} params={{ tab: "Sub-personas" }} />,
    );
    await flush();
    expect(lastFrame()).toContain("❯ main"); // where you are, always first
    expect(lastFrame()).toContain("@helper");
    stdin.write(DOWN); // -> @helper
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(lastFrame()).toContain("How to use it");
    expect(lastFrame()).toContain("@helper <message>");
  });
});

describe("lineText projection (pipes)", () => {
  it("rows flatten to label + value text", () => {
    expect(lineText({ label: "posture", value: "standard" })).toContain("posture");
    expect(lineText("  plain")).toBe("  plain");
  });
});

/**
 * V8.B3: drilling goes as deep as the data does, and the breadcrumb says where you are.
 *
 * Two levels was never the requirement; the requirement is that you can always tell how
 * deep you are and get back one step at a time. Esc pops ONE level, never the whole view,
 * which is what makes exploring safe.
 */
describe("three-level drill with breadcrumbs (V8.B3)", () => {
  const View = registerTabbedView("v8b3-deep", {
    title: "root",
    tabs: ["Main"],
    lines: () => [
      {
        label: "level one",
        onEnter: (): TabAction => ({
          kind: "drill",
          title: "one",
          lines: () => [
            {
              label: "level two",
              onEnter: (): TabAction => ({
                kind: "drill",
                title: "two",
                lines: () => [
                  {
                    label: "level three",
                    onEnter: (): TabAction => ({
                      kind: "drill",
                      title: "three",
                      lines: () => ["  the deepest thing"],
                    }),
                  },
                ],
              }),
            },
          ],
        }),
      },
    ],
  });

  it("descends three levels, showing the path, and Esc climbs back one at a time", async () => {
    let backs = 0;
    const { stdin, lastFrame } = render(<View personaPath="" active={true} onBack={() => void (backs += 1)} />);
    await flush();

    stdin.write(ENTER);
    await flush();
    expect(lastFrame()).toContain("› one");

    stdin.write(ENTER);
    await flush();
    expect(lastFrame()).toContain("› one › two");

    stdin.write(ENTER);
    await flush();
    const deep = lastFrame() ?? "";
    expect(deep).toContain("› one › two › three");
    expect(deep).toContain("the deepest thing");

    // Esc pops ONE level per press, and only leaves the view from the top.
    for (const crumb of ["› one › two", "› one"]) {
      stdin.write(ESC);
      await flush();
      expect(lastFrame()).toContain(crumb);
      expect(backs, "Esc must not leave the view while there is depth left").toBe(0);
    }

    // Back at the root of the view: the breadcrumb is gone, and we are still inside.
    stdin.write(ESC);
    await flush();
    expect(lastFrame()).not.toContain("›");
    expect(backs, "the last level pops to the view root, it does not leave").toBe(0);

    // Only from the root does Esc leave the view.
    stdin.write(ESC);
    await flush();
    expect(backs).toBe(1);
  });
});
