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

  it("surfaces an approval prompt when asked", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks} />);
    store.getState().setAsk({ prompt: "  approve run_command? [y/N]", resolve: () => {} });
    await flush();
    expect(lastFrame() ?? "").toContain("approve run_command?");
  });
});
