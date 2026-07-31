/**
 * InkScreen / ReplApp, the Ink REPL front-end (drop-in for the pre-Ink Screen).
 * Renders through ink-testing-library and is driven by the same store the
 * InkScreen methods (print/setBusy/ask) mutate, so this covers the real path the
 * CLI uses.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PassThrough } from "node:stream";
import { ReplApp, createReplStore, InkScreen } from "../src/ink-repl.js";
import type { ReplHooks } from "../src/screen.js";

const hooks: ReplHooks = {
  prompt: () => "> ",
  status: () => "ctx offline · improve:locked",
  commands: [
    { name: "help", desc: "show help" },
    { name: "audit", desc: "show the audit" },
    { name: "compile", desc: "recompile" },
  ],
  onSubmit: () => {},
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("InkScreen / ReplApp", () => {
  it("renders committed lines, the status line, and the prompt", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks} />);
    store.getState().append("Clio is awake");
    store.getState().append("hello there");
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("Clio is awake");
    expect(out).toContain("hello there");
    expect(out).toContain("improve:locked");
    expect(out).toContain(">");
  });

  it("shows the spinner + phase while a turn is busy", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks} />);
    store.getState().setBusy(true, "thinking");
    await flush();
    expect(lastFrame() ?? "").toContain("thinking");
  });

  it("filters the / command palette by prefix", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks} />);
    store.getState().setInput("/au");
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("/audit");
    expect(out).not.toContain("/help");
    expect(out).not.toContain("/compile");
  });

  it("windows a long palette to the terminal height instead of hard-capping at 8", async () => {
    const many: ReplHooks = {
      ...hooks,
      commands: Array.from({ length: 30 }, (_, i) => ({ name: `cmd${String(i).padStart(2, "0")}`, desc: `command ${i}` })),
    };
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={many} />);
    store.getState().setInput("/");
    await flush();
    const out = lastFrame() ?? "";
    // More than the old cap of 8 is visible (default 24 rows → 15-item window)...
    expect(out).toContain("/cmd08");
    expect(out).toContain("/cmd14");
    // ...and what does not fit is announced, with a cursor counter.
    expect(out).toContain("▼ 15 more");
    expect(out).toContain("1/30");
    // Every command stays REACHABLE: walking the cursor re-windows the list.
    store.getState().setPaletteIndex(29);
    await flush();
    const end = lastFrame() ?? "";
    expect(end).toContain("/cmd29");
    expect(end).toContain("30/30");
    expect(end).toContain("▲ 15 more");
  });

  it("renders persona replies in a bubble and dividers as a rule (V3.2 chrome)", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks} />);
    store.getState().append("", "divider");
    store.getState().append("the boxed reply", "persona");
    store.getState().append("plain system line");
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("the boxed reply");
    expect(out).toContain("╭"); // the bubble's rounded corner
    expect(out).toContain("╰");
    expect(out).toContain("─────"); // the turn rule
    expect(out).toContain("plain system line");
  });

  it("surfaces an approval prompt when asked", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks} />);
    store.getState().setAsk({ prompt: "  approve run_command? [y/N]", resolve: () => {} });
    await flush();
    expect(lastFrame() ?? "").toContain("approve run_command?");
  });
});

/**
 * THE BUG THAT MADE /resume UNUSABLE: `clearScreen` unmounts the Ink instance to
 * wipe the scrollback and mounts a fresh one. The REPL stays alive by awaiting
 * `waitUntilExit()`, which was awaiting the INSTANCE, so the unmount resolved it,
 * the REPL fell through its await and the process quit the moment a resumed
 * conversation finished printing.
 *
 * The session must outlive any number of re-mounts and end only on a real exit.
 */
describe("InkScreen lifetime across re-mounts", () => {
  const quietHooks: ReplHooks = { ...hooks, onSubmit: () => {} };
  // Ink keeps ONE renderer per stdout, and its input layer needs raw mode. Under
  // vitest, process.stdin has neither, so Ink throws inside render and its exit
  // promise never settles. A private pair of streams makes the real mount/unmount
  // path observable; production passes nothing and gets the terminal.
  const fakeIo = (): { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream } => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(stdout, { columns: 80, rows: 24 });
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => {}, unref: () => {} });
    return { stdout, stdin };
  };
  const makeScreen = (h: ReplHooks = quietHooks): InkScreen =>
    new InkScreen(h, { ...fakeIo(), patchConsole: false, exitOnCtrlC: false });

  it("clearScreen does NOT end the session", async () => {
    const screen = makeScreen();
    let ended = false;
    screen.start();
    void screen.waitUntilExit().then(() => (ended = true));
    screen.clearScreen();
    await flush();
    expect(ended, "a re-mount must not look like an exit").toBe(false);
    screen.stop();
    await flush();
    expect(ended, "stop() is a real exit and must end it").toBe(true);
  });

  it("survives repeated clears (resume, then resume again)", async () => {
    const screen = makeScreen();
    let ended = false;
    screen.start();
    void screen.waitUntilExit().then(() => (ended = true));
    for (let i = 0; i < 3; i++) {
      screen.clearScreen();
      await flush();
    }
    expect(ended).toBe(false);
    screen.stop();
  });

  it("onExit fires once, on the real exit, not on every re-mount", async () => {
    let exits = 0;
    const screen = makeScreen({ ...quietHooks, onExit: () => void (exits += 1) });
    screen.start();
    screen.clearScreen();
    await flush();
    expect(exits).toBe(0);
    screen.stop();
    await flush();
    expect(exits).toBe(1);
  });
});
