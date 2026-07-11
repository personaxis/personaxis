import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationFromHookPayload, resolveObservePersona } from "../src/commands/observe.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-obs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("observationFromHookPayload, turning a host hook into an observation", () => {
  it("extracts the last user+assistant exchange from a Claude Code transcript", () => {
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: "user", content: "old message" }),
        JSON.stringify({ role: "user", content: "keep answers brief" }),
        JSON.stringify({ role: "assistant", content: "Understood." }),
      ].join("\n") + "\n",
    );
    const obs = observationFromHookPayload(JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript }));
    expect(obs).toContain("keep answers brief");
    expect(obs).toContain("Understood");
    expect(obs).not.toContain("old message"); // only the last exchange
  });

  it("handles array-shaped content blocks", () => {
    const transcript = join(dir, "t2.jsonl");
    writeFileSync(transcript, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "hello there" }] } }) + "\n");
    const obs = observationFromHookPayload(JSON.stringify({ transcript_path: transcript }));
    expect(obs).toContain("hello there");
  });

  it("falls back to a `prompt`/`message` field, then to raw text", () => {
    expect(observationFromHookPayload(JSON.stringify({ prompt: "do the thing" }))).toBe("do the thing");
    expect(observationFromHookPayload("just raw text")).toBe("just raw text");
  });

  it("returns undefined for an empty payload (a no-op, not an error)", () => {
    expect(observationFromHookPayload("")).toBeUndefined();
    expect(observationFromHookPayload("   ")).toBeUndefined();
  });
});

describe("resolveObservePersona", () => {
  it("resolves an explicit --persona path, or undefined when absent", () => {
    const p = join(dir, ".personaxis", "personaxis.md");
    expect(resolveObservePersona(p)).toBeUndefined(); // not created
    writeFileSync(join(dir, "x.md"), "spec");
    expect(resolveObservePersona(join(dir, "x.md"))).toBe(join(dir, "x.md"));
  });
});
