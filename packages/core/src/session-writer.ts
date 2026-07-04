/**
 * FR.6 — background session writer + derived index.
 *
 * The Codex rollout-writer pattern: turns enter an in-memory queue and a single
 * background drain appends them IN ORDER; `flush()` acks when everything queued
 * so far is on disk, `shutdown()` drains and closes deterministically. A crash
 * between queue and drain loses at most the un-acked tail — and a caller that
 * needs durability awaits `flush()` at the turn boundary.
 *
 * The index (`sessions/index.json`) is DERIVED — rebuildable at any time from
 * the JSONL files (the source of truth). No SQLite (bun-compile forbids native
 * addons; persona = git-versionable plain files is a standing requirement).
 */

import { appendFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureSession,
  listSessions,
  sessionsDir,
  type SessionHeader,
  type SessionSummary,
  type SessionTurn,
} from "./sessions.js";
import { randomUUID } from "node:crypto";

export class SessionWriter {
  private queue: string[] = [];
  private draining: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly file: string;
  /** The last turn's uuid — the next turn's parent by default (threading). */
  lastUuid: string | undefined;

  constructor(
    private readonly personaPath: string,
    header: Omit<SessionHeader, "type">,
  ) {
    ensureSession(personaPath, header);
    this.file = join(sessionsDir(personaPath), `${header.id}.jsonl`);
  }

  /**
   * Queue one turn (non-blocking). Threads automatically: parent_uuid defaults
   * to the previous turn's uuid. Returns this turn's uuid.
   */
  append(turn: {
    role: SessionTurn["role"];
    content: string;
    from?: string;
    uuid?: string;
    parentUuid?: string;
  }): string {
    if (this.closed) throw new Error("session writer is shut down");
    const uuid = turn.uuid ?? randomUUID();
    const entry: SessionTurn = {
      type: "turn",
      ts: new Date().toISOString(),
      role: turn.role,
      content: turn.content,
      uuid,
      ...(turn.parentUuid ?? this.lastUuid ? { parent_uuid: turn.parentUuid ?? this.lastUuid } : {}),
      ...(turn.from ? { from: turn.from } : {}),
    };
    this.lastUuid = uuid;
    this.queue.push(JSON.stringify(entry) + "\n");
    this.scheduleDrain();
    return uuid;
  }

  /** Resolves when everything queued SO FAR is on disk (the Flush ack). */
  flush(): Promise<void> {
    this.scheduleDrain();
    return this.draining;
  }

  /** Drain, then refuse further writes (the Shutdown ack). */
  async shutdown(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private scheduleDrain(): void {
    if (this.queue.length === 0) return;
    this.draining = this.draining.then(async () => {
      while (this.queue.length > 0) {
        // Batch whatever accumulated — one append syscall per drain pass.
        const batch = this.queue.join("");
        this.queue = [];
        await appendFile(this.file, batch, "utf-8");
      }
    });
  }
}

// ── derived index ─────────────────────────────────────────────────────────────

const INDEX_FILE = "index.json";

export interface SessionIndex {
  /** ISO timestamp the index was (re)built. */
  built: string;
  sessions: SessionSummary[];
}

/** Rebuild sessions/index.json from the JSONL files (the source of truth). */
export async function rebuildSessionIndex(personaPath: string): Promise<SessionIndex> {
  const index: SessionIndex = { built: new Date().toISOString(), sessions: listSessions(personaPath) };
  const dir = sessionsDir(personaPath);
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, INDEX_FILE), JSON.stringify(index, null, 2) + "\n", "utf-8");
  return index;
}

/**
 * Fast session listing: reads the derived index when present, falling back to
 * (and lazily rebuilding from) the JSONL scan when missing or unreadable.
 */
export function readSessionIndex(personaPath: string): SessionIndex {
  const p = join(sessionsDir(personaPath), INDEX_FILE);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as SessionIndex;
    } catch {
      /* corrupt index — fall through to the source of truth */
    }
  }
  const fresh: SessionIndex = { built: new Date().toISOString(), sessions: listSessions(personaPath) };
  void rebuildSessionIndex(personaPath).catch(() => {});
  return fresh;
}
