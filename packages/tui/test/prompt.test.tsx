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
