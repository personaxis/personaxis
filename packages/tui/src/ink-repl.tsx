/**
 * InkScreen — the REPL front-end on Ink 7 (FR.3 adoption; FASE 7 P2 upgrade).
 *
 * A DROP-IN replacement for the pre-Ink `Screen` class: identical public surface
 * (`start`/`stop`/`print`/`setBusy`/`setPhase`/`ask` + the same `ReplHooks`), so the
 * CLI's REPL wiring barely changes. Ink owns the render: the terminated transcript
 * goes to `<Static>` (native scrollback, never re-rendered), with a bounded live
 * region below for the spinner / approval prompt, a live `/` palette, and the
 * status line.
 *
 * FASE 7 P2 makes the app breathe the math (gaps G2+G5):
 *  - a persistent header (compact wordmark + persona + posture);
 *  - a live drift gauge segment fed by the loop's `drift` event (never re-read
 *    from disk);
 *  - the BAND-CROSSING MOMENT: when the loop recompiles because a coordinate
 *    crossed a band, the live region stages the crossing (field pulses, the old
 *    band gives way, the new band's expression prose lands), then commits a
 *    summary line to the transcript. PERSONAXIS_NO_ANIM=1 skips straight to the
 *    committed line (CI-deterministic).
 *  - an in-app DRIFT VIEW (`/drift`, `/dash`): the dashboard drill-down embedded
 *    as a view; Esc returns to chat. The `/` palette stays the universal launcher.
 *  - `suspend(fn)`: hand the raw TTY to a full-screen flow (proof scenes, the
 *    Genesis wizard) and re-mount after; the transcript buffer is reset to avoid
 *    <Static> re-printing history into scrollback (the old lines remain above,
 *    natively).
 */

import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput, type Instance } from "ink";
import TextInput from "ink-text-input";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import type { DriftReport } from "@personaxis/core";
import { Transcript, DriftView } from "./components.js";
import type { ReplHooks, LineRole, SlashItem } from "./screen.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE = ["○", "◔", "◑", "◕", "●", "◉"];
/** Frames the crossing moment plays before committing (80 ms each). */
const MOMENT_FRAMES = 24;

export interface CrossingDetail {
  field: string;
  fromBand: string;
  toBand: string;
  prose: string | null;
}

type ReplView = "chat" | "drift";

interface ReplUiState {
  committed: string[];
  phase: string;
  busy: boolean;
  input: string;
  paletteIndex: number;
  ask: { prompt: string; resolve: (s: string) => void } | null;
  view: ReplView;
  lastDrift: DriftReport | null;
  moment: { crossings: CrossingDetail[] } | null;
  append(line: string): void;
  setBusy(busy: boolean, phase?: string): void;
  setPhase(phase: string): void;
  setInput(s: string): void;
  setPaletteIndex(i: number): void;
  setAsk(a: ReplUiState["ask"]): void;
  setView(v: ReplView): void;
  setDrift(r: DriftReport | null): void;
  setMoment(m: ReplUiState["moment"]): void;
}

function createReplStore(): StoreApi<ReplUiState> {
  return createStore<ReplUiState>((set) => ({
    committed: [],
    phase: "",
    busy: false,
    input: "",
    paletteIndex: 0,
    ask: null,
    view: "chat",
    lastDrift: null,
    moment: null,
    append: (line) => set((s) => ({ committed: [...s.committed, line] })),
    setBusy: (busy, phase = "") => set({ busy, phase }),
    setPhase: (phase) => set({ phase }),
    setInput: (input) => set({ input, paletteIndex: 0 }),
    setPaletteIndex: (paletteIndex) => set({ paletteIndex }),
    setAsk: (ask) => set({ ask }),
    setView: (view) => set({ view }),
    setDrift: (lastDrift) => set({ lastDrift }),
    setMoment: (moment) => set({ moment }),
  }));
}

function paletteMatches(input: string, commands: SlashItem[]): SlashItem[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
}

/** One committed summary line per crossing (also the NO_ANIM fast path). */
export function crossingSummary(c: CrossingDetail): string {
  return `  ↻ band crossing — ${c.field}: ${c.fromBand} ▸ ${c.toBand}${c.prose ? `  «${c.prose}»` : ""}`;
}

/** The staged crossing animation for the live region. Pure of side effects. */
function momentLines(crossings: CrossingDetail[], frame: number): string {
  const pulse = PULSE[frame % PULSE.length];
  const reveal = frame > MOMENT_FRAMES / 2;
  return crossings
    .map((c) => {
      const arrow = frame < MOMENT_FRAMES / 3 ? `${c.fromBand} ─` : `${c.fromBand} ─▸ ${c.toBand}`;
      const prose = reveal && c.prose ? `\n     «${c.prose}»` : "";
      return `  ${pulse} ${c.field}  ${arrow}${prose}`;
    })
    .join("\n");
}

function ReplApp({ store, hooks }: { store: StoreApi<ReplUiState>; hooks: ReplHooks }): React.JSX.Element {
  const committed = useStore(store, (s) => s.committed);
  const busy = useStore(store, (s) => s.busy);
  const phase = useStore(store, (s) => s.phase);
  const input = useStore(store, (s) => s.input);
  const paletteIndex = useStore(store, (s) => s.paletteIndex);
  const ask = useStore(store, (s) => s.ask);
  const view = useStore(store, (s) => s.view);
  const lastDrift = useStore(store, (s) => s.lastDrift);
  const moment = useStore(store, (s) => s.moment);
  const [frame, setFrame] = useState(0);
  const [momentFrame, setMomentFrame] = useState(0);

  // Spinner animation — only ticks while a turn is in flight.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [busy]);

  // The band-crossing moment: play, then commit the summary and clear.
  useEffect(() => {
    if (!moment) return;
    const skip = process.env.PERSONAXIS_NO_ANIM === "1" || process.env.NO_COLOR;
    if (skip) {
      for (const c of moment.crossings) store.getState().append(crossingSummary(c));
      store.getState().setMoment(null);
      return;
    }
    setMomentFrame(0);
    const t = setInterval(() => {
      setMomentFrame((f) => {
        if (f + 1 >= MOMENT_FRAMES) {
          clearInterval(t);
          for (const c of moment.crossings) store.getState().append(crossingSummary(c));
          store.getState().setMoment(null);
          return 0;
        }
        return f + 1;
      });
    }, 80);
    return () => clearInterval(t);
  }, [moment, store]);

  const matches = useMemo(
    () => (busy || ask || view !== "chat" ? [] : paletteMatches(input, hooks.commands)),
    [input, busy, ask, view, hooks.commands],
  );
  const idx = matches.length ? ((paletteIndex % matches.length) + matches.length) % matches.length : 0;

  // Palette navigation + posture cycle + view escape. TextInput owns character
  // keys; we claim ↑/↓ (highlight), Tab (complete), Shift+Tab (posture), and Esc
  // (leave a view). Inside a view, DriftView owns ↑/↓/Enter via its own useInput.
  useInput((_ch, key) => {
    if (ask) return;
    // Inside a view, the view component owns every key (incl. Esc, which walks
    // detail -> list -> chat via onBack); claiming Esc here too would double-fire.
    if (view !== "chat") return;
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

  const live = ask
    ? ask.prompt
    : moment
      ? momentLines(moment.crossings, momentFrame)
      : busy
        ? `  ${SPINNER[frame]} ${phase || "thinking"}`
        : "";

  const statusLine =
    hooks.status() + (lastDrift && hooks.driftSegment ? `  ·  ${hooks.driftSegment(lastDrift)}` : "");

  return (
    <Box flexDirection="column">
      {hooks.header ? <Text>{hooks.header()}</Text> : null}

      {view === "drift" ? (
        <DriftView
          personaPath={hooks.personaPath ?? ""}
          report={lastDrift}
          active={!ask}
          onBack={() => store.getState().setView("chat")}
        />
      ) : (
        <Transcript committed={committed} live={live} />
      )}

      {matches.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {matches.map((m, i) => (
            <Text key={m.name} inverse={i === idx} dimColor={i !== idx}>
              {`/${m.name}`.padEnd(14)} {m.desc}
            </Text>
          ))}
        </Box>
      )}

      <Text>{view === "drift" ? statusLine + "  ·  Esc back" : statusLine}</Text>

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
      ) : view === "chat" ? (
        <Box>
          <Text>{hooks.prompt()}</Text>
          {busy ? <Text dimColor>…</Text> : <TextInput value={input} onChange={store.getState().setInput} onSubmit={runSubmit} />}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Drop-in replacement for `Screen`. Same constructor + methods, so the CLI can swap
 * `new Screen(hooks)` → `new InkScreen(hooks)` with no other change. `waitUntilExit()`
 * lets the caller `await` the session (Ink keeps the process alive until unmount/ctrl+c).
 */
export class InkScreen {
  private store = createReplStore();
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

  /** FASE 7 P2 — the loop's drift event feeds the gauge + the drift view. */
  setDrift(report: DriftReport): void {
    this.store.getState().setDrift(report);
  }

  /** FASE 7 P2 — stage the band-crossing moment (commits a summary after). */
  playMoment(crossings: CrossingDetail[]): void {
    if (crossings.length === 0) return;
    this.store.getState().setMoment({ crossings });
  }

  /** FASE 7 P2 — switch the app to a full-height view (Esc returns to chat). */
  openView(view: "drift" | "chat"): void {
    this.store.getState().setView(view);
  }

  /**
   * FASE 7 P2 — hand the raw TTY to a full-screen flow (proof scenes, the
   * Genesis wizard), then re-mount. The transcript buffer is reset so <Static>
   * does not re-print history into scrollback; the old lines remain above.
   */
  async suspend(fn: () => Promise<void>): Promise<void> {
    this.instance?.unmount();
    this.instance = null;
    try {
      await fn();
    } finally {
      const prior = this.store.getState();
      this.store = createReplStore();
      this.store.getState().setDrift(prior.lastDrift);
      this.instance = render(<ReplApp store={this.store} hooks={this.hooks} />);
      void this.instance.waitUntilExit().then(() => this.hooks.onExit?.());
    }
  }
}

export { ReplApp, createReplStore };
export type { ReplUiState };
