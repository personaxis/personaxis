/**
 * Engine store (FR.3): the core EventBus, via the protocol seam, stays the
 * SOURCE OF TRUTH; this thin zustand store only adapts events for React
 * consumption (frame-batched token deltas, committed transcript, dials).
 */

import { createStore } from "zustand/vanilla";
import type { EventMsg } from "@personaxis/protocol";
import { CommitQueue } from "./streaming/commit-queue.js";

export interface EngineUiState {
  connected: boolean;
  personaName: string;
  mode: string;
  /** Committed transcript lines (render via <Static>). */
  committed: string[];
  /** Live region: pending stream tail. */
  live: string;
  /** Latest state snapshot (dials). */
  values: Record<string, number>;
  mutationCount: number;
  busy: boolean;
  lastError: string | null;
}

const initial: EngineUiState = {
  connected: false,
  personaName: "",
  mode: "locked",
  committed: [],
  live: "",
  values: {},
  mutationCount: 0,
  busy: false,
  lastError: null,
};

export function createEngineStore() {
  const queue = new CommitQueue();
  // Frame-batching: token deltas accumulate here and land in the store at most
  // once per animation frame, a per-token setState would thrash the renderer.
  let pendingTokens = "";
  let scheduled = false;

  const store = createStore<EngineUiState>(() => ({ ...initial }));

  const flushTokens = (): void => {
    scheduled = false;
    if (!pendingTokens) return;
    const text = pendingTokens;
    pendingTokens = "";
    const newlyCommitted = queue.push(text);
    store.setState((s) => ({
      committed: newlyCommitted.length > 0 ? [...s.committed, ...newlyCommitted] : s.committed,
      live: queue.pending(),
    }));
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(flushTokens, 16); // ~one frame
  };

  const onEvent = (e: EventMsg): void => {
    switch (e.event) {
      case "session.configured":
        store.setState({ connected: true, personaName: e.persona.name, mode: e.mode });
        return;
      case "turn.started":
        store.setState({ busy: true, lastError: null });
        return;
      case "token.delta":
        pendingTokens += e.text;
        schedule();
        return;
      case "turn.completed": {
        flushTokens();
        const rest = queue.flush();
        store.setState((s) => ({
          busy: false,
          committed: rest.length > 0 ? [...s.committed, ...rest] : s.committed,
          live: "",
        }));
        return;
      }
      case "state.snapshot":
        store.setState({ values: e.values, mutationCount: e.mutationCount });
        return;
      case "error":
        store.setState({ lastError: e.message, busy: false });
        return;
      case "engine.event":
      case "approval.requested":
        // Rendered by dedicated consumers (activity feed, approval FSM, FR.10).
        return;
    }
  };

  return { store, onEvent, flushTokens };
}

export type EngineStore = ReturnType<typeof createEngineStore>;
