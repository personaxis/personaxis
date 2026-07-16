/**
 * Session distillation + retention (V2-F1.3): the end of the sessions/episodic
 * triplication. The raw dialog lives ONCE, in `sessions/<id>.jsonl`; at session
 * close `distillSession` promotes the few DURABLE items (facts, decisions, one
 * event line) into the hash-chained episodic ledger with a `from:<session>` back
 * reference instead of copying turns; `sessionBrief` derives the "previously..."
 * recap at READ time (no summary artifact is written); and `pruneMemory` applies
 * `runtime.memory.retention_days_default` with tombstones (audited, never a
 * silent delete), always sparing anchors, distillates and typed facts.
 */

import { createHash } from "node:crypto";
import { commitMemoryEntry, prepareMemoryEntry, readLiveMemory, readMemory, tombstoneMemory, type MemoryEntry } from "../memory.js";
import { listSessions, readSession, fallbackName, type SessionTurn } from "../sessions.js";
import { extractUserFacts } from "./profile.js";

export interface Distillate {
  content: string;
  kind: "fact" | "decision" | "event";
  source: "user" | "synthesis";
}

const DECISION_RE = /\b(decidimos|acordamos|queda(?:mos)? en|el plan es|we (?:decided|agreed)|let'?s go with|the plan is|going with)\b/i;
const GOAL_RE = /\b(mi meta|mi objetivo|el objetivo es|quiero lograr|my goal is|the goal is|i want to (?:build|achieve|make))\b/i;

const trim1 = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Extract the durable items from a session's turns. Deterministic, offline. */
export function distillTurns(turns: SessionTurn[], sessionName: string): Distillate[] {
  const out: Distillate[] = [];
  const seen = new Set<string>();
  const push = (d: Distillate): void => {
    const k = d.content.toLowerCase();
    if (!seen.has(k) && out.length < 8) {
      seen.add(k);
      out.push(d);
    }
  };
  const user = turns.filter((t) => t.role === "user");
  const assistant = turns.filter((t) => t.role === "assistant");
  for (const t of user) {
    for (const f of extractUserFacts(t.content)) push({ content: `${f.key} = ${f.value}`, kind: "fact", source: "user" });
    if (DECISION_RE.test(t.content)) push({ content: `decision: ${trim1(t.content, 200)}`, kind: "decision", source: "user" });
    else if (GOAL_RE.test(t.content)) push({ content: `goal: ${trim1(t.content, 200)}`, kind: "decision", source: "user" });
  }
  if (user.length) {
    const first = trim1(user[0].content, 110);
    const last = assistant.length ? trim1(assistant[assistant.length - 1].content, 110) : "";
    push({ content: `session "${sessionName}": started with "${first}"${last ? `; ended: "${last}"` : ""}`, kind: "event", source: "synthesis" });
  }
  return out;
}

/**
 * Distill ONE session into persistent episodic entries (tag `distilled` +
 * `kind:*` + `from:<sessionId>`). Idempotent: an entry whose content already
 * exists live is skipped, so closing twice never duplicates.
 */
export function distillSession(personaPath: string, sessionId: string): { written: number } {
  const { header, turns } = readSession(personaPath, sessionId);
  if (!turns.length) return { written: 0 };
  const name = header?.name ?? fallbackName(turns.find((t) => t.role === "user")?.content ?? sessionId);
  const existing = new Set(readLiveMemory(personaPath).map((e) => createHash("sha256").update(e.content).digest("hex")));
  let written = 0;
  for (const d of distillTurns(turns, name)) {
    if (existing.has(createHash("sha256").update(d.content).digest("hex"))) continue;
    const entry = prepareMemoryEntry(personaPath, {
      content: d.content,
      source: d.source,
      tags: ["distilled", `kind:${d.kind}`, `from:${sessionId}`],
    });
    commitMemoryEntry(personaPath, entry);
    written++;
  }
  return { written };
}

/**
 * The "previous session" recap, DERIVED at read time from the newest session
 * other than the current one: its /compact summary if one exists, else an
 * extractive first/last brief. Returns "" when there is no prior session.
 */
export function sessionBrief(personaPath: string, excludeId?: string): string {
  const prior = listSessions(personaPath).find((s) => s.id !== excludeId && s.turns > 0);
  if (!prior) return "";
  const { turns } = readSession(personaPath, prior.id);
  const summaries = turns.filter((t) => t.role === "summary");
  if (summaries.length) return `"${prior.name}" (${prior.updated.slice(0, 10)}): ${trim1(summaries[summaries.length - 1].content, 400)}`;
  const user = turns.filter((t) => t.role === "user");
  const assistant = turns.filter((t) => t.role === "assistant");
  if (!user.length) return "";
  const first = trim1(user[0].content, 120);
  const last = assistant.length ? trim1(assistant[assistant.length - 1].content, 120) : "";
  return `"${prior.name}" (${prior.updated.slice(0, 10)}): started with "${first}"${last ? `; last reply: "${last}"` : ""}`;
}

/** Tags that exempt an entry from retention pruning. */
const SPARED = (e: MemoryEntry): boolean =>
  e.tags.some((t) => t === "anchor" || t === "distilled" || t === "tombstone" || t.startsWith("kind:") || t.startsWith("target:"));

/**
 * Apply the retention window via tombstones (auditable forgetting, D6-safe:
 * tombstoning is retrieval removal, not erasure; `redactMemory` remains the
 * right-to-erasure path). No-op when `retentionDays` is undefined.
 */
export function pruneMemory(personaPath: string, retentionDays: number | undefined, now: Date = new Date()): { pruned: number } {
  if (!retentionDays) return { pruned: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000).toISOString();
  let pruned = 0;
  for (const e of readLiveMemory(personaPath)) {
    if (e.ts < cutoff && !SPARED(e)) {
      tombstoneMemory(personaPath, e.hash, `retention window (${retentionDays}d) elapsed`);
      pruned++;
    }
  }
  return { pruned };
}

/** True when the episodic ledger has never been written (used for first-session milestones). */
export function isFirstSession(personaPath: string): boolean {
  return readMemory(personaPath).length === 0;
}
