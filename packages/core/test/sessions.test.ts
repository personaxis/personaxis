import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newSessionId,
  ensureSession,
  appendTurn,
  readSession,
  loadConversation,
  listSessions,
  renameSession,
  findSession,
  fallbackName,
  sessionsDir,
  recordCompaction,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-sess-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hdr = (id: string) => ({
  id,
  kind: "root" as const,
  participants: ["(root)"],
  name: fallbackName("hello there world"),
  created: new Date().toISOString(),
  persona: "",
});

describe("sessions (F3)", () => {
  it("ids are unique and filesystem-safe", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[:.]/);
  });

  it("ensure + append + read round-trips a conversation", () => {
    const id = newSessionId();
    ensureSession(personaPath, hdr(id));
    appendTurn(personaPath, id, { role: "user", content: "hi" });
    appendTurn(personaPath, id, { role: "assistant", content: "hello", from: "(root)" });
    appendTurn(personaPath, id, { role: "note", content: "Delegated to @cmo", from: "(root)" });

    const { header, turns } = readSession(personaPath, id);
    expect(header?.name).toBe("hello there world");
    expect(turns).toHaveLength(3);

    const conv = loadConversation(personaPath, id);
    expect(conv).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]); // the note is dropped from the rehydrated context
  });

  it("ensureSession is idempotent (does not clobber existing turns)", () => {
    const id = newSessionId();
    ensureSession(personaPath, hdr(id));
    appendTurn(personaPath, id, { role: "user", content: "one" });
    ensureSession(personaPath, hdr(id)); // second call: no-op
    expect(readSession(personaPath, id).turns).toHaveLength(1);
  });

  it("lists newest-first, counts non-note turns, and renames", () => {
    const a = newSessionId(new Date("2026-06-01T00:00:00Z"));
    const b = newSessionId(new Date("2026-06-02T00:00:00Z"));
    ensureSession(personaPath, hdr(a));
    appendTurn(personaPath, a, { role: "user", content: "x", ts: "2026-06-01T00:00:01Z" });
    ensureSession(personaPath, hdr(b));
    appendTurn(personaPath, b, { role: "user", content: "y", ts: "2026-06-02T00:00:01Z" });

    const list = listSessions(personaPath);
    expect(list[0].id).toBe(b); // newest activity first
    expect(list[0].turns).toBe(1);

    renameSession(personaPath, a, "My Topic");
    expect(findSession(personaPath, "my topic")?.id).toBe(a);
    expect(findSession(personaPath, a)?.id).toBe(a); // by exact id too
  });

  it("sessionsDir sits beside the persona spec", () => {
    expect(sessionsDir(personaPath)).toBe(join(dir, ".personaxis", "sessions"));
    expect(listSessions(personaPath)).toEqual([]); // none yet
    expect(existsSync(sessionsDir(personaPath))).toBe(false);
  });

  it("a persisted /compact checkpoint survives reload: summary replaces older turns, later turns kept", () => {
    const id = newSessionId();
    ensureSession(personaPath, hdr(id));
    appendTurn(personaPath, id, { role: "user", content: "q1" });
    appendTurn(personaPath, id, { role: "assistant", content: "a1" });
    appendTurn(personaPath, id, { role: "user", content: "q2" });
    appendTurn(personaPath, id, { role: "assistant", content: "a2" });

    recordCompaction(personaPath, id, "User asked q1 and q2; assistant answered a1, a2.");
    // a turn AFTER the checkpoint is preserved verbatim
    appendTurn(personaPath, id, { role: "user", content: "q3-after-compact" });

    const conv = loadConversation(personaPath, id);
    // [0] = the summary (as a user message), then only the post-checkpoint verbatim turn.
    expect(conv[0].role).toBe("user");
    expect(conv[0].content).toContain("q1 and q2");
    expect(conv.some((m) => m.content === "q3-after-compact")).toBe(true);
    // the raw pre-checkpoint turns are NOT rehydrated (folded into the summary)…
    expect(conv.some((m) => m.content === "q1")).toBe(false);
    expect(conv.some((m) => m.content === "a2")).toBe(false);
    // …but they remain in the file for audit.
    expect(readSession(personaPath, id).turns.some((t) => t.content === "q1")).toBe(true);
    // the summary row is not counted as a conversational turn.
    expect(listSessions(personaPath)[0].turns).toBe(5); // q1,a1,q2,a2,q3 (summary excluded)
  });
});
