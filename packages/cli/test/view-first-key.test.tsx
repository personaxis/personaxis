/**
 * V6.2 regression guard: the FIRST keypress inside a freshly mounted view must
 * act (tab switch, back). The old child-process suspension path lost every
 * other keystroke to the parent's flowing stdin; views themselves were always
 * single-press, and this pins that so a future host change cannot regress it.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { registerTabbedView } from "../src/repl/views/tabbed.js";

const ESC = "";
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const View = registerTabbedView("first-key-test", {
  title: "first-key",
  tabs: ["One", "Two"],
  lines: (tab) => [tab === 0 ? "alpha-content" : "beta-content"],
});

describe("view first keypress (V6.2)", () => {
  it("the first digit keypress switches the tab, no second press needed", async () => {
    process.env.PERSONAXIS_NO_ANIM = "1";
    const { stdin, lastFrame } = render(
      <View personaPath="" active={true} onBack={() => {}} />,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("alpha-content");
    stdin.write("2");
    await flush();
    expect(lastFrame() ?? "").toContain("beta-content");
  });

  it("the first Esc leaves the view (onBack fires once, immediately)", async () => {
    process.env.PERSONAXIS_NO_ANIM = "1";
    let backs = 0;
    const { stdin } = render(
      <View personaPath="" active={true} onBack={() => void (backs += 1)} />,
    );
    await flush();
    stdin.write(ESC);
    await flush();
    expect(backs).toBe(1);
  });
});
