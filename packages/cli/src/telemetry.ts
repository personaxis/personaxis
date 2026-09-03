/**
 * Opt-in telemetry (V2-F3.D21). Default OFF. When `config.telemetry.enabled` is
 * true, span records are appended as JSONL (default `.personaxis/telemetry.jsonl`)
 * so a run's timings/attributes can be inspected or shipped. A full OpenTelemetry
 * SDK exporter (OTLP) is a follow-up; this is the lightweight local sink, and it
 * never throws (telemetry must never break the app).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { telemetryEnabled } from "./config-layers.js";
import { dirname, join } from "node:path";

export interface TelemetryConfig {
  enabled?: boolean;
  file?: string;
}

export interface Span {
  name: string;
  ts: string;
  ms?: number;
  attrs?: Record<string, unknown>;
}

export function telemetryFile(personaPath: string, cfg?: TelemetryConfig): string {
  return cfg?.file ?? join(dirname(personaPath), "telemetry.jsonl");
}

export function recordSpan(personaPath: string, span: Omit<Span, "ts">, cfg?: TelemetryConfig): void {
  // E10: on is a policy decision, resolved across layers, and a project can only turn
  // it OFF.
  //
  // The caller still passes the config for the file path, and the enabled flag is
  // resolved here instead of read from it. The case is concrete: somebody turns
  // telemetry off in their home config, then clones a repository whose
  // `.personaxis/config.json` turns it on. Merging by precedence lets the repository
  // win, and a decision a person made about their own machine is undone by a file they
  // downloaded.
  if (!telemetryEnabled().value) return;
  if (!cfg?.enabled) return;
  try {
    const file = telemetryFile(personaPath, cfg);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ...span, ts: new Date().toISOString() }) + "\n");
  } catch {
    /* telemetry must never break the app */
  }
}
