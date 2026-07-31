/**
 * Resume view (V5.P1.3): /resume with no args opens this full-height session
 * picker. Sessions are ordered by LAST MESSAGE (listSessions derives `updated`
 * from the final turn's timestamp, not from when the file was last opened), the
 * elapsed column reads from that same moment, Enter resumes the highlighted
 * session, Esc returns to chat. /resume <id|name> still resumes directly.
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionSummary } from "@personaxis/core";
import { registerReplView, type ReplViewProps } from "@personaxis/tui/ink";
import { useTerminalSize, windowFor } from "@personaxis/tui/viewport";

export interface ResumeActions {
  list(): SessionSummary[];
  liveId(): string;
  /** Returns the resumed session's name + restored message count, or null. */
  resume(id: string): { name: string; messages: number } | null;
  notify(line: string): void;
}

/** "3m ago" style elapsed-time label from an ISO timestamp. */
export function agoLabel(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function registerResumeView(actions: ResumeActions): void {
  function ResumeView({ active, onBack }: ReplViewProps): React.JSX.Element {
    const sessions = useMemo(() => actions.list(), []);
    const [cursor, setCursor] = useState(0);
    const { rows } = useTerminalSize();
    const budget = Math.max(4, rows - 7);
    const win = windowFor(sessions.length, cursor, budget);

    useInput(
      (ch, key) => {
        if (key.escape || ch === "q") return void onBack();
        if (key.upArrow) return void setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return void setCursor((c) => Math.min(sessions.length - 1, c + 1));
        if (key.return && sessions[cursor]) {
          const s = sessions[cursor];
          if (s.id === actions.liveId()) {
            actions.notify("  already in this session.");
            return void onBack();
          }
          // `resume` already announces the rebuilt conversation on screen (it wipes
          // the scrollback and reprints the whole thing). Announcing it again here
          // printed the same fact twice, once above the restored history and once
          // below it. Only the FAILURE needs a word.
          const r = actions.resume(s.id);
          if (!r) actions.notify(`  could not resume "${s.name}"`);
          onBack();
        }
      },
      { isActive: active },
    );

    if (!sessions.length) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>{"  Resume a session"}</Text>
          <Text dimColor>{"  no saved sessions yet. Esc to go back."}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{`  Resume a session  `}</Text>
        <Text dimColor>{"  ordered by last message · Enter resumes · Esc back"}</Text>
        {win.above > 0 ? <Text dimColor>{`  ▲ ${win.above} more`}</Text> : null}
        {sessions.slice(win.start, win.end).map((s, i) => {
          const gi = win.start + i;
          const selected = gi === cursor;
          const live = s.id === actions.liveId();
          const label = ` ${(s.name || s.id).slice(0, 34).padEnd(34)} ${agoLabel(s.updated).padStart(8)}  ${String(s.turns).padStart(3)} turn(s)${live ? " ● live" : ""}`;
          return (
            <Text key={s.id} inverse={selected} color={live ? "green" : undefined} dimColor={!selected && !live}>
              {selected ? "  ❯" : "   "}
              {label}
            </Text>
          );
        })}
        {win.end < sessions.length ? <Text dimColor>{`  ▼ ${sessions.length - win.end} more`}</Text> : null}
      </Box>
    );
  }
  registerReplView("resume", ResumeView);
}
