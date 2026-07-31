/**
 * Host for the ScopeNavigator (V9 / G.4b): opens it fullscreen and wires its edit action to the
 * engine via the SDK. Kept SEPARATE from the legacy `command-center.tsx` so the swap of `/menu`
 * to the navigator could happen incrementally without regressing the model wizard; since G.4c
 * the navigator IS the default `personaxis menu` view (`--classic` keeps the sectioned hub).
 *
 * The navigator is Ink-free and testable on its own (`center/navigator.tsx`); this file is the
 * thin, untested-by-design shell that connects it to `runFullscreen` and to `Persona.adjust`.
 */

import React from "react";
import { useApp } from "ink";
import { runFullscreen } from "@personaxis/tui/fullscreen";
import { ScopeNavigator } from "./navigator.js";
import { applyFieldEdit } from "./edit.js";
import type { ScopeNode, Action } from "./tree.js";

/** Apply a field edit through the shared (Ink-free) executor; the navigator stays usable on reject. */
export function applyNavigatorEdit(node: ScopeNode, _action: Action, value: string): void {
  applyFieldEdit(node, value);
}

function NavigatorApp(): React.JSX.Element {
  const { exit } = useApp();
  return <ScopeNavigator onExit={() => exit()} onEdit={applyNavigatorEdit} />;
}

/** Open the scope-tree navigator over this machine's registered personas. */
export async function runScopeNavigator(): Promise<void> {
  await runFullscreen(<NavigatorApp />);
}
