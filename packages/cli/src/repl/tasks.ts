/**
 * Background agent tasks (V2-F3.B10; V5.P2.7 structured).
 *
 * `/bg <prompt>` spawns a detached headless `personaxis -p` run recording
 * STRUCTURED stream-json events (init/tokens/result), plus a state-mutation
 * snapshot so `/tasks <id>` can say what changed while the task ran. The FIRST
 * consult of a finished task surfaces one summary into the conversation (so
 * context and /compact see it exactly once); re-consults only display.
 * Records live in `.personaxis/tasks/`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { readState, loadPersona, type PersonaHandle } from "@personaxis/core";

export interface TaskRecord {
  id: string;
  prompt: string;
  status: "running" | "done";
  pid?: number;
  started: string;
  finished?: string;
  outFile: string;
  /** V5.P2.7: mutation_log length when the task started (state delta on read). */
  mutationsBefore?: number;
  /** V5.P2.7: true once the result was surfaced into the conversation. */
  surfaced?: boolean;
}

export interface TaskDetail {
  record: TaskRecord;
  /** The final reply when the structured stream carries one; else the raw tail. */
  reply: string;
  /** Structured events seen (init/token/result lines). */
  events: number;
  /** Mutations recorded on the persona since the task started. */
  mutationsSince: number;
  /**
   * The session this task wrote its transcript to, read from the run's own `init` event.
   * It is what makes a background task CONTINUABLE: the conversation exists on disk, so it
   * can be loaded into the live REPL instead of being a dead end.
   */
  sessionId?: string;
}

export function tasksDir(personaPath: string): string {
  return join(dirname(personaPath), "tasks");
}

function recordPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

export function writeTask(personaPath: string, rec: TaskRecord): void {
  const dir = tasksDir(personaPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(recordPath(dir, rec.id), JSON.stringify(rec, null, 2));
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** List tasks newest-first, refreshing a "running" record whose process is gone. */
export function listTasks(personaPath: string): TaskRecord[] {
  const dir = tasksDir(personaPath);
  if (!existsSync(dir)) return [];
  const out: TaskRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf-8")) as TaskRecord;
      if (rec.status === "running" && !alive(rec.pid)) {
        rec.status = "done";
        rec.finished = rec.finished ?? new Date().toISOString();
        writeFileSync(join(dir, f), JSON.stringify(rec, null, 2));
      }
      out.push(rec);
    } catch {
      /* skip a corrupt record */
    }
  }
  return out.sort((a, b) => b.started.localeCompare(a.started));
}

export function readTaskOutput(personaPath: string, id: string): string | null {
  const dir = tasksDir(personaPath);
  const rp = recordPath(dir, id);
  if (!existsSync(rp)) return null;
  try {
    const rec = JSON.parse(readFileSync(rp, "utf-8")) as TaskRecord;
    return existsSync(rec.outFile) ? readFileSync(rec.outFile, "utf-8") : "";
  } catch {
    return null;
  }
}

/** Structured view of a task: reply + event count + the state delta (V5.P2.7). */
export function readTaskDetail(personaPath: string, id: string): TaskDetail | null {
  const raw = readTaskOutput(personaPath, id);
  const rec = listTasks(personaPath).find((t) => t.id === id);
  if (raw === null || !rec) return null;
  let reply = "";
  let events = 0;
  let sessionId: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as { type?: string; reply?: string; session_id?: string };
      events++;
      if (ev.type === "result" && typeof ev.reply === "string") reply = ev.reply;
      if (typeof ev.session_id === "string") sessionId = ev.session_id;
    } catch {
      /* non-JSON line in a text-mode run */
    }
  }
  if (!reply) reply = raw.trim();
  let mutationsSince = 0;
  try {
    const handle: PersonaHandle = loadPersona(personaPath);
    const now = readState(handle.statePath).mutation_log.length;
    if (typeof rec.mutationsBefore === "number") mutationsSince = Math.max(0, now - rec.mutationsBefore);
  } catch {
    /* state unavailable: report 0 */
  }
  return { record: rec, reply, events, mutationsSince, ...(sessionId ? { sessionId } : {}) };
}

/** Mark a task as surfaced into the conversation (first consult only). */
export function markTaskSurfaced(personaPath: string, id: string): void {
  const rec = listTasks(personaPath).find((t) => t.id === id);
  if (!rec || rec.surfaced) return;
  rec.surfaced = true;
  writeTask(personaPath, rec);
}

/** Spawn a detached headless run and register it. */
export function startTask(personaPath: string, prompt: string): TaskRecord {
  const dir = tasksDir(personaPath);
  mkdirSync(dir, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 6);
  const outFile = join(dir, `${id}.out`);
  const fd = openSync(outFile, "w");
  // V5.P2.7: stream-json output = structured events in the .out file, and a
  // mutation snapshot so the read side can report the state delta.
  const child = spawn(process.execPath, [process.argv[1], "-p", prompt, "--persona", personaPath, "--output-format", "stream-json"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, PERSONAXIS_NO_UPDATE_CHECK: "1" },
  });
  child.unref();
  let mutationsBefore = 0;
  try {
    mutationsBefore = readState(loadPersona(personaPath).statePath).mutation_log.length;
  } catch {
    /* fresh persona without state yet */
  }
  const rec: TaskRecord = {
    id,
    prompt,
    status: "running",
    pid: child.pid,
    started: new Date().toISOString(),
    outFile,
    mutationsBefore,
  };
  writeTask(personaPath, rec);
  return rec;
}
