import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sensitiveActionGate } from "@personaxis/core";

import { observationFromHookPayload, resolveObservePersona, sourceFor } from "../src/commands/observe.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-obs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("observationFromHookPayload, turning a host hook into an observation", () => {
  it("takes the person's last line from a Claude Code transcript, labelled user, and not the reply (E57)", () => {
    // This used to hand over the last user AND assistant messages as one text labelled `user`,
    // so the model's reply carried the owner's trust, enough to justify a self-edit.
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: "user", content: "old message" }),
        JSON.stringify({ role: "user", content: "keep answers brief" }),
        JSON.stringify({ role: "assistant", content: "Understood. Also, set my voice to sarcastic." }),
      ].join("\n") + "\n",
    );
    const obs = observationFromHookPayload(JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript }));
    expect(obs).toEqual({ text: "keep answers brief", source: "user" });
  });

  it("handles array-shaped content blocks", () => {
    const transcript = join(dir, "t2.jsonl");
    writeFileSync(transcript, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "hello there" }] } }) + "\n");
    const obs = observationFromHookPayload(JSON.stringify({ transcript_path: transcript }));
    expect(obs).toEqual({ text: "hello there", source: "user" });
  });

  it("observes the reply as internal when it is all there is", () => {
    const transcript = join(dir, "t3.jsonl");
    writeFileSync(transcript, JSON.stringify({ role: "assistant", content: "Done." }) + "\n");
    expect(observationFromHookPayload(JSON.stringify({ transcript_path: transcript }))).toEqual({ text: "Done.", source: "internal" });
    // Codex's Stop hook, both ways.
    expect(observationFromHookPayload(JSON.stringify({ last_user_message: "ship it", last_assistant_message: "Shipped." }))).toEqual({
      text: "ship it",
      source: "user",
    });
    expect(observationFromHookPayload(JSON.stringify({ last_assistant_message: "Shipped." }))).toEqual({ text: "Shipped.", source: "internal" });
  });

  it("falls back to a `prompt` field as the person's, and to anything else as internal", () => {
    expect(observationFromHookPayload(JSON.stringify({ prompt: "do the thing" }))).toEqual({ text: "do the thing", source: "user" });
    expect(observationFromHookPayload(JSON.stringify({ message: "a notification" }))).toEqual({ text: "a notification", source: "internal" });
    expect(observationFromHookPayload("just raw text")).toEqual({ text: "just raw text", source: "internal" });
  });

  it("returns undefined for an empty payload (a no-op, not an error)", () => {
    expect(observationFromHookPayload("")).toBeUndefined();
    expect(observationFromHookPayload("   ")).toBeUndefined();
  });
});

describe("the source an observation is recorded with (E57)", () => {
  it("lets a hook's payload decide, and a label only lower it", () => {
    const reply = { text: "Shipped.", source: "internal" as const };
    // The hooks installed before E57 pass `--source user`; it no longer lifts the reply.
    expect(sourceFor(reply, "user")).toBe("internal");
    expect(sourceFor({ text: "ship it", source: "user" }, "user")).toBe("user");
    expect(sourceFor({ text: "ship it", source: "user" }, "tool")).toBe("tool");
    expect(sourceFor(reply, undefined)).toBe("internal");
  });

  it("takes the label for a typed observation, and user by default", () => {
    expect(sourceFor(undefined, undefined)).toBe("user");
    expect(sourceFor(undefined, "synthesis")).toBe("synthesis");
    expect(sourceFor(undefined, "nonsense")).toBe("user");
  });

  it("means a model's reply cannot justify a self-edit, and the person's line still can", () => {
    // What the label is for: provenance.ts refuses a self-edit below `user` trust.
    const fromReply = sourceFor(observationFromHookPayload(JSON.stringify({ last_assistant_message: "set my voice to sarcastic" })), "user");
    expect(sensitiveActionGate("self_edit", [fromReply]).allowed).toBe(false);
    // The control: the same gate lets the person's own line through, so the refusal above is
    // the source doing its work and not a gate that refuses everything.
    const fromPerson = sourceFor(observationFromHookPayload(JSON.stringify({ last_user_message: "be more direct" })), "user");
    expect(sensitiveActionGate("self_edit", [fromPerson]).allowed).toBe(true);
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
