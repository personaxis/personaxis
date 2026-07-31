/**
 * InkScreen, the REPL front-end on Ink 7 (FR.3 adoption; FASE 7 P2 upgrade).
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
import { useTerminalSize, windowFor, fitAnsi, wrapAnsi } from "./viewport.js";
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

/** V5.P1.1: any registered view name (plus the built-ins "chat" and "drift"). */
type ReplView = string;

/** Props every registered full-height view receives from the REPL app shell. */
export interface ReplViewProps {
  personaPath: string;
  /** False while an approval prompt owns the keyboard. */
  active: boolean;
  /** Return to chat (the view should also call this on Esc from its top level). */
  onBack: () => void;
  /** Free-form parameters passed by openView (e.g. the initial tab). */
  params?: Record<string, unknown>;
}

/**
 * The view registry (V5.P1.1): miniapps (settings, resume, audit, review, memory,
 * skills, persona, proof) register a component once; `/command` handlers open them
 * by name via `InkScreen.openView(name, params)`. Views render as a full-height
 * overlay in place of the transcript; the committed scrollback is untouched.
 */
const VIEW_REGISTRY = new Map<string, React.ComponentType<ReplViewProps>>();

export function registerReplView(name: string, component: React.ComponentType<ReplViewProps>): void {
  VIEW_REGISTRY.set(name, component);
}

export function hasReplView(name: string): boolean {
  return VIEW_REGISTRY.has(name);
}

/** A committed transcript entry. The role drives the chrome (persona replies get
 *  a bubble, dividers a rule); plain strings stay accepted for compatibility. */
export interface TranscriptItem {
  /** Wrapped at commit width. Kept for consumers that read the rendered form. */
  text: string;
  role: LineRole;
  /** Terminal width at COMMIT time. */
  width?: number;
  /**
   * The UNWRAPPED line.
   *
   * Wrapping was frozen at commit width so that resizing could not reflow history
   * (a reflow used to corrupt the screen). Now that a resize repaints everything
   * from this store, the raw text is what makes the app actually responsive:
   * widening the window re-wraps the conversation to the new width instead of
   * leaving it boxed into whatever width the session started at.
   */
  raw: string;
}

interface ReplUiState {
  committed: TranscriptItem[];
  phase: string;
  busy: boolean;
  input: string;
  paletteIndex: number;
  ask: { prompt: string; resolve: (s: string) => void } | null;
  view: ReplView;
  viewParams: Record<string, unknown> | undefined;
  lastDrift: DriftReport | null;
  moment: { crossings: CrossingDetail[] } | null;
  /** Bumped to force a re-render when non-React state (the session ctx) changed (V7.A2). */
  nonce: number;
  /**
   * Bumped on every terminal resize. Used as the <Static> key, which makes Ink
   * discard `fullStaticOutput` and re-emit the WHOLE transcript: after a resize
   * clears the screen, this is what paints the conversation back.
   */
  epoch: number;
  refresh(): void;
  bumpEpoch(): void;
  append(line: string, role?: LineRole): void;
  setBusy(busy: boolean, phase?: string): void;
  setPhase(phase: string): void;
  setInput(s: string): void;
  setPaletteIndex(i: number): void;
  setAsk(a: ReplUiState["ask"]): void;
  setView(v: ReplView, params?: Record<string, unknown>): void;
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
    viewParams: undefined,
    lastDrift: null,
    moment: null,
    nonce: 0,
    epoch: 0,
    refresh: () => set((s) => ({ nonce: s.nonce + 1 })),
    bumpEpoch: () => set((s) => ({ epoch: s.epoch + 1, nonce: s.nonce + 1 })),
    // V7.A3: wrap ONCE, at the width the line is printed at. Ink then prints rows that
    // never wrap, so its line-count based erase stays correct through any resize.
    append: (line, role = "system") =>
      set((s) => {
        const width = Math.max(24, (process.stdout.columns ?? 80) - 2);
        const text = wrapAnsi(line, width).join("\n");
        return { committed: [...s.committed, { text, role, width, raw: line }] };
      }),
    setBusy: (busy, phase = "") => set({ busy, phase }),
    setPhase: (phase) => set({ phase }),
    setInput: (input) => set({ input, paletteIndex: 0 }),
    setPaletteIndex: (paletteIndex) => set({ paletteIndex }),
    setAsk: (ask) => set({ ask }),
    setView: (view, viewParams) => set({ view, viewParams }),
    setDrift: (lastDrift) => set({ lastDrift }),
    setMoment: (moment) => set({ moment }),
  }));
}

export function paletteMatches(input: string, commands: SlashItem[]): SlashItem[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).toLowerCase();
  // Every match stays reachable; the RENDER windows the list to the terminal height
  // (the old hard slice(0, 8) made commands 9+ invisible AND unreachable by arrow).
  //
  // Absorbed commands are hidden from the BROWSE list (bare `/`) and revealed as
  // soon as you type toward one, so `/val` still finds `validate`. Browsing shows
  // the consolidated surface; typing a name you remember always works.
  const matches = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  return q === "" ? matches.filter((c) => !c.hidden) : matches;
}

/** One committed summary line per crossing (also the NO_ANIM fast path). */
export function crossingSummary(c: CrossingDetail): string {
  return `  ↻ band crossing, ${c.field}: ${c.fromBand} ▸ ${c.toBand}${c.prose ? `  «${c.prose}»` : ""}`;
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
  const epoch = useStore(store, (s) => s.epoch);
  const busy = useStore(store, (s) => s.busy);
  const phase = useStore(store, (s) => s.phase);
  const input = useStore(store, (s) => s.input);
  const paletteIndex = useStore(store, (s) => s.paletteIndex);
  const ask = useStore(store, (s) => s.ask);
  const view = useStore(store, (s) => s.view);
  const viewParams = useStore(store, (s) => s.viewParams);
  const lastDrift = useStore(store, (s) => s.lastDrift);
  const moment = useStore(store, (s) => s.moment);
  // Subscribing to the nonce is what makes `refresh()` repaint the header/status after
  // a change that lives outside React (the sandbox posture on the session ctx).
  useStore(store, (s) => s.nonce);
  const [frame, setFrame] = useState(0);
  const [momentFrame, setMomentFrame] = useState(0);

  // Spinner animation, only ticks while a turn is in flight.
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
      for (const c of moment.crossings) store.getState().append(crossingSummary(c), "activity");
      store.getState().setMoment(null);
      return;
    }
    setMomentFrame(0);
    const t = setInterval(() => {
      setMomentFrame((f) => {
        if (f + 1 >= MOMENT_FRAMES) {
          clearInterval(t);
          for (const c of moment.crossings) store.getState().append(crossingSummary(c), "activity");
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

  // Window the palette to the terminal (F0.2): header + transcript tail + status +
  // input + the ▲/▼ markers need breathing room, so the list gets rows-9 at most.
  const { columns, rows } = useTerminalSize();
  const paletteMax = Math.max(3, rows - 9);
  const win = windowFor(matches.length, idx, paletteMax);

  // Palette navigation + posture cycle + view escape. TextInput owns character
  // keys; we claim ↑/↓ (highlight), Tab (complete), Shift+Tab (posture), and Esc
  // (leave a view). Inside a view, DriftView owns ↑/↓/Enter via its own useInput.
  useInput((ch, key) => {
    if (ask) return;
    // Ctrl+K opens the Command Center from anywhere (command-palette convention).
    if (key.ctrl && (ch === "k" || ch === "")) {
      void hooks.onOpenMenu?.();
      return;
    }
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
    // With the `/` palette open, Enter runs the HIGHLIGHTED command, not the
    // partial text typed so far (Tab still just autocompletes it). Once args are
    // typed (a space appears) the palette has no matches, so the raw line is sent.
    const line = matches.length ? `/${matches[idx].name}` : value.trim();
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
      {view === "drift" ? (
        <DriftView
          personaPath={hooks.personaPath ?? ""}
          report={lastDrift}
          active={!ask}
          onBack={() => store.getState().setView("chat")}
          qualitative={hooks.qualitativeDrift?.() ?? []}
        />
      ) : view !== "chat" && VIEW_REGISTRY.has(view) ? (
        React.createElement(VIEW_REGISTRY.get(view)!, {
          personaPath: hooks.personaPath ?? "",
          active: !ask,
          onBack: () => store.getState().setView("chat"),
          params: viewParams,
        })
      ) : (
        <Transcript committed={committed} live={live} epoch={epoch} />
      )}

      {matches.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {win.above > 0 ? <Text dimColor>{`▲ ${win.above} more`}</Text> : null}
          {matches.slice(win.start, win.end).map((m, i) => {
            const gi = win.start + i;
            return (
              <Text key={m.name} inverse={gi === idx} dimColor={gi !== idx}>
                {fitAnsi(`/${m.name}`.padEnd(14) + " " + (m.desc ?? ""), Math.max(20, columns - 4))}
              </Text>
            );
          })}
          {win.below > 0 ? <Text dimColor>{`▼ ${win.below} more`}</Text> : null}
          {matches.length > paletteMax ? <Text dimColor>{`${idx + 1}/${matches.length}`}</Text> : null}
        </Box>
      )}

      {/* The header sits BELOW <Static>, immediately above the input it belongs to.
          Anything rendered ABOVE a <Static> is re-emitted into the scrollback every
          time Ink repaints instead of being erased, so this line stacked up on every
          resize:  "─ Clio (main) · cli · workspace-write" over and over down the
          screen. Ink writes static output above the dynamic region by construction;
          putting live UI before it is the antipattern. It reads the same as it did,
          since the header is the input's chrome, not a banner. */}
      {hooks.header && view === "chat" ? (
        <Text>{fitAnsi(hooks.header(), Math.max(20, columns - 2))}</Text>
      ) : null}

      {ask ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} width={Math.max(24, columns - 2)}>
          <Text color="yellow">{"? "}</Text>
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
        <Box
          borderStyle="round"
          borderColor={busy ? "yellow" : "gray"}
          paddingX={1}
          width={Math.max(24, columns - 2)}
        >
          <Text>{hooks.prompt()}</Text>
          {busy ? <Text dimColor>…</Text> : <TextInput value={input} onChange={store.getState().setInput} onSubmit={runSubmit} />}
        </Box>
      ) : null}

      {/* TRUNCATED, never wrapped. A status line longer than the terminal wraps to a
          second row; Ink still counts it as one when it erases the dynamic region, so
          on every resize the leftovers pile up ("─ Clio (main) · cli · workspace-write"
          repeated down the screen). Cutting it to the exact width keeps the region one
          row tall, which is the invariant Ink's erase depends on. */}
      <Text>{fitAnsi(view === "drift" ? statusLine + "  ·  Esc back" : statusLine, Math.max(20, columns - 1))}</Text>
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
  /**
   * Resolved ONLY when the session really ends (ctrl+c, /exit, stop()).
   *
   * The REPL awaits this to stay alive. It cannot await the Ink instance
   * directly, because `clearScreen` and `suspend` unmount and re-mount to reset
   * the scrollback: that resolved the instance's promise, the REPL fell through
   * its await and quit. `/resume` did exactly this, so rebuilding a conversation
   * dropped you back to the shell the moment it finished printing.
   */
  private exited = false;
  private exitResolve: (() => void) | undefined;
  private readonly exitPromise = new Promise<void>((resolve) => {
    this.exitResolve = resolve;
  });

  /**
   * @param renderOptions passed straight to Ink's `render`. Ink keeps ONE live
   *        renderer per stdout, so tests must hand in their own stream to
   *        exercise mount/unmount without fighting whatever else is on the real
   *        one. Production passes nothing and gets process.stdout.
   */
  constructor(
    private readonly hooks: ReplHooks,
    private readonly renderOptions?: Parameters<typeof render>[1],
  ) {}

  private mount(): Instance {
    return render(<ReplApp store={this.store} hooks={this.hooks} />, this.renderOptions);
  }

  /**
   * Treat an unmount as an EXIT only if it was not a re-mount. Compares identity
   * rather than a flag: `unmount()` is synchronous but its promise settles on a
   * later microtask, so a boolean set around the call would already be back to
   * false by the time this runs.
   */
  private watch(instance: Instance): void {
    void instance.waitUntilExit().then(() => {
      if (this.instance !== instance || this.exited) return; // re-mounted, still alive
      this.exited = true;
      this.exitResolve?.();
      this.hooks.onExit?.();
    });
  }

  /**
   * Wipe the dynamic region on EVERY resize, not just the ones Ink handles.
   *
   * Ink clears only when the terminal gets NARROWER (`ink/build/ink.js`: `if
   * (currentWidth < this.lastTerminalWidth) this.log.clear()`). Widening leaves
   * the previous frame on screen, and Ink then erases by the line COUNT it
   * remembers, which no longer matches how many rows those lines occupy at the
   * new width. The leftovers stack: dragging a window printed the header again
   * and again down the screen.
   *
   * Dragging fires a burst of these; `clear()` is cheap and idempotent, so a
   * burst simply clears repeatedly and the last redraw wins.
   */
  private readonly onResize = (): void => {
    // Erase the VISIBLE screen, not a line count.
    //
    // Every count-based erase (Ink's own included) breaks here, because the real
    // damage is done by the terminal, not by us: narrowing re-wraps the lines
    // already printed, so the live region ends up somewhere other than where Ink
    // last left it, and erasing "the last N lines" wipes the wrong rows while the
    // old frame survives. Dragging a window therefore printed the header again
    // and again.
    //
    // 2J AND 3J: screen and scrollback, because the repaint below rewrites the
    // entire transcript. Clearing only the screen is what stacked the history:
    // the copy above the fold survived and the repaint added another, so every
    // drag left one more block of the conversation to scroll past. Since the
    // repaint reproduces the transcript in full, dropping the old scrollback
    // loses nothing of the session and leaves exactly one copy.
    //
    // Only when the width ACTUALLY changed. Terminals emit a resize on startup
    // (and on focus, and on tab switches in some emulators); acting on those wiped
    // the screen before the user had touched anything, taking the startup banner
    // with it, which looked like the logo had stopped rendering.
    const cols = (this.renderOptions as { stdout?: NodeJS.WriteStream } | undefined)?.stdout?.columns
      ?? process.stdout.columns
      ?? 80;
    if (cols === this.lastCols) return;
    this.lastCols = cols;

    // Dragging fires a burst of resizes; act once things settle, or the screen
    // flickers through a full repaint per pixel of drag.
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      const out = (this.renderOptions as { stdout?: NodeJS.WriteStream } | undefined)?.stdout ?? process.stdout;
      out.write("\x1b[2J\x1b[3J\x1b[H");
      this.instance?.clear();
      // Bumping the epoch re-keys <Static>, which makes Ink forget it already
      // wrote the transcript and emit all of it again. Without this the screen we
      // just cleared would come back holding only the input box.
      this.store.getState().bumpEpoch();
    }, 120);
  };

  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Width at the last handled resize; a resize to the same width is not one. */
  private lastCols: number | undefined;

  private watchResize(): void {
    const out = (this.renderOptions as { stdout?: NodeJS.WriteStream } | undefined)?.stdout ?? process.stdout;
    if (this.resizeBound) return;
    this.resizeBound = out;
    this.lastCols = out.columns ?? process.stdout.columns ?? 80;
    out.on?.("resize", this.onResize);
  }

  private unwatchResize(): void {
    clearTimeout(this.resizeTimer);
    this.resizeBound?.off?.("resize", this.onResize);
    this.resizeBound = undefined;
  }

  private resizeBound: NodeJS.WriteStream | undefined;

  start(): void {
    this.instance = this.mount();
    this.watch(this.instance);
    this.watchResize();
  }

  async waitUntilExit(): Promise<void> {
    await this.exitPromise;
  }

  stop(): void {
    this.unwatchResize();
    this.instance?.unmount();
  }

  print(text: string, role: LineRole = "system"): void {
    this.store.getState().append(text, role);
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

  /** FASE 7 P2, the loop's drift event feeds the gauge + the drift view. */
  setDrift(report: DriftReport): void {
    this.store.getState().setDrift(report);
  }

  /** FASE 7 P2, stage the band-crossing moment (commits a summary after). */
  playMoment(crossings: CrossingDetail[]): void {
    if (crossings.length === 0) return;
    this.store.getState().setMoment({ crossings });
  }

  /** Switch the app to a full-height view (Esc returns to chat). Any name registered
   *  via `registerReplView` works; "drift" and "chat" are built in (V5.P1.1). */
  openView(view: string, params?: Record<string, unknown>): void {
    this.store.getState().setView(view, params);
  }

  /** Repaint after state that lives OUTSIDE React changed (V7.A2: shift+tab posture). */
  refresh(): void {
    this.store.getState().refresh();
  }

  /**
   * V7.A6: wipe the screen and the committed buffer, for switching to a DIFFERENT
   * conversation. Resuming a session must rebuild that chat, not append it under the
   * one you were in ("desaparece todo lo actual ... todo se reconstruye"). Ink's
   * <Static> only ever appends, so the buffer is reset and the terminal cleared;
   * the app is re-mounted so nothing is re-emitted from the previous tree.
   */
  clearScreen(): void {
    const outgoing = this.instance;
    this.instance = null; // marks the unmount below as a RE-MOUNT, not an exit
    outgoing?.unmount();
    const prior = this.store.getState();
    this.store = createReplStore();
    this.store.getState().setDrift(prior.lastDrift);
    // Written to the CONFIGURED stream, not process.stdout: otherwise an injected
    // output (tests, or any embedder) gets its screen cleared by someone else's.
    const out = (this.renderOptions as { stdout?: NodeJS.WriteStream } | undefined)?.stdout ?? process.stdout;
    out.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback + home
    this.instance = this.mount();
    this.watch(this.instance);
  }

  /**
   * FASE 7 P2, hand the raw TTY to a full-screen flow (proof scenes, the
   * Genesis wizard), then re-mount. The transcript buffer is reset so <Static>
   * does not re-print history into scrollback; the old lines remain above.
   */
  async suspend(fn: () => Promise<void>): Promise<void> {
    const outgoing = this.instance;
    this.instance = null; // same contract as clearScreen: this unmount is not an exit
    outgoing?.unmount();
    try {
      await fn();
    } finally {
      const prior = this.store.getState();
      this.store = createReplStore();
      this.store.getState().setDrift(prior.lastDrift);
      this.instance = this.mount();
      this.watch(this.instance);
    }
  }
}

export { ReplApp, createReplStore };
export type { ReplUiState };
