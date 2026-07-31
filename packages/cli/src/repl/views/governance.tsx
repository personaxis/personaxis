/**
 * Governance views (V5.P1.5 + V5.P1.6):
 *
 *   improve  a three-option minimenu (locked / suggesting / autonomous) that
 *            explains what each mode really does before it is chosen.
 *   review   the queued self-edits: what would change, why, approve/reject per
 *            item or all, with a recompile scheduled after approvals.
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registerReplView, type ReplViewProps } from "@personaxis/tui/ink";
import { useTerminalSize, windowFor } from "@personaxis/tui/viewport";

// ── /improve ─────────────────────────────────────────────────────────────────

export interface ImproveActions {
  current(): string;
  set(mode: string): string; // returns a status line
  notify(line: string): void;
}

const MODE_ROWS: Array<{ mode: string; what: string }> = [
  { mode: "locked", what: "every self-edit is BLOCKED; the spec only changes by human hand" },
  { mode: "suggesting", what: "edits QUEUE as proposals; nothing applies until you /review approve" },
  { mode: "autonomous", what: "non-protected edits AUTO-APPLY under governance; the safety floor stays locked" },
];

export function registerImproveView(actions: ImproveActions): void {
  function ImproveView({ active, onBack }: ReplViewProps): React.JSX.Element {
    const [cursor, setCursor] = useState(() => Math.max(0, MODE_ROWS.findIndex((r) => r.mode === actions.current())));
    useInput(
      (ch, key) => {
        if (key.escape || ch === "q") return void onBack();
        if (key.upArrow) return void setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return void setCursor((c) => Math.min(MODE_ROWS.length - 1, c + 1));
        if (key.return) {
          actions.notify(actions.set(MODE_ROWS[cursor].mode));
          onBack();
        }
      },
      { isActive: active },
    );
    const current = actions.current();
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{"  Self-improvement mode"}</Text>
        <Text dimColor>{"  Enter selects · Esc back"}</Text>
        {MODE_ROWS.map((r, i) => (
          <Text key={r.mode} inverse={i === cursor}>
            {i === cursor ? "  ❯ " : "    "}
            {r.mode === current ? "● " : "○ "}
            {r.mode.padEnd(12)}
            {r.what}
          </Text>
        ))}
      </Box>
    );
  }
  registerReplView("improve", ImproveView);
}

// ── /review ──────────────────────────────────────────────────────────────────

export interface ReviewItem {
  id: string;
  targetPath: string;
  toValue: string;
  rationale: string;
}

export interface ReviewActions {
  pending(): ReviewItem[];
  approve(id: string): string;
  reject(id: string): string;
  /** Called when the view closes; anyApproved triggers the recompile. */
  onClose(anyApproved: boolean): void;
  notify(line: string): void;
}

export function registerReviewView(actions: ReviewActions): void {
  function ReviewView({ active, onBack }: ReplViewProps): React.JSX.Element {
    const [refresh, setRefresh] = useState(0);
    const [cursor, setCursor] = useState(0);
    const [anyApproved, setAnyApproved] = useState(false);
    const items = useMemo(() => actions.pending(), [refresh]);
    const { rows } = useTerminalSize();
    const perItem = 3;
    const budget = Math.max(1, Math.floor((rows - 7) / perItem));
    const win = windowFor(items.length, cursor, budget);

    const close = (): void => {
      actions.onClose(anyApproved);
      onBack();
    };

    useInput(
      (ch, key) => {
        if (key.escape || ch === "q") return void close();
        if (key.upArrow) return void setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return void setCursor((c) => Math.min(items.length - 1, c + 1));
        const sel = items[cursor];
        if (!sel) return;
        if (ch === "a") {
          actions.notify(actions.approve(sel.id));
          setAnyApproved(true);
          setRefresh((x) => x + 1);
          setCursor((c) => Math.max(0, Math.min(c, items.length - 2)));
        } else if (ch === "r") {
          actions.notify(actions.reject(sel.id));
          setRefresh((x) => x + 1);
          setCursor((c) => Math.max(0, Math.min(c, items.length - 2)));
        } else if (ch === "A") {
          for (const it of items) actions.notify(actions.approve(it.id));
          setAnyApproved(true);
          setRefresh((x) => x + 1);
        }
      },
      { isActive: active },
    );

    if (!items.length) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>{"  Review queued self-edits"}</Text>
          <Text dimColor>{"  no pending proposals. Esc to go back."}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{`  Review queued self-edits (${items.length})`}</Text>
        <Text dimColor>{"  a approve · r reject · A approve all · ↑/↓ · Esc back"}</Text>
        {win.above > 0 ? <Text dimColor>{`  ▲ ${win.above} more`}</Text> : null}
        {items.slice(win.start, win.end).map((x, i) => {
          const gi = win.start + i;
          const selected = gi === cursor;
          return (
            <Box key={x.id} flexDirection="column">
              <Text inverse={selected}>
                {selected ? "  ❯ " : "    "}
                {x.id} {x.targetPath}
              </Text>
              <Text dimColor>{`       → ${x.toValue}`}</Text>
              <Text dimColor>{`       ${x.rationale}`}</Text>
            </Box>
          );
        })}
        {win.end < items.length ? <Text dimColor>{`  ▼ ${items.length - win.end} more`}</Text> : null}
      </Box>
    );
  }
  registerReplView("review", ReviewView);
}
