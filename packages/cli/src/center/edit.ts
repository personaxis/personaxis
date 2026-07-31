/**
 * Edit execution for the scope tree (V9 / G.4b, G.5), pure of Ink so both the TUI navigator and
 * the headless `console` command share ONE implementation. A field is a numeric coordinate; the
 * edit becomes an envelope-clamped `adjust` on the node's own persona (main or a sub). The gate
 * already decided the action was allowed (`blocked` actions never reach here).
 */

import { Persona } from "@personaxis/sdk";
import type { ScopeNode } from "./tree.js";

export interface EditResult {
  ok: boolean;
  message: string;
}

/** Apply a numeric field edit through the SDK. Returns a result, never throws. */
export function applyFieldEdit(node: ScopeNode, value: string): EditResult {
  if (node.level !== "field" || !node.personaPath) {
    return { ok: false, message: `not an editable field: ${node.id}` };
  }
  const target = Number(value);
  if (!Number.isFinite(target)) {
    return { ok: false, message: `value must be a number, got "${value}"` };
  }
  const current = Number(node.attributes.find((a) => a.key === "current")?.value ?? "0");
  try {
    new Persona(node.personaPath).adjust(node.id, target - current, "edited via Command Center");
    return { ok: true, message: `${node.id} → ${target.toFixed(2)} (envelope-clamped)` };
  } catch (e) {
    // The clamp/gate may reject it; report rather than crash.
    return { ok: false, message: (e as Error).message };
  }
}
