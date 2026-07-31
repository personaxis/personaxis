/**
 * Hooks view (V5.P1.9): the /hooks submenu. One row per host showing whether the
 * end-of-turn learning hook is installed (project and global scope where the host
 * supports both), with an explanation of what installing actually does BEFORE it
 * happens. Keys: ↑/↓ select · Enter/i install · u uninstall · g toggle scope ·
 * Esc back.
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registerReplView, type ReplViewProps } from "@personaxis/tui/ink";

export interface HookRowStatus {
  host: string;
  scoped: boolean; // supports project vs global scope
  projectInstalled: boolean;
  globalInstalled: boolean;
  path: string;
  what: string;
}

export interface HooksActions {
  rows(): HookRowStatus[];
  install(host: string, global: boolean): string;
  uninstall(host: string, global: boolean): string;
  notify(line: string): void;
}

export function registerHooksView(actions: HooksActions): void {
  function HooksView({ active, onBack }: ReplViewProps): React.JSX.Element {
    const [cursor, setCursor] = useState(0);
    const [globalScope, setGlobalScope] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const rows = useMemo(() => actions.rows(), [refresh]);

    useInput(
      (ch, key) => {
        if (key.escape || ch === "q") return void onBack();
        if (key.upArrow) return void setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) return void setCursor((c) => Math.min(rows.length - 1, c + 1));
        if (ch === "g") return void setGlobalScope((g) => !g);
        const sel = rows[cursor];
        if (!sel) return;
        const scope = sel.scoped ? globalScope : true; // scope-less hosts install globally
        if (key.return || ch === "i") {
          actions.notify(actions.install(sel.host, scope));
          setRefresh((x) => x + 1);
        } else if (ch === "u") {
          actions.notify(actions.uninstall(sel.host, scope));
          setRefresh((x) => x + 1);
        }
      },
      { isActive: active },
    );

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{"  Hooks · end-of-turn learning"}</Text>
        <Text dimColor>
          {"  A hook feeds each host turn to `personaxis observe`: one governed Living-Loop tick on YOUR model."}
        </Text>
        <Text dimColor>{`  Enter/i install · u uninstall · g scope: ${globalScope ? "GLOBAL (user)" : "PROJECT"} · Esc back`}</Text>
        {rows.map((r, i) => {
          const selected = i === cursor;
          const status = r.scoped
            ? `project ${r.projectInstalled ? "●" : "○"} · global ${r.globalInstalled ? "●" : "○"}`
            : r.globalInstalled
              ? "installed ●"
              : "not installed ○";
          return (
            <Box key={r.host} flexDirection="column">
              <Text inverse={selected}>
                {selected ? "  ❯ " : "    "}
                {r.host.padEnd(13)}
                {status}
              </Text>
              {selected ? <Text dimColor>{`       ${r.what}`}</Text> : null}
              {selected ? <Text dimColor>{`       ${r.path}`}</Text> : null}
            </Box>
          );
        })}
      </Box>
    );
  }
  registerReplView("hooks", HooksView);
}
