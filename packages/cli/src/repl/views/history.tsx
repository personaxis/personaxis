/**
 * State history view (V5.P2.3): the visual timeline behind /rewind and /replay.
 *
 * Every mutation_log entry, newest last; the cursor picks a point in time and the
 * preview shows exactly WHICH fields would be restored (and to what) by rewinding
 * to just before it. Enter asks for a second Enter to confirm; the rewind itself
 * is pure math over the log (offline, deterministic, no LLM) and is RECORDED,
 * never rewriting history (T4: state is a fold of its log).
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registerReplView, type ReplViewProps } from "@personaxis/tui/ink";
import { useTerminalSize, windowFor, fitAnsi } from "@personaxis/tui/viewport";
import { lineChart } from "@personaxis/tui/visual";

export interface HistoryEntry {
  idx: number;
  ts: string;
  field: string;
  from?: number;
  to?: number;
  actor?: string;
  clamped?: boolean;
  blocked?: boolean;
  reason?: string;
}

export interface HistoryActions {
  log(): HistoryEntry[];
  /** Fields that a rewind of the last n mutations would restore (no write). */
  preview(n: number): Array<{ field: string; from: number; to: number }>;
  /**
   * Perform the rewind and say what happened.
   *
   * Asynchronous because the moves go into the record and the caller waits for them
   * to be durable before reporting them. Reporting a rewind that a crash could take
   * back is worse than making somebody wait for it.
   */
  rewind(n: number): Promise<string>;
  notify(line: string): void;
}

export function registerHistoryView(actions: HistoryActions): void {
  function HistoryView({ active, onBack }: ReplViewProps): React.JSX.Element {
    const [refresh, setRefresh] = useState(0);
    const entries = useMemo(() => actions.log(), [refresh]);
    const [cursor, setCursor] = useState(Math.max(0, entries.length - 1));
    const [confirming, setConfirming] = useState(false);
    const { rows, columns } = useTerminalSize();
    const clip = (s: string): string => fitAnsi(s, Math.max(20, columns - 2));
    // V6.4: why would anyone rewind? Show the behavior first: mutation rate over
    // the last two weeks, clamps/blocks, and the most-touched coordinate.
    const stats = useMemo(() => {
      const days = new Map<string, number>();
      const byField = new Map<string, number>();
      let clamped = 0;
      let blocked = 0;
      for (const e of entries) {
        const day = (e.ts ?? "").slice(0, 10);
        if (day) days.set(day, (days.get(day) ?? 0) + 1);
        if (e.clamped) clamped += 1;
        if (e.blocked) blocked += 1;
        byField.set(e.field, (byField.get(e.field) ?? 0) + 1);
      }
      const top = [...byField.entries()].sort((a, b) => b[1] - a[1])[0];
      const N = 14;
      const startD = new Date();
      startD.setDate(startD.getDate() - (N - 1));
      const pts: number[] = [];
      for (let i = 0; i < N; i++) {
        const d = new Date(startD);
        d.setDate(startD.getDate() + i);
        pts.push(days.get(d.toISOString().slice(0, 10)) ?? 0);
      }
      return { pts, clamped, blocked, top };
    }, [entries]);
    const chart = useMemo(
      () => lineChart([{ label: "mutations/day", points: stats.pts, color: 6 }], { height: 4, xLabels: ["14d ago", "today"] }),
      [stats],
    );
    const budget = Math.max(4, rows - 18);
    const win = windowFor(entries.length, cursor, budget);
    const n = entries.length - cursor; // rewind to just BEFORE the selected entry
    const preview = useMemo(() => (entries.length ? actions.preview(n) : []), [n, entries.length, refresh]);

    useInput(
      (ch, key) => {
        if (key.escape || ch === "q") {
          if (confirming) return void setConfirming(false);
          return void onBack();
        }
        if (key.upArrow) return void (setConfirming(false), setCursor((c) => Math.max(0, c - 1)));
        if (key.downArrow) return void (setConfirming(false), setCursor((c) => Math.min(entries.length - 1, c + 1)));
        if (key.return && entries.length) {
          if (!confirming) return void setConfirming(true);
          void actions.rewind(n).then((line) => {
            actions.notify(line);
            setRefresh((x) => x + 1);
          });
          setConfirming(false);
          setCursor(0);
        }
      },
      { isActive: active },
    );

    if (!entries.length) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>{"  State history"}</Text>
          <Text dimColor>{"  no mutations yet; the timeline fills as the persona lives. Esc back."}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{"  State history · rewind"}</Text>
        <Text dimColor>{"  pure math over the log (offline, no LLM); a rewind is RECORDED, history is never rewritten"}</Text>
        <Text dimColor>{"  ↑/↓ pick a point · Enter previews+confirms rewinding to just BEFORE it · Esc back"}</Text>
        {chart.map((l, i) => (
          <Text key={`c${i}`}>{l}</Text>
        ))}
        <Text dimColor>
          {`  ${entries.length} mutation(s) · ${stats.clamped} clamped · ${stats.blocked} blocked` +
            (stats.top ? ` · most touched: ${stats.top[0]} (${stats.top[1]}x)` : "")}
        </Text>
        {win.above > 0 ? <Text dimColor>{`  ▲ ${win.above} earlier`}</Text> : null}
        {entries.slice(win.start, win.end).map((e, i) => {
          const gi = win.start + i;
          const selected = gi === cursor;
          const delta =
            typeof e.from === "number" && typeof e.to === "number" ? `${e.from.toFixed(3)}→${e.to.toFixed(3)}` : "";
          const flags = `${e.clamped ? " clamped" : ""}${e.blocked ? " blocked" : ""}`;
          return (
            <Text key={gi} inverse={selected} dimColor={!selected}>
              {clip(
                (selected ? "  ❯ " : "    ") +
                  `#${String(e.idx).padStart(3)} ${(e.ts ?? "").slice(0, 16).replace("T", " ")} ${e.field.padEnd(34)} ${delta}${flags} [${e.actor ?? "?"}]${e.reason ? ` · ${e.reason.slice(0, 28)}` : ""}`,
              )}
            </Text>
          );
        })}
        {win.end < entries.length ? <Text dimColor>{`  ▼ ${entries.length - win.end} later`}</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{`  Rewind ${n} mutation(s) would restore:`}</Text>
          {preview.length === 0 ? (
            <Text dimColor>{"  (nothing: the state already matches that point)"}</Text>
          ) : (
            preview.slice(0, 6).map((p) => (
              <Text key={p.field}>{`    ${p.field}  ${p.from.toFixed(3)} → ${p.to.toFixed(3)}`}</Text>
            ))
          )}
          {confirming ? <Text color="yellow">{"  Enter again to CONFIRM the rewind · Esc cancels"}</Text> : null}
        </Box>
      </Box>
    );
  }
  registerReplView("history", HistoryView);
}
