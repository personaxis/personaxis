/**
 * Fleet presence (V2-F4.1/F4.2). Each running surface (REPL/serve/watch) writes a
 * `.live.json` marker beside its persona; a persona is "awake" when that marker
 * was refreshed within `staleMs`, else "idle". Pure and file-only, so
 * `personaxis ps` can render a live fleet without any running process.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface LiveStatus {
  awake: boolean;
  ts?: string;
  values?: Record<string, number>;
  mutations?: number;
}

export function liveMarkerPath(personaPath: string): string {
  return join(dirname(personaPath), ".live.json");
}

/** V2-F4.2: awake if the marker's timestamp is within `staleMs` of now. */
export function isAwake(ts: string | undefined, now = Date.now(), staleMs = 30_000): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  return Number.isFinite(t) && now - t <= staleMs && now - t >= -staleMs;
}

export function readLiveStatus(personaPath: string, now = Date.now()): LiveStatus {
  const p = liveMarkerPath(personaPath);
  if (!existsSync(p)) return { awake: false };
  try {
    const m = JSON.parse(readFileSync(p, "utf-8")) as {
      ts?: string;
      values?: Record<string, number>;
      mutations?: number;
    };
    return { awake: isAwake(m.ts, now), ts: m.ts, values: m.values, mutations: m.mutations };
  } catch {
    return { awake: false };
  }
}
