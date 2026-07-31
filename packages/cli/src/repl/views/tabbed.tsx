/**
 * Tabbed miniapp host, v2 (V6.1): the generic host every Settings-style view is
 * built on, now with real interaction instead of passive text.
 *
 * A provider supplies tab names and, per tab, a list of `TabLine`s: plain
 * strings render as text; `TabRow` objects are SELECTABLE rows (label + value +
 * optional action). The host renders the navbar, a scroll window, a cursor over
 * the selectable rows, and the key hints; it owns the keyboard:
 *
 *   left/right (or Tab)  switch tabs (at the root level)
 *   up/down              move the cursor over selectable rows (or scroll when
 *                        the tab has no rows, the V5 text-only behavior)
 *   Enter                run the focused row's action: cycle/edit a value, show
 *                        a toast, or DRILL DOWN into a sub-list
 *   Esc / q / left       pop the drill-down; at the root, return to chat
 *   1..9                 jump to a tab
 *
 * Lines recompute on every render (so edits show immediately), and a 1 s tick
 * keeps live data fresh (disabled under PERSONAXIS_NO_ANIM for deterministic
 * tests).
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import chalk from "chalk";
import { NavBar, registerReplView, type ReplViewProps } from "@personaxis/tui/ink";
import { useTerminalSize, fitAnsi } from "@personaxis/tui/viewport";

/** A selectable row. `onEnter` may edit state (return a toast), or open a drill. */
export interface TabRow {
  label: string;
  value?: string;
  /** Footer hint shown while this row is focused (e.g. "Enter cycles the posture"). */
  hint?: string;
  onEnter?: () => TabAction | void | Promise<TabAction | void>;
}

export type TabLine = string | TabRow;

export type TabAction =
  | { kind: "toast"; text: string }
  | { kind: "drill"; title: string; lines: () => TabLine[] };

export const isRow = (l: TabLine): l is TabRow => typeof l !== "string";

/** Plain-text projection of any TabLine (the pipe/no-TTY fallback path). */
export const lineText = (l: TabLine): string =>
  typeof l === "string" ? l : `  ${chalk.cyan(l.label.padEnd(14))} ${l.value ?? ""}`;

export interface TabbedProvider {
  title: string;
  tabs: string[];
  lines(tab: number): TabLine[];
  /**
   * How often this view redraws, in ms. The default of 1 s is right for data that
   * changes at human speed (cost, drift, daemons). A view that ANIMATES declares a
   * shorter one: the Persona view draws the aura, and at 1 s per frame the figure looks
   * static no matter how well it is drawn, which is the host's fault, not the drawing's.
   * Kept per-provider so the text-only views are not re-rendered four times a second.
   */
  tickMs?: number;
  /**
   * PERSONA SCOPE (V7.C1). A provider that can show more than one persona declares its
   * scopes here; the host then renders a persistent selector under the title and owns the
   * key that cycles it, so EVERY miniapp gets the same control in the same place instead
   * of each command inventing its own (Design note: "todas estas opciones la mayoria
   * funcionan sobre el ai persona main, no sobre los ai sub personas").
   *
   * The provider keeps the selection itself (its `lines` read it), which is why this is a
   * getter/setter pair rather than host state: the same selection must survive a tab
   * change, a drill-down and a redraw.
   */
  scopes?: () => string[];
  activeScope?: () => number;
  onScope?: (index: number) => void;
}

function initialTab(provider: TabbedProvider, params?: Record<string, unknown>): number {
  const t = params?.tab;
  if (typeof t === "number") return Math.max(0, Math.min(provider.tabs.length - 1, t));
  if (typeof t === "string") {
    const i = provider.tabs.findIndex((x) => x.toLowerCase() === t.toLowerCase());
    if (i >= 0) return i;
  }
  return 0;
}

/** Indexes of the selectable rows within a line list. */
const rowIndexes = (lines: TabLine[]): number[] =>
  lines.map((l, i) => (isRow(l) ? i : -1)).filter((i) => i >= 0);

interface Drill {
  title: string;
  lines: () => TabLine[];
  cursor: number;
}

export function registerTabbedView(name: string, provider: TabbedProvider): React.ComponentType<ReplViewProps> {
  function TabbedView({ active, onBack, params }: ReplViewProps): React.JSX.Element {
    const [tab, setTab] = useState(() => initialTab(provider, params));
    const [scroll, setScroll] = useState(0);
    const [cursor, setCursor] = useState(0); // index into the current lines array
    const [stack, setStack] = useState<Drill[]>([]);
    const [toast, setToast] = useState<string | null>(null);
    const [, setTick] = useState(0);

    // Re-honor the requested tab when the view is re-opened with new params.
    useEffect(() => {
      setTab(initialTab(provider, params));
      setScroll(0);
      setCursor(0);
      setStack([]);
      setToast(null);
    }, [params]);

    // Live refresh (skipped when animations are off, keeps tests deterministic).
    useEffect(() => {
      if (process.env.PERSONAXIS_NO_ANIM === "1") return;
      const t = setInterval(() => setTick((x) => x + 1), provider.tickMs ?? 1000);
      return () => clearInterval(t);
    }, []);

    const top = stack[stack.length - 1];
    const lines = top ? top.lines() : provider.lines(tab);
    const rows = rowIndexes(lines);
    const curLineIdx = rows.length ? rows[Math.min(cursor, rows.length - 1)] : -1;

    const resetForTab = (t: number): void => {
      setTab(t);
      setScroll(0);
      setCursor(0);
      setToast(null);
    };

    const applyAction = (a: TabAction | void): void => {
      if (!a) return void setToast(null);
      if (a.kind === "toast") return void setToast(a.text);
      setStack((s) => [...s, { title: a.title, lines: a.lines, cursor: 0 }]);
      setCursor(0);
      setScroll(0);
      setToast(null);
    };

    const pop = (): void => {
      setStack((s) => s.slice(0, -1));
      setCursor(0);
      setScroll(0);
      setToast(null);
    };

    useInput(
      (ch, key) => {
        if (key.escape || ch === "q") return void (stack.length ? pop() : onBack());
        if (key.leftArrow) {
          if (stack.length) return void pop();
          return void resetForTab((tab + provider.tabs.length - 1) % provider.tabs.length);
        }
        if ((key.rightArrow || key.tab) && !stack.length)
          return void resetForTab((tab + 1) % provider.tabs.length);
        if (key.upArrow) {
          if (rows.length) return void setCursor((c) => Math.max(0, c - 1));
          return void setScroll((s) => Math.max(0, s - 1));
        }
        if (key.downArrow) {
          if (rows.length) return void setCursor((c) => Math.min(rows.length - 1, c + 1));
          return void setScroll((s) => s + 1);
        }
        if (key.return && curLineIdx >= 0) {
          const row = lines[curLineIdx] as TabRow;
          if (!row.onEnter) return;
          const r = row.onEnter();
          if (r && typeof (r as Promise<TabAction | void>).then === "function") {
            void (r as Promise<TabAction | void>).then(applyAction);
          } else {
            applyAction(r as TabAction | void);
          }
          return;
        }
        // V7.C1: `p` cycles the persona this view is scoped to, `P` goes back. It works
        // at any depth (including inside a drill-down) because "which persona am I
        // looking at" is never a sub-question of where you are in the view.
        const scopeList = provider.scopes?.() ?? [];
        if (scopeList.length > 1 && (ch === "p" || ch === "P")) {
          const cur = provider.activeScope?.() ?? 0;
          const next = ch === "p" ? (cur + 1) % scopeList.length : (cur + scopeList.length - 1) % scopeList.length;
          provider.onScope?.(next);
          setCursor(0);
          setScroll(0);
          setToast(`persona → ${scopeList[next]}`);
          return;
        }
        if (!stack.length) {
          const n = Number(ch);
          if (Number.isInteger(n) && n >= 1 && n <= provider.tabs.length) return void resetForTab(n - 1);
        }
      },
      { isActive: active },
    );

    const { rows: termRows, columns } = useTerminalSize();
    // V6.5: every line clips to the terminal width (ANSI-aware), so long values
    // never wrap and corrupt the frame; narrow terminals stay readable.
    const clip = (s: string): string => fitAnsi(s, Math.max(20, columns - 2));
    const budget = Math.max(4, termRows - 8);
    // Keep the focused row inside the window; otherwise honor manual scroll.
    let start = Math.max(0, Math.min(scroll, Math.max(0, lines.length - budget)));
    if (curLineIdx >= 0) {
      if (curLineIdx < start) start = curLineIdx;
      else if (curLineIdx >= start + budget) start = curLineIdx - budget + 1;
    }
    const visible = lines.slice(start, start + budget);
    const focused = curLineIdx >= 0 ? (lines[curLineIdx] as TabRow) : null;

    const scopeLabels = provider.scopes?.() ?? [];
    const scopeIndex = provider.activeScope?.() ?? 0;

    const hint = toast
      ? chalk.green(`  ${toast}`)
      : focused?.hint
        ? chalk.dim(`  ${focused.hint}`)
        : chalk.dim(
            stack.length
              ? "  ↑/↓ move · Enter open · Esc/← back"
              : rows.length
                ? "  ←/→ tabs · ↑/↓ move · Enter open/edit · Esc back"
                : "  ←/→ tabs · ↑/↓ scroll · Esc back",
          );

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{`  ${provider.title}${stack.length ? chalk.dim(" › " + stack.map((d) => d.title).join(" › ")) : ""}`}</Text>
        {scopeLabels.length > 1 ? (
          <Text>
            {clip(
              `  ${chalk.dim("persona")}  ` +
                scopeLabels
                  .map((s, i) => (i === scopeIndex ? chalk.cyan.bold(`[${s}]`) : chalk.dim(s)))
                  .join(chalk.dim(" · ")) +
                chalk.dim("   p switches"),
            )}
          </Text>
        ) : null}
        {!stack.length ? (
          <Box marginLeft={2}>
            <NavBar tabs={provider.tabs} active={tab} />
          </Box>
        ) : null}
        <Box flexDirection="column">
          {start > 0 ? <Text dimColor>{`  ▲ ${start} more`}</Text> : null}
          {visible.map((l, i) => {
            const gi = start + i;
            if (isRow(l)) {
              const on = gi === curLineIdx;
              const marker = on ? chalk.cyan("❯ ") : "  ";
              const label = on ? chalk.cyan.bold(l.label.padEnd(14)) : chalk.cyan(l.label.padEnd(14));
              return <Text key={gi}>{clip(`${marker}${label} ${l.value ?? ""}`)}</Text>;
            }
            return <Text key={gi}>{clip(l)}</Text>;
          })}
          {start + budget < lines.length ? (
            <Text dimColor>{`  ▼ ${lines.length - start - budget} more`}</Text>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <Text>{hint}</Text>
        </Box>
      </Box>
    );
  }
  registerReplView(name, TabbedView);
  return TabbedView;
}
