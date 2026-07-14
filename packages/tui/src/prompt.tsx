/**
 * Small Ink prompt kit: a card selector and a text prompt, reused by the CLI's config + onboarding
 * flows so they render as a real TUI (arrow-navigable cards with a description each), consistent
 * with the REPL's Ink surface. Generic on purpose (no CLI imports), so `tui` stays a leaf package.
 *
 * Both resolve AFTER Ink unmounts, so callers can render one prompt after another in the same
 * process without two Ink instances overlapping on stdin.
 */

import React, { useState, useRef } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";

export interface Card {
  value: string;
  title: string;
  desc?: string;
}

/** Exported for tests (ink-testing-library); prefer `selectCards` in app code. */
export function SelectApp({ title, cards, footer, onDone }: { title: string; cards: Card[]; footer?: string; onDone: (v: string | null) => void }): React.JSX.Element {
  const { exit } = useApp();
  const [i, setI] = useState(0);
  const settled = useRef(false);
  const finish = (v: string | null): void => {
    if (settled.current) return;
    settled.current = true;
    onDone(v);
    exit();
  };
  useInput((input, key) => {
    if (key.upArrow) setI((p) => (p - 1 + cards.length) % cards.length);
    else if (key.downArrow) setI((p) => (p + 1) % cards.length);
    else if (key.return) finish(cards[i]?.value ?? null);
    else if (key.escape) finish(null);
    else {
      const n = Number.parseInt(input, 10);
      if (Number.isInteger(n) && n >= 1 && n <= cards.length) finish(cards[n - 1].value);
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{footer ?? "↑/↓ move · 1-9 jump · enter select · esc cancel"}</Text>
      <Box height={1} />
      {cards.map((c, idx) => (
        <Box key={c.value} flexDirection="column">
          <Text color={idx === i ? "cyanBright" : undefined} bold={idx === i}>
            {(idx === i ? "❯ " : "  ") + c.title}
          </Text>
          {c.desc ? <Text dimColor>{"      " + c.desc}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

/** Render a card list; resolves the chosen value on enter (or a number key), or null on esc. */
export function selectCards(title: string, cards: Card[], footer?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const app = render(<SelectApp title={title} cards={cards} footer={footer} onDone={(v) => (result = v)} />);
    void app.waitUntilExit().then(() => resolve(result));
  });
}

/** Exported for tests (ink-testing-library); prefer `promptText` in app code. */
export function PromptApp({ label, def, onDone }: { label: string; def?: string; onDone: (v: string) => void }): React.JSX.Element {
  const { exit } = useApp();
  const [val, setVal] = useState("");
  const submit = (v: string): void => {
    onDone((v.trim() || def || "").trim());
    exit();
  };
  return (
    <Box>
      <Text>{"  " + label + " "}</Text>
      {def ? <Text dimColor>{`[${def}] `}</Text> : null}
      <TextInput value={val} onChange={setVal} onSubmit={submit} />
    </Box>
  );
}

/** Render a single-line text prompt; resolves the entered value (or the default if left blank). */
export function promptText(label: string, def?: string): Promise<string> {
  return new Promise((resolve) => {
    let result = def ?? "";
    const app = render(<PromptApp label={label} def={def} onDone={(v) => (result = v)} />);
    void app.waitUntilExit().then(() => resolve(result));
  });
}
