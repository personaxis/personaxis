/**
 * The Ink prompt kit (card selector + text prompt) driven through ink-testing-library's stdin, so
 * this covers the real key handling the config/onboarding TUI uses.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { SelectApp, PromptApp, type Card } from "../src/prompt.js";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25));
const DOWN = "[B";
const UP = "[A";
const ESC = "";
const ENTER = "\r";

const CARDS: Card[] = [
  { value: "local", title: "Local", desc: "no key" },
  { value: "openai", title: "OpenAI", desc: "OPENAI_API_KEY" },
  { value: "anthropic", title: "Anthropic", desc: "ANTHROPIC_API_KEY" },
];

async function drive(node: React.JSX.Element, keys: string[]): Promise<void> {
  const { stdin } = render(node);
  await flush();
  for (const k of keys) {
    stdin.write(k);
    await flush();
  }
}

describe("SelectApp (card selector)", () => {
  it("renders every card title + description", async () => {
    const { lastFrame } = render(<SelectApp title="pick" cards={CARDS} onDone={() => {}} />);
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("Local");
    expect(out).toContain("OpenAI");
    expect(out).toContain("ANTHROPIC_API_KEY");
  });

  it("enter selects the highlighted card (first by default)", async () => {
    let picked: string | null = "unset";
    await drive(<SelectApp title="pick" cards={CARDS} onDone={(v) => (picked = v)} />, [ENTER]);
    expect(picked).toBe("local");
  });

  it("arrow-down moves the highlight, then enter selects it", async () => {
    let picked: string | null = "unset";
    await drive(<SelectApp title="pick" cards={CARDS} onDone={(v) => (picked = v)} />, [DOWN, DOWN, ENTER]);
    expect(picked).toBe("anthropic");
  });

  it("up wraps around to the last card", async () => {
    let picked: string | null = "unset";
    await drive(<SelectApp title="pick" cards={CARDS} onDone={(v) => (picked = v)} />, [UP, ENTER]);
    expect(picked).toBe("anthropic");
  });

  it("a number key jumps to and selects that card", async () => {
    let picked: string | null = "unset";
    await drive(<SelectApp title="pick" cards={CARDS} onDone={(v) => (picked = v)} />, ["2"]);
    expect(picked).toBe("openai");
  });

  it("esc cancels with null", async () => {
    let picked: string | null = "unset";
    await drive(<SelectApp title="pick" cards={CARDS} onDone={(v) => (picked = v)} />, [ESC]);
    expect(picked).toBeNull();
  });

  it("windows a tall card list to the terminal height, with markers and a counter", async () => {
    const many: Card[] = Array.from({ length: 20 }, (_, i) => ({
      value: `v${i}`,
      title: `Card ${String(i).padStart(2, "0")}`,
      desc: `description ${i}`,
    }));
    const { lastFrame, stdin } = render(<SelectApp title="pick" cards={many} onDone={() => {}} />);
    await flush();
    const out = lastFrame() ?? "";
    // Default 24 rows → 9 two-line cards visible, the rest announced below.
    expect(out).toContain("Card 00");
    expect(out).toContain("Card 08");
    expect(out).not.toContain("Card 12");
    expect(out).toContain("▼ 11 more");
    expect(out).toContain("1/20");
    // The last card stays REACHABLE: wrap up re-windows to the bottom.
    stdin.write(UP);
    await flush();
    const end = lastFrame() ?? "";
    expect(end).toContain("Card 19");
    expect(end).toContain("▲ 11 more");
    expect(end).toContain("20/20");
  });
});

describe("PromptApp (text input)", () => {
  it("returns the typed value on enter", async () => {
    let val = "unset";
    await drive(<PromptApp label="Model" onDone={(v) => (val = v)} />, ["g", "p", "t", ENTER]);
    expect(val).toBe("gpt");
  });

  it("returns the default when submitted blank", async () => {
    let val = "unset";
    await drive(<PromptApp label="Endpoint" def="http://localhost:11434/v1" onDone={(v) => (val = v)} />, [ENTER]);
    expect(val).toBe("http://localhost:11434/v1");
  });
});
