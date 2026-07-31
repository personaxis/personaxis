/**
 * Memory view (V5.P1.4): a two-level menu over the persona's memory.
 *
 *   Level 1  kinds (semantic, episodic, procedural, autobiographical,
 *            preferences, evaluations) with on/off + counts; c consolidates,
 *            p prunes; Esc back to chat.
 *   Level 2  the selected kind's entries (newest last); Enter opens the kind's
 *            FILE in the default text editor (cross-OS); Esc back to level 1.
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registerReplView, type ReplViewProps } from "@personaxis/tui/ink";
import { useTerminalSize, windowFor } from "@personaxis/tui/viewport";

export interface MemoryKindRow {
  name: string;
  enabled: boolean;
  count: number;
  file: string;
  entries(): string[];
}

export interface MemoryActions {
  kinds(): MemoryKindRow[];
  openFile(path: string): string; // returns a status line for the transcript
  consolidate(): string;
  prune(): string;
  notify(line: string): void;
}

export function registerMemoryView(actions: MemoryActions): void {
  function MemoryView({ active, onBack }: ReplViewProps): React.JSX.Element {
    const [level, setLevel] = useState<0 | 1>(0);
    const [cursor, setCursor] = useState(0);
    const [entryCursor, setEntryCursor] = useState(0);
    const [refresh, setRefresh] = useState(0);
    const kinds = useMemo(() => actions.kinds(), [refresh]);
    const current = kinds[Math.min(cursor, Math.max(0, kinds.length - 1))];
    const entries = useMemo(() => (level === 1 && current ? current.entries() : []), [level, current, refresh]);
    const { rows } = useTerminalSize();
    const budget = Math.max(4, rows - 8);

    useInput(
      (ch, key) => {
        if (key.escape || ch === "q") {
          if (level === 1) {
            setLevel(0);
            setEntryCursor(0);
            return;
          }
          return void onBack();
        }
        if (level === 0) {
          if (key.upArrow) return void setCursor((c) => Math.max(0, c - 1));
          if (key.downArrow) return void setCursor((c) => Math.min(kinds.length - 1, c + 1));
          if ((key.return || key.rightArrow) && current) return void setLevel(1);
          if (ch === "c") return void (actions.notify(actions.consolidate()), setRefresh((x) => x + 1));
          if (ch === "p") return void (actions.notify(actions.prune()), setRefresh((x) => x + 1));
          return;
        }
        if (key.upArrow) return void setEntryCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return void setEntryCursor((c) => Math.min(entries.length - 1, c + 1));
        if (key.leftArrow) return void (setLevel(0), setEntryCursor(0));
        if (key.return && current) {
          actions.notify(actions.openFile(current.file));
        }
      },
      { isActive: active },
    );

    if (level === 0) {
      const win = windowFor(kinds.length, cursor, budget);
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>{"  Memory"}</Text>
          <Text dimColor>{"  Enter/→ browse a kind · c consolidate · p prune · /memory search <q> · Esc back"}</Text>
          {kinds.slice(win.start, win.end).map((k, i) => {
            const gi = win.start + i;
            const selected = gi === cursor;
            const label = ` ${k.name.padEnd(17)} ${k.enabled ? `${String(k.count).padStart(4)} entr${k.count === 1 ? "y  " : "ies"}` : "  (off)   "}  ${k.file}`;
            return (
              <Text key={k.name} inverse={selected} dimColor={!selected && !k.enabled}>
                {selected ? "  ❯" : "   "}
                {label}
              </Text>
            );
          })}
        </Box>
      );
    }

    const win = windowFor(entries.length, entryCursor, budget);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{`  Memory · ${current?.name ?? ""}`}</Text>
        <Text dimColor>{"  Enter opens the file in your editor · ←/Esc back to kinds"}</Text>
        {entries.length === 0 ? <Text dimColor>{"  (empty)"}</Text> : null}
        {win.above > 0 ? <Text dimColor>{`  ▲ ${win.above} more`}</Text> : null}
        {entries.slice(win.start, win.end).map((e, i) => {
          const gi = win.start + i;
          return (
            <Text key={gi} inverse={gi === entryCursor}>
              {gi === entryCursor ? "  ❯ " : "    "}
              {e}
            </Text>
          );
        })}
        {win.end < entries.length ? <Text dimColor>{`  ▼ ${entries.length - win.end} more`}</Text> : null}
      </Box>
    );
  }
  registerReplView("memory", MemoryView);
}
