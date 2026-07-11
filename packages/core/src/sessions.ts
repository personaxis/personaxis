/**
 * Conversation sessions, persistent, per-persona chat history (F3).
 *
 * The REPL keeps the live conversation in memory and re-sends it each turn; that is
 * correct for continuity but vanishes on exit. Sessions persist it so a user can leave
 * and `/resume`, the way Claude Code does. Layout mirrors the rest of the persona's
 * artifacts and recurses: the root's sessions live in `.personaxis/sessions/`, a sub's in
 * `.personaxis/personas/<slug>/sessions/`. One append-only `<id>.jsonl` per conversation:
 * a header line + one line per turn.
 *
 * Dependency-free (node:fs only), like memory.ts, sessions are a runtime artifact with
 * no schema (same status as episodic.jsonl / self-edits.jsonl).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ChatMessage } from "./tool-calling.js";

export type SessionKind = "root" | "sub" | "direct-sub" | "delegation";

export interface SessionHeader {
  type: "header";
  id: string;
  kind: SessionKind;
  participants: string[];
  name: string;
  created: string;
  /** Hierarchical address of the owning persona ("" = root), provenance. */
  persona: string;
}

export interface SessionTurn {
  type: "turn";
  /** "note" marks a non-conversational provenance entry (e.g. a delegation record).
   *  "summary" is a persisted /compact checkpoint: on reload it REPLACES every turn before it
   *  (which stay in the file for audit) and the verbatim turns after it are kept. */
  role: "user" | "assistant" | "note" | "summary";
  content: string;
  ts: string;
  /** Who produced an assistant/note turn (address; "(root)" for the root). */
  from?: string;
  /** FR.6 threading (Claude Code's transcript shape): this turn's stable id. */
  uuid?: string;
  /** FR.6: the uuid this turn replies to, makes branches/regenerations explicit. */
  parent_uuid?: string;
}

export interface SessionSummary {
  id: string;
  name: string;
  kind: SessionKind;
  created: string;
  updated: string;
  turns: number;
  path: string;
}

export function sessionsDir(personaPath: string): string {
  return join(dirname(personaPath), "sessions");
}

function sessionFile(personaPath: string, id: string): string {
  return join(sessionsDir(personaPath), `${id}.jsonl`);
}

/** A filesystem-safe, sortable session id (ISO timestamp + short random suffix). */
export function newSessionId(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}-${rand}`;
}

/** Create the session file with its header. No-op if it already exists. */
export function ensureSession(personaPath: string, header: Omit<SessionHeader, "type">): void {
  const p = sessionFile(personaPath, header.id);
  if (existsSync(p)) return;
  mkdirSync(sessionsDir(personaPath), { recursive: true });
  writeFileSync(p, JSON.stringify({ type: "header", ...header }) + "\n", "utf-8");
}

/** Append one turn. Requires the session to already exist (call ensureSession first).
 * Returns the turn's uuid (generated when not supplied) for parent_uuid threading. */
export function appendTurn(
  personaPath: string,
  id: string,
  turn: {
    role: SessionTurn["role"];
    content: string;
    from?: string;
    ts?: string;
    uuid?: string;
    parentUuid?: string;
  },
): string | undefined {
  const p = sessionFile(personaPath, id);
  if (!existsSync(p)) return undefined;
  const uuid = turn.uuid ?? randomUUID();
  const entry: SessionTurn = {
    type: "turn",
    ts: turn.ts ?? new Date().toISOString(),
    role: turn.role,
    content: turn.content,
    uuid,
    ...(turn.parentUuid ? { parent_uuid: turn.parentUuid } : {}),
    ...(turn.from ? { from: turn.from } : {}),
  };
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
  return uuid;
}

function parseRows(p: string): Array<SessionHeader | SessionTurn> {
  const rows: Array<SessionHeader | SessionTurn> = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as SessionHeader | SessionTurn);
    } catch {
      /* skip a corrupt line */
    }
  }
  return rows;
}

export function readSession(personaPath: string, id: string): { header?: SessionHeader; turns: SessionTurn[] } {
  const p = sessionFile(personaPath, id);
  if (!existsSync(p)) return { turns: [] };
  const rows = parseRows(p);
  return {
    header: rows.find((r) => r.type === "header") as SessionHeader | undefined,
    turns: rows.filter((r) => r.type === "turn") as SessionTurn[],
  };
}

/**
 * Persist a /compact checkpoint. Appends a `summary` turn; on reload it replaces every earlier
 * turn (kept in the file for audit) so `/resume` returns the COMPACTED conversation, not the raw
 * bloat. Verbatim turns appended AFTER this checkpoint are preserved until the next compaction.
 * Best-effort: no-op if the session file doesn't exist yet.
 */
export function recordCompaction(personaPath: string, id: string, summary: string): void {
  appendTurn(personaPath, id, { role: "summary", content: summary });
}

/**
 * Rehydrate a session into a ChatMessage[] for the agent. Notes are dropped. If a /compact
 * checkpoint (summary turn) exists, the LAST one replaces everything before it: the rehydrated
 * conversation is `[<summary as a user message>, ...verbatim turns appended after the checkpoint]`.
 */
export function loadConversation(personaPath: string, id: string): ChatMessage[] {
  const turns = readSession(personaPath, id).turns;
  let lastSummary = -1;
  for (let i = 0; i < turns.length; i++) if (turns[i].role === "summary") lastSummary = i;
  const out: ChatMessage[] = [];
  if (lastSummary >= 0) {
    out.push({ role: "user", content: `<summary of earlier conversation>\n${turns[lastSummary].content}\n</summary>` });
  }
  for (let i = lastSummary + 1; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === "user" || t.role === "assistant") out.push({ role: t.role, content: t.content });
  }
  return out;
}

/** All sessions for a persona, newest-activity first. */
export function listSessions(personaPath: string): SessionSummary[] {
  const dir = sessionsDir(personaPath);
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.slice(0, -6);
    const { header, turns } = readSession(personaPath, id);
    out.push({
      id,
      name: header?.name ?? id,
      kind: header?.kind ?? "root",
      created: header?.created ?? "",
      updated: turns.at(-1)?.ts ?? header?.created ?? "",
      turns: turns.filter((t) => t.role === "user" || t.role === "assistant").length,
      path: sessionFile(personaPath, id),
    });
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Set a session's display name (rewrites the header line). */
export function renameSession(personaPath: string, id: string, name: string): void {
  const p = sessionFile(personaPath, id);
  if (!existsSync(p)) return;
  const rows = parseRows(p);
  const header = rows.find((r) => r.type === "header") as SessionHeader | undefined;
  if (!header) return;
  header.name = name;
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

/** Resolve a session by exact id, else by case-insensitive name fragment (newest first). */
export function findSession(personaPath: string, query: string): SessionSummary | undefined {
  const all = listSessions(personaPath);
  return all.find((s) => s.id === query) ?? all.find((s) => s.name.toLowerCase().includes(query.toLowerCase()));
}

/** Deterministic fallback title from the first user message. */
export function fallbackName(firstMessage: string): string {
  const words = firstMessage.trim().replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");
  return (words || "session").slice(0, 48);
}

/** Auto-title a session from its first user message via the LLM (best-effort; may throw). */
export async function nameSession(
  llm: { endpoint: string; model: string; apiKey?: string; fetchImpl?: typeof fetch },
  firstMessage: string,
): Promise<string> {
  const fetchImpl = llm.fetchImpl ?? fetch;
  const res = await fetchImpl(`${llm.endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}) },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: "You title chat sessions. Reply with ONLY a 2-5 word title in Title Case. No quotes, no trailing punctuation." },
        { role: "user", content: `First message:\n${firstMessage.slice(0, 400)}` },
      ],
      temperature: 0,
      max_tokens: 16,
    }),
  });
  if (!res.ok) throw new Error(`namer HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const out = (json.choices?.[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "").replace(/[.]+$/, "");
  if (!out) throw new Error("empty title");
  return out.slice(0, 60);
}
