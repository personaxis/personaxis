/**
 * InkScreen — the REPL front-end on Ink 7 (finishes the FR.3 adoption).
 *
 * A DROP-IN replacement for the pre-Ink `Screen` class: identical public surface
 * (`start`/`stop`/`print`/`setBusy`/`setPhase`/`ask` + the same `ReplHooks`), so the
 * CLI's REPL wiring barely changes. Ink owns the render: the terminated transcript
 * goes to `<Static>` (native scrollback, never re-rendered — the Ink-documented
 * mitigation for long histories), with a bounded live region below for the spinner /
 * approval prompt, a live `/` command palette, and the status line. Pre-colored chalk
 * strings pass straight through `<Text>`, so every existing role color/icon is kept.
 */

import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput, type Instance } from "ink";
import TextInput from "ink-text-input";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { Transcript } from "./components.js";
import type { ReplHooks, LineRole, SlashItem } from "./screen.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface ReplUiState {
  committed: string[];
  phase: string;
  busy: boolean;
  input: string;
  paletteIndex: number;
  ask: { prompt: string; resolve: (s: string) => void } | null;
  append(line: string): void;
  setBusy(busy: boolean, phase?: string): void;
  setPhase(phase: string): void;
  setInput(s: string): void;
  setPaletteIndex(i: number): void;
  setAsk(a: ReplUiState["ask"]): void;
}

function createReplStore(): StoreApi<ReplUiState> {
  return createStore<ReplUiState>((set) => ({
    committed: [],
    phase: "",
    busy: false,
    input: "",
    paletteIndex: 0,
    ask: null,
    append: (line) => set((s) => ({ committed: [...s.committed, line] })),
    setBusy: (busy, phase = "") => set({ busy, phase }),
    setPhase: (phase) => set({ phase }),
    setInput: (input) => set({ input, paletteIndex: 0 }),
    setPaletteIndex: (paletteIndex) => set({ paletteIndex }),
    setAsk: (ask) => set({ ask }),
  }));
}

function paletteMatches(input: string, commands: SlashItem[]): SlashItem[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
}

function ReplApp({ store, hooks }: { store: StoreApi<ReplUiState>; hooks: ReplHooks }): React.JSX.Element {
  const committed = useStore(store, (s) => s.committed);
  const busy = useStore(store, (s) => s.busy);
  const phase = useStore(store, (s) => s.phase);
  const input = useStore(store, (s) => s.input);
  const paletteIndex = useStore(store, (s) => s.paletteIndex);
  const ask = useStore(store, (s) => s.ask);
  const [frame, setFrame] = useState(0);

  // Spinner animation — only ticks while a turn is in flight.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [busy]);

  const matches = useMemo(() => (busy || ask ? [] : paletteMatches(input, hooks.commands)), [input, busy, ask, hooks.commands]);
  const idx = matches.length ? ((paletteIndex % matches.length) + matches.length) % matches.length : 0;

  // Palette navigation + posture cycle. TextInput owns character keys; we only
  // claim ↑/↓ (move highlight), Tab (complete), and Shift+Tab (cycle posture).
  useInput((_ch, key) => {
    if (ask) return;
    if (key.tab && key.shift) {
      hooks.onCycleMode?.();
      return;
    }
    if (matches.length) {
      if (key.upArrow) store.getState().setPaletteIndex(idx - 1);
      else if (key.downArrow) store.getState().setPaletteIndex(idx + 1);
      else if (key.tab) store.getState().setInput(`/${matches[idx].name} `);
    }
  });

  const runSubmit = async (value: string): Promise<void> => {
    const line = value.trim();
    store.getState().setInput("");
    if (line) await hooks.onSubmit(line);
  };

  const live = ask ? ask.prompt : busy ? `  ${SPINNER[frame]} ${phase || "thinking"}` : "";

  return (
    <Box flexDirection="column">
      <Transcript committed={committed} live={live} />

      {matches.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {matches.map((m, i) => (
            <Text key={m.name} inverse={i === idx} dimColor={i !== idx}>
              {`/${m.name}`.padEnd(14)} {m.desc}
            </Text>
          ))}
        </Box>
      )}

      <Text>{hooks.status()}</Text>

      {ask ? (
        <Box>
          <Text>{"  "}</Text>
          <TextInput
            value={input}
            onChange={store.getState().setInput}
            onSubmit={(v) => {
              const resolve = ask.resolve;
              store.getState().setAsk(null);
              store.getState().setInput("");
              resolve(v.trim());
            }}
          />
        </Box>
      ) : (
        <Box>
          <Text>{hooks.prompt()}</Text>
          {busy ? <Text dimColor>…</Text> : <TextInput value={input} onChange={store.getState().setInput} onSubmit={runSubmit} />}
        </Box>
      )}
    </Box>
  );
}

/**
 * Drop-in replacement for `Screen`. Same constructor + methods, so the CLI can swap
 * `new Screen(hooks)` → `new InkScreen(hooks)` with no other change. `waitUntilExit()`
 * lets the caller `await` the session (Ink keeps the process alive until unmount/ctrl+c).
 */
export class InkScreen {
  private readonly store = createReplStore();
  private instance: Instance | null = null;

  constructor(private readonly hooks: ReplHooks) {}

  start(): void {
    this.instance = render(<ReplApp store={this.store} hooks={this.hooks} />);
    void this.instance.waitUntilExit().then(() => this.hooks.onExit?.());
  }

  async waitUntilExit(): Promise<void> {
    await this.instance?.waitUntilExit();
  }

  stop(): void {
    this.instance?.unmount();
  }

  print(text: string, _role: LineRole = "system"): void {
    this.store.getState().append(text);
  }

  setBusy(busy: boolean, phase = ""): void {
    this.store.getState().setBusy(busy, phase);
  }

  setPhase(phase: string): void {
    this.store.getState().setPhase(phase);
  }

  ask(prompt: string): Promise<string> {
    return new Promise((resolve) => this.store.getState().setAsk({ prompt, resolve }));
  }
}

export { ReplApp, createReplStore };
export type { ReplUiState };
