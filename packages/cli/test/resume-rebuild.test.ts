/**
 * Resuming a session REBUILDS it: the current conversation (which belongs to a different
 * session) disappears, and the chosen chat reappears exactly as it was left, rather than
 * being continued underneath whatever is already on screen.
 *
 * Resuming closes the outgoing session, loads the chosen one, and hands back the
 * transcript to re-print after the screen is wiped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSession, appendTurn, newSessionId, listSessions } from "@personaxis/core";
import { makeCtx, resumeSessionInto, replayTranscript } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { writeStarterPersona } from "../src/starter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-resume-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedSession(personaPath: string, name: string, turns: Array<[string, string]>): string {
  const id = newSessionId();
  ensureSession(personaPath, {
    id,
    kind: "root",
    participants: ["(root)"],
    name,
    created: new Date().toISOString(),
  });
  for (const [user, assistant] of turns) {
    appendTurn(personaPath, id, { role: "user", content: user });
    appendTurn(personaPath, id, { role: "assistant", content: assistant, from: "(root)" });
  }
  return id;
}

describe("resume rebuilds the conversation (V7.A6)", () => {
  it("loads the chosen session's full history into the context", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    const id = seedSession(personaPath, "planning", [
      ["cuál es el plan", "primero validamos el spec"],
      ["y después", "compilamos y medimos el drift"],
    ]);

    const s = resumeSessionInto(ctx, id);
    expect(s?.name).toBe("planning");
    expect(ctx.sessionId).toBe(id);
    expect(ctx.conversation).toHaveLength(4);
  });

  it("replayTranscript returns every turn, in order, with the right roles", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    const id = seedSession(personaPath, "planning", [
      ["cuál es el plan", "primero validamos el spec"],
      ["y después", "compilamos y medimos el drift"],
    ]);
    resumeSessionInto(ctx, id);

    const lines = replayTranscript(ctx);
    const spoken = lines.filter((l) => l.role === "user" || l.role === "persona");
    expect(spoken.map((l) => l.role)).toEqual(["user", "persona", "user", "persona"]);
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("cuál es el plan");
    expect(text).toContain("primero validamos el spec");
    expect(text).toContain("y después");
    expect(text).toContain("compilamos y medimos el drift");
  });

  /**
   * The rebuilt chat has to LOOK like the chat. It used to print user and reply
   * lines back to back with no separators, so a long history arrived as one
   * undifferentiated block.
   */
  it("reprints the chrome a live turn gets: a divider opens each exchange", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    resumeSessionInto(
      ctx,
      seedSession(personaPath, "planning", [
        ["uno", "respuesta uno"],
        ["dos", "respuesta dos"],
      ]),
    );
    const lines = replayTranscript(ctx);
    expect(lines.filter((l) => l.role === "divider")).toHaveLength(2); // one per exchange
    expect(lines[0].role, "each exchange opens with its divider").toBe("divider");
    expect(lines[1].role).toBe("user");
  });

  /**
   * A transcript of only the words is not the conversation you had. The evidence
   * block (recalled memory, evolution, self-edits) is recorded with the turn and
   * reprinted, so resuming shows the WORK too.
   */
  it("reprints what the persona DID on each turn, not only what it said", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    const id = newSessionId();
    ensureSession(personaPath, {
      id,
      kind: "root",
      participants: ["(root)"],
      name: "with-evidence",
      created: new Date().toISOString(),
    });
    appendTurn(personaPath, id, { role: "user", content: "cómo te llamas" });
    appendTurn(personaPath, id, { role: "assistant", content: "Vega", from: "(root)" });
    // Appended as its own note, the way a live turn records it: the evidence is
    // only known after the loop tick, once the exchange is already on disk.
    appendTurn(personaPath, id, {
      role: "note",
      content: "this turn",
      evidence: ["  ┊ this turn", "  ┊ recalled   user.name", "  ┊ memory     +1 episodic"],
    });
    resumeSessionInto(ctx, id);

    const text = replayTranscript(ctx).map((l) => l.text).join("\n");
    expect(text).toContain("recalled");
    expect(text).toContain("user.name");
    expect(text).toContain("+1 episodic");
  });

  it("the evidence note never reaches the model's context", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    const id = newSessionId();
    ensureSession(personaPath, {
      id,
      kind: "root",
      participants: ["(root)"],
      name: "n",
      created: new Date().toISOString(),
    });
    appendTurn(personaPath, id, { role: "user", content: "hola" });
    appendTurn(personaPath, id, { role: "assistant", content: "hola", from: "(root)" });
    appendTurn(personaPath, id, { role: "note", content: "this turn", evidence: ["  ┊ recalled x"] });
    resumeSessionInto(ctx, id);
    // Two messages, not three: replaying the screen must not cost context.
    expect(ctx.conversation).toHaveLength(2);
    expect(JSON.stringify(ctx.conversation)).not.toContain("recalled");
  });

  it("a session recorded before evidence existed still replays (no crash, no gap)", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    resumeSessionInto(ctx, seedSession(personaPath, "legacy", [["hola", "hola"]]));
    const lines = replayTranscript(ctx);
    expect(lines.some((l) => l.role === "user")).toBe(true);
    expect(lines.some((l) => l.role === "persona")).toBe(true);
  });

  it("switching sessions replaces the conversation instead of merging it", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    const a = seedSession(personaPath, "alpha", [["uno", "respuesta uno"]]);
    const b = seedSession(personaPath, "beta", [["dos", "respuesta dos"], ["tres", "respuesta tres"]]);

    resumeSessionInto(ctx, a);
    expect(ctx.conversation).toHaveLength(2);
    resumeSessionInto(ctx, b);
    expect(ctx.conversation).toHaveLength(4);
    const text = replayTranscript(ctx).map((l) => l.text).join("\n");
    expect(text).toContain("dos");
    expect(text).not.toContain("respuesta uno"); // the previous chat is GONE, not stacked
    expect(listSessions(personaPath).length).toBeGreaterThanOrEqual(2);
  });

  it("an unknown query resumes nothing and leaves the context untouched", () => {
    const personaPath = writeStarterPersona(dir, "Vega");
    const ctx = makeCtx(personaPath, makeMeter());
    const before = ctx.sessionId;
    expect(resumeSessionInto(ctx, "no-such-session")).toBeUndefined();
    expect(ctx.sessionId).toBe(before);
    expect(ctx.conversation).toHaveLength(0);
  });
});
