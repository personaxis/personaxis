/**
 * InkScreen / ReplApp, the Ink REPL front-end (drop-in for the pre-Ink Screen).
 * Renders through ink-testing-library and is driven by the same store the
 * InkScreen methods (print/setBusy/ask) mutate, so this covers the real path the
 * CLI uses.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ReplApp, createReplStore } from "../src/ink-repl.js";
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

  it("surfaces an approval prompt when asked", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks} />);
    store.getState().setAsk({ prompt: "  approve run_command? [y/N]", resolve: () => {} });
    await flush();
    expect(lastFrame() ?? "").toContain("approve run_command?");
  });
});
