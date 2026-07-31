/**
 * Skills miniapp (V5.P1.10, made functional in V7.A5).
 *
 * Design note: "su menu no funciona para nada... no funciona el enter apply ni el p
 * pull, tampoco hay forma de agregar skills o de actualizar los que ya existen segun su
 * fuente oficial". The view listed rows and nothing else: pull only printed a hint, and
 * there was no add / update / remove at all.
 *
 * Now every action is real and scoped to the selected persona (main or any sub):
 *   Enter  apply the skill as a turn        a  add a skill (typed inline)
 *   p      materialize it next to the spec  u  update it from its source
 *   d      stop declaring it (2-key confirm)   ←/→ or Tab switch persona
 */

import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { registerReplView, SubNavBar, type ReplViewProps } from "@personaxis/tui/ink";

export interface SkillRow {
  name: string;
  kind: string;
  status: string;
  ref?: string;
}

export interface SkillsActions {
  personas(): string[]; // ["main", "@cmo", ...]
  skills(persona: string): SkillRow[];
  /** Apply a skill as a turn (closes the view first). */
  apply(persona: string, name: string): void;
  /** Materialize it beside the spec. */
  pull(persona: string, name: string): string;
  /** Refresh it from its declared source. */
  update(persona: string, name: string): string;
  /** Declare a new skill from a path / github: ref / registry coordinate. */
  add(persona: string, ref: string): string;
  /** Stop declaring it. */
  remove(persona: string, name: string): string;
  notify(line: string): void;
}

type Mode = { kind: "list" } | { kind: "add"; text: string } | { kind: "confirmRemove"; name: string };

export function registerSkillsView(actions: SkillsActions): void {
  function SkillsView({ active, onBack }: ReplViewProps): React.JSX.Element {
    // Recomputed with the skills list, not memoised once: a sub-persona created
    // during the session (via /create) has to appear here without a restart.
    const [refreshPersonas, setRefreshPersonas] = useState(0);
    const [who, setWho] = useState(0);
    const [cursor, setCursor] = useState(0);
    const [refresh, setRefresh] = useState(0);
    const [mode, setMode] = useState<Mode>({ kind: "list" });
    const [toast, setToast] = useState<string | null>(null);
    const personas = useMemo(() => actions.personas(), [refreshPersonas]);
    const persona = personas[who] ?? "main";
    const rows = useMemo(() => actions.skills(persona), [persona, refresh]);
    const sel = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

    const run = (fn: () => string): void => {
      setToast(fn());
      setRefresh((x) => x + 1);
    };

    useInput(
      (ch, key) => {
        // Inline "add" field: typing goes into the ref, Enter declares it.
        if (mode.kind === "add") {
          if (key.escape) return void setMode({ kind: "list" });
          if (key.return) {
            const ref = mode.text.trim();
            setMode({ kind: "list" });
            if (ref) run(() => actions.add(persona, ref));
            return;
          }
          if (key.backspace || key.delete) return void setMode({ kind: "add", text: mode.text.slice(0, -1) });
          if (ch && !key.ctrl && !key.meta) return void setMode({ kind: "add", text: mode.text + ch });
          return;
        }
        if (mode.kind === "confirmRemove") {
          if (ch === "y" || ch === "Y") {
            const name = mode.name;
            setMode({ kind: "list" });
            run(() => actions.remove(persona, name));
            return;
          }
          return void setMode({ kind: "list" });
        }

        if (key.escape || ch === "q") return void onBack();
        // `p` is the app-wide persona-switch key (V7.C1). Skills predates the shared
        // host and cycles with Tab/arrows over its own sub-navbar; both work, because
        // a contract nobody can reach from muscle memory is not a contract.
        if (ch === "p") {
          setRefreshPersonas((x) => x + 1);
          return void (setWho((w) => (w + 1) % personas.length), setCursor(0), setToast(null));
        }
        if (key.tab || key.rightArrow) return void (setWho((w) => (w + 1) % personas.length), setCursor(0), setToast(null));
        if (key.leftArrow) return void (setWho((w) => (w + personas.length - 1) % personas.length), setCursor(0), setToast(null));
        if (key.upArrow) return void (setCursor((c) => Math.max(0, c - 1)), setToast(null));
        if (key.downArrow) return void (setCursor((c) => Math.min(rows.length - 1, c + 1)), setToast(null));
        if (ch === "a") return void setMode({ kind: "add", text: "" });
        if (!sel) return;
        if (key.return) {
          onBack();
          actions.apply(persona, sel.name);
          return;
        }
        // `m` for materialize: `p` belongs to the persona switch everywhere else in
        // the app, and two meanings for one key is how a contract quietly dies.
        if (ch === "m") return run(() => actions.pull(persona, sel.name));
        if (ch === "u") return run(() => actions.update(persona, sel.name));
        if (ch === "d") return void setMode({ kind: "confirmRemove", name: sel.name });
      },
      { isActive: active },
    );

    const footer =
      mode.kind === "add"
        ? "type a path (./skills/x), a github: ref, or @org/name@version · Enter declare · Esc cancel"
        : mode.kind === "confirmRemove"
          ? `stop declaring "${mode.name}"? y = yes (files are kept) · any other key = cancel`
          : "Enter apply · a add · m materialize · u update · d remove · p or ←/→ persona · Esc back";

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{"  Skills"}</Text>
        <Box marginLeft={2}>
          <SubNavBar tabs={personas} active={who} />
        </Box>
        <Text dimColor>{"  what a skill is: a reusable procedure this persona can run, declared in extensions.skills"}</Text>
        {rows.length === 0 && mode.kind !== "add" ? (
          <Text dimColor>{"  no skills yet. Press a to declare one (e.g. ./skills/research or github:org/repo/path)."}</Text>
        ) : null}
        {rows.map((r, i) => {
          const selected = i === cursor;
          const statusColor = r.status === "materialized" ? "green" : r.status === "missing-local" ? "red" : undefined;
          return (
            <Box key={r.name} flexDirection="column">
              <Text inverse={selected}>
                {selected ? "  ❯ " : "    "}
                {r.name.padEnd(24)}
                {r.kind.padEnd(10)}
                <Text color={statusColor as never}>{r.status}</Text>
              </Text>
              {selected && r.ref ? <Text dimColor>{`       ${r.ref}`}</Text> : null}
            </Box>
          );
        })}
        {mode.kind === "add" ? (
          <Box marginTop={1}>
            <Text color="cyan">{"  add › "}</Text>
            <Text>{mode.text}</Text>
            <Text dimColor>{"▌"}</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          {toast ? <Text color="green">{`  ${toast}`}</Text> : null}
          <Text dimColor>{`  ${footer}`}</Text>
        </Box>
      </Box>
    );
  }
  registerReplView("skills", SkillsView);
}
