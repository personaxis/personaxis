import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, Tracer, parseTraceJSONL, readObservability } from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-trace-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Tracer", () => {
  it("records spans for emitted events and round-trips JSONL", () => {
    const bus = new EventBus();
    const tracer = new Tracer(bus, { trace: "jsonl", traceDir: "./traces", redact: [], sampleRate: 1 });
    bus.emit({ type: "observe", observation: "hello", source: "user" });
    bus.emit({ type: "tool-verdict", tool: "run_command", decision: "deny", reason: "deny-list" });
    bus.emit({ type: "agent-finish", summary: "done", steps: 2 });
    tracer.stop();

    const spans = tracer.getSpans();
    expect(spans.length).toBe(3);
    expect(spans[0].type).toBe("observe");
    const round = parseTraceJSONL(tracer.toJSONL());
    expect(round.length).toBe(3);
    expect(round[1].data.decision).toBe("deny");
  });

  it("produces a valid OTLP resourceSpans shape", () => {
    const bus = new EventBus();
    const tracer = new Tracer(bus);
    bus.emit({ type: "agent-step", step: 1 });
    const otlp = tracer.toOTLP() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
    expect(otlp.resourceSpans[0].scopeSpans[0].spans.length).toBe(1);
  });

  it("redacts secrets per the redact patterns", () => {
    const bus = new EventBus();
    const tracer = new Tracer(bus, { trace: "jsonl", traceDir: "./t", redact: ["Bearer\\s+\\S+", "(?i)api_key=\\S+"], sampleRate: 1 });
    bus.emit({ type: "tool-result", tool: "run_command", ok: true, output: "Authorization: Bearer sk-secret123 and api_key=abc" });
    tracer.stop();
    const text = tracer.toJSONL();
    expect(text).not.toContain("sk-secret123");
    expect(text).not.toContain("abc");
    expect(text).toContain("[redacted]");
  });

  it("writes JSONL + OTLP files under the trace dir for trace=both", () => {
    const bus = new EventBus();
    const tracer = new Tracer(bus, { trace: "both", traceDir: "./traces", redact: [], sampleRate: 1 });
    bus.emit({ type: "agent-finish", summary: "x", steps: 1 });
    const { paths } = tracer.write(join(dir, "personaxis.md"));
    tracer.stop();
    expect(paths.length).toBe(2);
    expect(paths.some((p) => p.endsWith(".jsonl"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".otlp.json"))).toBe(true);
    for (const p of paths) expect(existsSync(p)).toBe(true);
    expect(existsSync(join(dir, "traces"))).toBe(true);
  });

  it("readObservability parses the spec block", () => {
    const o = readObservability({ observability: { trace: "otlp", trace_dir: "./tr", redact: ["x"], sample_rate: 0.5 } });
    expect(o.trace).toBe("otlp");
    expect(o.traceDir).toBe("./tr");
    expect(o.sampleRate).toBe(0.5);
    expect(readObservability({}).trace).toBe("off");
  });
});
