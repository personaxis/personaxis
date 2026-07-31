/**
 * SCOPED PROVIDERS: give any miniapp the persona selector in one line.
 *
 * The host renders the selector and owns its key; this wrapper owns the selection and
 * hands each `lines()` call a context projected onto the chosen persona. Without it every
 * view would repeat the same three-field dance (index, getter, setter), and the ones whose
 * author forgot would silently keep answering only for the main persona, which is the state
 * most of the app was in before scopes existed.
 *
 * The projection is read-only: `scopedCtx` re-points the persona's FILES and leaves the
 * session's loop, responder and conversation alone, so a scoped view can display any
 * persona and can never make one speak or evolve.
 */

import { personaScopes, scopedCtx, type PersonaScope } from "../scope.js";
import type { Ctx } from "../types.js";
import type { TabbedProvider } from "./tabbed.js";

/**
 * Wrap a provider so it renders for the SELECTED persona.
 *
 * @param build called with the projected context; invoked per redraw so it always reflects
 *              both the current selection and the current state on disk.
 */
export function scopedProvider(ctx: Ctx, build: (scoped: Ctx) => TabbedProvider): TabbedProvider {
  let index = 0;
  const all = (): PersonaScope[] => personaScopes(ctx);
  const view = (): Ctx => {
    const scopes = all();
    return scopedCtx(ctx, scopes[Math.min(index, scopes.length - 1)]);
  };
  // Title and tabs are structural, so they come from the unprojected provider once.
  const base = build(ctx);
  return {
    ...base,
    scopes: () => all().map((s) => s.label),
    activeScope: () => index,
    onScope: (i) => {
      index = i;
    },
    lines: (t) => build(view()).lines(t),
  };
}
