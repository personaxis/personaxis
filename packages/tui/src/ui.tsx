/**
 * Chrome kit for fullscreen TUI apps (V2-F2.2): a persistent frame (header /
 * content / keybar footer), dividers, a windowed select list, form fields, a
 * toast and a spinner. Presentational on purpose, the hosting app owns state
 * and the single root useInput; every list clamps through viewport.ts.
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useTerminalSize, windowFor, fitLine } from "./viewport.js";

const NO_ANIM = (): boolean => process.env.PERSONAXIS_NO_ANIM === "1" || Boolean(process.env.NO_COLOR);

export function Divider(props: { width?: number }): React.JSX.Element {
  const { columns } = useTerminalSize();
  return <Text dimColor>{"─".repeat(Math.max(4, props.width ?? columns))}</Text>;
}

export interface KeyHint {
  key: string;
  label: string;
}

/** The footer keybar: `↑/↓ move · enter select · esc back`. */
export function KeyBar(props: { hints: KeyHint[] }): React.JSX.Element {
  const { columns } = useTerminalSize();
  return <Text dimColor>{fitLine(props.hints.map((h) => `${h.key} ${h.label}`).join("  ·  "), Math.max(20, columns))}</Text>;
}

/**
 * The persistent app frame: wordmark + title + breadcrumb header, a divider,
 * the content area (flexGrow), and the keybar footer. Fills the terminal
 * height so the fullscreen buffer always looks composed, never half-drawn.
 */
export function AppFrame(props: {
  title: string;
  breadcrumb?: string;
  hints: KeyHint[];
  children: React.ReactNode;
}): React.JSX.Element {
  const { columns, rows } = useTerminalSize();
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Text>
        <Text bold>{"◉ personaxis"}</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text bold color="cyanBright">
          {props.title}
        </Text>
        {props.breadcrumb ? <Text dimColor>{`  ›  ${props.breadcrumb}`}</Text> : null}
      </Text>
      <Divider />
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={0} overflow="hidden">
        {props.children}
      </Box>
      <Divider />
      <KeyBar hints={props.hints} />
    </Box>
  );
}

export interface ListItem {
  value: string;
  title: string;
  desc?: string;
  /** Right-aligned annotation (e.g. "(default)"). */
  badge?: string;
}

/**
 * A windowed, cursor-following select list (single visual language for every
 * menu). Presentational: the host owns `index` and key handling.
 */
export function SelectList(props: { items: ListItem[]; index: number; maxVisible?: number; dense?: boolean }): React.JSX.Element {
  const { columns, rows } = useTerminalSize();
  const linesPer = props.dense ? 1 : 2;
  const max = props.maxVisible ?? Math.max(2, Math.floor((rows - 7) / linesPer));
  const i = Math.min(props.index, Math.max(0, props.items.length - 1));
  const win = windowFor(props.items.length, i, max);
  const width = Math.max(20, columns - 4);
  return (
    <Box flexDirection="column">
      {win.above > 0 ? <Text dimColor>{`  ▲ ${win.above} more`}</Text> : null}
      {props.items.slice(win.start, win.end).map((item, k) => {
        const idx = win.start + k;
        const selected = idx === i;
        return (
          <Box key={item.value} flexDirection="column">
            <Text color={selected ? "cyanBright" : undefined} bold={selected}>
              {fitLine((selected ? "❯ " : "  ") + item.title + (item.badge ? `  ${item.badge}` : ""), width)}
            </Text>
            {!props.dense && item.desc ? <Text dimColor>{fitLine("    " + item.desc, width)}</Text> : null}
          </Box>
        );
      })}
      {win.below > 0 ? <Text dimColor>{`  ▼ ${win.below} more`}</Text> : null}
      {props.items.length > max ? <Text dimColor>{`  ${i + 1}/${props.items.length}`}</Text> : null}
    </Box>
  );
}

/**
 * One form field: label + help + the live value. When `active`, an inline text
 * input owns the keyboard (the host's root useInput must yield while a field is
 * active). The DEFAULT is visibly labeled, the exact confusion David reported
 * ("is the bracketed value a default or an example?") answered in the UI itself.
 */
export function Field(props: {
  label: string;
  help?: string;
  value: string;
  placeholder?: string;
  active: boolean;
  secret?: boolean;
  onChange?: (v: string) => void;
  onSubmit?: (v: string) => void;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color={props.active ? "cyanBright" : undefined}>
          {(props.active ? "❯ " : "  ") + props.label}
        </Text>
        {props.placeholder ? <Text dimColor>{`   (enter = default: ${props.placeholder})`}</Text> : null}
      </Text>
      {props.help ? <Text dimColor>{"    " + props.help}</Text> : null}
      <Box marginLeft={4}>
        {props.active ? (
          <TextInput
            value={props.value}
            onChange={props.onChange ?? ((): void => {})}
            onSubmit={props.onSubmit}
            mask={props.secret ? "*" : undefined}
          />
        ) : (
          <Text dimColor>{props.secret && props.value ? "*".repeat(Math.min(12, props.value.length)) : props.value || " "}</Text>
        )}
      </Box>
    </Box>
  );
}

/** A one-line status toast. */
export function Toast(props: { kind: "ok" | "warn" | "error" | "info"; text: string }): React.JSX.Element {
  const color = props.kind === "ok" ? "green" : props.kind === "warn" ? "yellow" : props.kind === "error" ? "red" : undefined;
  const mark = props.kind === "ok" ? "✓" : props.kind === "warn" ? "!" : props.kind === "error" ? "✗" : "·";
  return (
    <Text color={color} dimColor={props.kind === "info"}>
      {`  ${mark} ${props.text}`}
    </Text>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** An animated spinner label (static under PERSONAXIS_NO_ANIM / NO_COLOR). */
export function SpinnerText(props: { label: string }): React.JSX.Element {
  const [f, setF] = useState(0);
  useEffect(() => {
    if (NO_ANIM()) return;
    const t = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text>{`  ${NO_ANIM() ? "·" : FRAMES[f]} ${props.label}`}</Text>;
}
