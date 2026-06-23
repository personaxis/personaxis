/**
 * Observability / causal trace (v0.9 — spec `observability`).
 *
 * The engine already produces the raw material of a great trace: every step of
 * the governed loops is an auditable event on the EventBus, and every state change
 * is in the hash-chained mutation_log. 2026 production-agent practice (Braintrust /
 * Arize / Microsoft Foundry) is unanimous that observability must be *causal
 * tracing*, not response logging, and exportable to standard tooling. So a Tracer
 * subscribes to a bus and serializes spans two ways:
 *   - native JSONL (line-delimited, diff-able, dependency-free)
 *   - OTLP-JSON (OpenTelemetry-compatible; plugs into Braintrust/Arize/Foundry)
 *
 * Secrets are redacted per `observability.redact` before anything is written.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EventBus, type LoopEvent } from "./events.js";

export type TraceFormat = "jsonl" | "otlp" | "both" | "off";

export interface ObservabilityConfig {
  trace: TraceFormat;
  traceDir: string;
  redact: string[];
  sampleRate: number;
}

export const DEFAULT_OBSERVABILITY: ObservabilityConfig = {
  trace: "off",
  traceDir: "./traces",
  redact: [],
  sampleRate: 1,
};

export function readObservability(frontmatter: Record<string, unknown>): ObservabilityConfig {
  const o = frontmatter.observability as Partial<Record<string, unknown>> | undefined;
  if (!o) return { ...DEFAULT_OBSERVABILITY };
  const trace = o.trace === "jsonl" || o.trace === "otlp" || o.trace === "both" ? o.trace : "off";
  return {
    trace,
    traceDir: typeof o.trace_dir === "string" ? o.trace_dir : DEFAULT_OBSERVABILITY.traceDir,
    redact: Array.isArray(o.redact) ? o.redact.filter((r): r is string => typeof r === "string") : [],
    sampleRate: typeof o.sample_rate === "number" && o.sample_rate >= 0 && o.sample_rate <= 1 ? o.sample_rate : 1,
  };
}

export interface TraceSpan {
  /** ISO timestamp. */
  ts: string;
  /** Milliseconds since trace start. */
  t_ms: number;
  /** Monotonic index. */
  seq: number;
  /** Event type (span name). */
  type: string;
  /** Redacted event payload (everything except `type`). */
  data: Record<string, unknown>;
}

function compileRedactors(patterns: string[]): RegExp[] {
  return patterns
    .map((raw) => {
      // JS has no inline-flag groups like (?i); strip a leading one (we already
      // compile case-insensitive) so specs written with (?i)/(?im) still work.
      const p = raw.replace(/^\(\?[a-z]+\)/i, "");
      try {
        return new RegExp(p, "gi");
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

function redactValue(value: unknown, redactors: RegExp[]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const r of redactors) s = s.replace(r, "[redacted]");
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redactors));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, redactors);
    return out;
  }
  return value;
}

/** Subscribes to a bus and records redacted spans; exports JSONL + OTLP. */
export class Tracer {
  private readonly spans: TraceSpan[] = [];
  private readonly start = Date.now();
  private seq = 0;
  private readonly redactors: RegExp[];
  private readonly off: () => void;

  constructor(
    private readonly bus: EventBus,
    private readonly cfg: ObservabilityConfig = DEFAULT_OBSERVABILITY,
  ) {
    this.redactors = compileRedactors(cfg.redact);
    this.off = bus.on((e) => this.record(e));
  }

  private record(e: LoopEvent): void {
    if (this.cfg.sampleRate < 1 && Math.random() > this.cfg.sampleRate) return;
    const { type, ...rest } = e as LoopEvent & Record<string, unknown>;
    this.spans.push({
      ts: new Date().toISOString(),
      t_ms: Date.now() - this.start,
      seq: this.seq++,
      type,
      data: redactValue(rest, this.redactors) as Record<string, unknown>,
    });
  }

  /** Detach from the bus. */
  stop(): void {
    this.off();
  }

  getSpans(): TraceSpan[] {
    return this.spans;
  }

  toJSONL(): string {
    return this.spans.map((s) => JSON.stringify(s)).join("\n") + (this.spans.length ? "\n" : "");
  }

  /** OpenTelemetry OTLP/JSON (trace) shape — point spans (start == end). */
  toOTLP(): unknown {
    const toNano = (ms: number) => String((this.start + ms) * 1_000_000);
    return {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "personaxis" } }] },
          scopeSpans: [
            {
              scope: { name: "personaxis.loop" },
              spans: this.spans.map((s) => ({
                name: s.type,
                startTimeUnixNano: toNano(s.t_ms),
                endTimeUnixNano: toNano(s.t_ms),
                attributes: Object.entries(s.data).map(([k, v]) => ({
                  key: k,
                  value: { stringValue: typeof v === "string" ? v : JSON.stringify(v) },
                })),
              })),
            },
          ],
        },
      ],
    };
  }

  /**
   * Write the configured trace formats. `target` is a persona path or a directory;
   * files land under `<target dir>/<traceDir>/trace-<ts>.{jsonl,otlp.json}`.
   */
  write(target: string, formatOverride?: TraceFormat): { paths: string[] } {
    const fmt = formatOverride ?? this.cfg.trace;
    if (fmt === "off") return { paths: [] };
    const baseDir = resolve(dirname(target), this.cfg.traceDir);
    mkdirSync(baseDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const paths: string[] = [];
    if (fmt === "jsonl" || fmt === "both") {
      const p = join(baseDir, `trace-${stamp}.jsonl`);
      writeFileSync(p, this.toJSONL(), "utf-8");
      paths.push(p);
    }
    if (fmt === "otlp" || fmt === "both") {
      const p = join(baseDir, `trace-${stamp}.otlp.json`);
      writeFileSync(p, JSON.stringify(this.toOTLP(), null, 2), "utf-8");
      paths.push(p);
    }
    for (const p of paths) this.bus.emit({ type: "trace-exported", format: p.endsWith(".jsonl") ? "jsonl" : "otlp", path: p, spanCount: this.spans.length });
    return { paths };
  }
}

/** Parse a native JSONL trace file's text into spans (for the viewer). */
export function parseTraceJSONL(text: string): TraceSpan[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceSpan);
}
