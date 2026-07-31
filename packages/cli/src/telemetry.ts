/**
 * Opt-in telemetry (V2-F3.D21). Default OFF. When `config.telemetry.enabled` is
 * true, span records are appended as JSONL (default `.personaxis/telemetry.jsonl`)
 * so a run's timings/attributes can be inspected or shipped. A full OpenTelemetry
 * SDK exporter (OTLP) is a follow-up; this is the lightweight local sink, and it
 * never throws (telemetry must never break the app).
 */

import { appendFileSync, mkdirSync } from "node:fs";
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
  if (!cfg?.enabled) return;
  try {
    const file = telemetryFile(personaPath, cfg);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ...span, ts: new Date().toISOString() }) + "\n");
  } catch {
    /* telemetry must never break the app */
  }
}
