/**
 * ScopeNavigator (V9 / G.4): renders ANY node of the scope tree the same way, and drills.
 *
 * The old Command Center was eight sibling screens; this is one recursive component over the
 * `ScopeNode` model (`center/tree.ts`). At every depth it answers the three questions from the
 * node itself: WHERE am I (the breadcrumb = `node.path`), WHAT does this act on (the node), WHAT
 * does Enter do (the focused child's declared action + effect).
 *
 * State is the PATH, not a node snapshot, and the node is resolved every render. So live data
 * (the machine's activity) refreshes on the poll without stale captures, and the external gate
 * (G.5) can address the exact same path. `resolve` is injected (defaults to the machine tree) so
 * the component is testable without the global registry. One `useInput` owns the keyboard, which
 * is what prevents the double-Enter that plagued the old views.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { AppFrame, type ListItem, type KeyHint } from "@personaxis/tui/ui";
import { nodeAt, type ScopeNode, type Action } from "./tree.js";

export interface NavigatorProps {
  /** Resolve the node at a path. Defaults to the machine tree; injected in tests. */
  resolve?: (path: string[]) => ScopeNode | null;
  /** Where to start; defaults to the machine root. */
  initialPath?: string[];
  /** Called when Esc is pressed at the root (leave the Center). */
  onExit: () => void;
  /**
   * Execute an edit action on a leaf (a coordinate, a governed layer). The host wires this to
   * the engine (SDK `adjust`/`proposeEdit`); the navigator only collects the value and the
   * authority already told it whether the edit is allowed. `blocked` actions never reach here.
   */
  onEdit?: (node: ScopeNode, action: Action, value: string) => void;
  active?: boolean;
}

/** The action Enter would take on a node: prefer navigation, else its first declared action. */
function primaryAction(node: ScopeNode): Action | undefined {
  return node.actions.find((a) => a.kind === "navigate") ?? node.actions[0];
}

/** A short, neutral tag for an edit effect (no platform glyphs); nothing for pure-nav nodes. */
function effectBadge(node: ScopeNode): string | undefined {
  const edit = node.actions.find((a) => a.kind === "edit");
  if (!edit) return undefined;
  return edit.effect === "blocked" ? "read-only" : edit.effect === "proposal" ? "→ review" : "editable";
}

export function ScopeNavigator(props: NavigatorProps): React.JSX.Element {
  const resolve = props.resolve ?? nodeAt;
  const active = props.active ?? true;
  const [path, setPath] = useState<string[]>(props.initialPath ?? ["machine"]);
  const [cursor, setCursor] = useState(0);
  // Bumping this forces a re-render, which re-resolves the node so live data (activity) refreshes.
  const [, setTick] = useState(0);
  // Edit mode: when set, an inline prompt owns the keyboard to collect a value for an edit action.
  const [editing, setEditing] = useState<{ node: ScopeNode; action: Action } | null>(null);
  const [editValue, setEditValue] = useState("");

  // Poll ~1s for live data, unless animation is disabled (CI/tests).
  useEffect(() => {
    if (process.env.PERSONAXIS_NO_ANIM) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    (id as { unref?: () => void }).unref?.();
    return () => clearInterval(id);
  }, []);

  const node = resolve(path);
  const children = node ? node.children() : [];
  const focused = children[Math.min(cursor, Math.max(0, children.length - 1))];

  useInput(
    (input, key) => {
      // Edit mode owns the keyboard: type a value, Enter applies, Esc cancels.
      if (editing) {
        if (key.escape) {
          setEditing(null);
          setEditValue("");
          return;
        }
        if (key.return) {
          props.onEdit?.(editing.node, editing.action, editValue.trim());
          setEditing(null);
          setEditValue("");
          return;
        }
        if (key.backspace || key.delete) return setEditValue((v) => v.slice(0, -1));
        if (input && !key.ctrl && !key.meta) setEditValue((v) => v + input);
        return;
      }

      if (key.escape) {
        if (path.length <= 1) return props.onExit();
        setPath(path.slice(0, -1));
        setCursor(0);
        return;
      }
      if (children.length === 0) return;
      if (key.upArrow) return setCursor((c) => (c + children.length - 1) % children.length);
      if (key.downArrow) return setCursor((c) => (c + 1) % children.length);
      if (key.return && focused) {
        // A node with depth: drill in. A leaf with an allowed edit action: open edit mode.
        // A blocked leaf: nothing (the authority is already shown).
        if (focused.children().length > 0) {
          setPath([...path, focused.id]);
          setCursor(0);
          return;
        }
        // Only a numeric FIELD takes a value here; a layer's edit effect is informational
        // (qualitative editing is a richer flow, not a single-value prompt).
        const edit = focused.actions.find((a) => a.kind === "edit");
        if (focused.level === "field" && edit && edit.effect !== "blocked") {
          setEditing({ node: focused, action: edit });
          setEditValue("");
        }
      }
    },
    { isActive: active },
  );

  const hints: KeyHint[] = editing
    ? [
        { key: "type", label: "value" },
        { key: "enter", label: editing.action.effect === "proposal" ? "propose" : "apply" },
        { key: "esc", label: "cancel" },
      ]
    : [
        { key: "↑/↓", label: "move" },
        { key: "enter", label: "open/edit" },
        { key: "esc", label: path.length <= 1 ? "quit" : "back" },
      ];
  const breadcrumb = (node?.path ?? path).join(" › ");

  if (!node) {
    return (
      <AppFrame title="command center" breadcrumb={breadcrumb} hints={hints}>
        <Text dimColor>{"  nothing here (the path no longer resolves)."}</Text>
      </AppFrame>
    );
  }

  const items: ListItem[] = children.map((c) => ({
    value: c.id,
    title: c.title,
    badge: effectBadge(c),
    desc: c.live ? `${c.live.instances} live · ${c.live.summary}` : c.attributes[0] ? `${c.attributes[0].key}: ${c.attributes[0].value}` : undefined,
  }));

  return (
    <AppFrame title="command center" breadcrumb={breadcrumb} hints={hints}>
      {/* WHAT this acts on: the node's own attributes. */}
      <Box flexDirection="column" marginBottom={children.length ? 1 : 0}>
        {node.attributes.slice(0, 4).map((a) => (
          <Text key={a.key} dimColor>
            {`  ${a.key}: `}
            <Text color="white">{a.value}</Text>
            {a.note ? <Text dimColor>{`  (${a.note})`}</Text> : null}
          </Text>
        ))}
      </Box>

      {/* The children, one row each, with the focused one marked. */}
      {items.length ? (
        <Box flexDirection="column">
          {items.map((it, i) => {
            const sel = i === Math.min(cursor, items.length - 1);
            return (
              <Text key={it.value} color={sel ? "cyanBright" : undefined} bold={sel}>
                {(sel ? " ❯ " : "   ") + it.title + (it.badge ? `   ${it.badge}` : "")}
                {it.desc ? <Text dimColor>{`   ${it.desc}`}</Text> : null}
              </Text>
            );
          })}
        </Box>
      ) : (
        <Text dimColor>{"  (nothing below; this is a leaf)"}</Text>
      )}

      {/* Edit mode: an inline prompt for the value, with the effect it will have. */}
      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            {`  ${editing.action.effect === "proposal" ? "propose" : "set"} ${editing.node.title}: `}
            <Text color="cyanBright">{editValue}</Text>
            <Text dimColor>▏</Text>
          </Text>
          <Text dimColor>{`  ${editing.action.authority ?? ""}`}</Text>
        </Box>
      ) : null}

      {/* WHAT Enter does with the focused child, and why (its authority). */}
      {!editing && focused ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            {"  Enter: "}
            {focused.children().length > 0 ? `open ${focused.title}` : `${focused.title} (leaf)`}
          </Text>
          {(() => {
            const act = primaryAction(focused);
            return act && act.kind !== "navigate" ? (
              <Text dimColor>{`  ${act.label}: ${act.effect}${act.authority ? ` — ${act.authority}` : ""}`}</Text>
            ) : null;
          })()}
        </Box>
      ) : null}
    </AppFrame>
  );
}
