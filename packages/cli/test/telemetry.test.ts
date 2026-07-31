import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSpan, telemetryFile } from "../src/telemetry.js";

describe("opt-in telemetry (V2-F3.D21)", () => {
  let personaPath: string;
  let file: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "pxs-otel-"));
    personaPath = join(dir, "personaxis.md");
    file = join(dir, "t.jsonl");
  });

  it("no-ops when disabled (default OFF)", () => {
    recordSpan(personaPath, { name: "x" }, { file });
    recordSpan(personaPath, { name: "x" }, undefined);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(telemetryFile(personaPath))).toBe(false);
  });

  it("appends a JSONL span when enabled", () => {
    recordSpan(personaPath, { name: "turn", ms: 12, attrs: { format: "text" } }, { enabled: true, file });
    expect(existsSync(file)).toBe(true);
    const span = JSON.parse(readFileSync(file, "utf-8").trim()) as { name: string; ms: number; ts: string };
    expect(span.name).toBe("turn");
    expect(span.ms).toBe(12);
    expect(typeof span.ts).toBe("string");
  });
});
