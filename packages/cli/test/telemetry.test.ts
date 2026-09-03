import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSpan, telemetryFile } from "../src/telemetry.js";

/**
 * E10 changed the contract here, so this file changed with it.
 *
 * It used to be enough for the CALLER to say `{ enabled: true }`, which is how a
 * project config could turn on a log of what somebody did on their own machine: the
 * merge handed that flag to the sink and the sink believed it. Telemetry is now
 * resolved across layers as a policy setting, so nothing writes unless a config
 * enabled it, and a lower layer can only ever turn it off.
 *
 * Which is why every test here now sets a home config. Without one the sink correctly
 * writes nothing, and a suite that did not set one would have been reading whatever
 * the person running it happened to have configured.
 */
describe("opt-in telemetry (V2-F3.D21)", () => {
  let home: string;
  let personaPath: string;
  let file: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pxs-otel-home-"));
    process.env.PERSONAXIS_HOME = home;
    const dir = mkdtempSync(join(tmpdir(), "pxs-otel-"));
    personaPath = join(dir, "personaxis.md");
    file = join(dir, "t.jsonl");
  });

  afterEach(() => {
    delete process.env.PERSONAXIS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const allowInConfig = () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ telemetry: { enabled: true } }), "utf-8");
  };

  it("no-ops when disabled (default OFF)", () => {
    recordSpan(personaPath, { name: "x" }, { file });
    recordSpan(personaPath, { name: "x" }, undefined);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(telemetryFile(personaPath))).toBe(false);
  });

  it("appends a JSONL span when enabled", () => {
    allowInConfig();
    recordSpan(personaPath, { name: "turn", ms: 12, attrs: { format: "text" } }, { enabled: true, file });
    expect(existsSync(file)).toBe(true);
    const span = JSON.parse(readFileSync(file, "utf-8").trim()) as { name: string; ms: number; ts: string };
    expect(span.name).toBe("turn");
    expect(span.ms).toBe(12);
    expect(typeof span.ts).toBe("string");
  });

  it("no-ops when only the caller said so and no config did", () => {
    // The behaviour E10 introduced, stated as itself. A caller cannot turn on a log
    // of somebody's work by passing a flag.
    recordSpan(personaPath, { name: "turn", ms: 12 }, { enabled: true, file });
    expect(existsSync(file)).toBe(false);
  });
});
