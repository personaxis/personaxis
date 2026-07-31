/**
 * Forensic telemetry (K.10): an append-only, hash-chained record of every security decision
 * the agent makes (tool calls allowed/denied, injection findings, aborts). Without it a
 * security-relevant decision leaves no evidence (threat T15), and "what did the agent do, and
 * was any of it altered" is unanswerable.
 *
 * Two properties make it forensic rather than a plain log:
 *   - Records are FROZEN on creation, so nothing in-process can rewrite one after the fact.
 *   - Each record commits to the previous one's hash, so any alteration to a persisted log is
 *     detectable at a specific position (the same tamper-evidence the memory chain uses).
 *
 * It is a sink, never a gate: recording must not be able to throw into the agent loop, and a
 * full or unwritable log must not stop the agent. Enforcement is the interceptor's job (K.03);
 * this only bears witness.
 */

import { createHash } from "node:crypto";

/** A security-relevant event, before it is sealed into the chain. */
export interface ForensicEvent {
  kind: "tool-call" | "consent" | "injection" | "abort";
  tool?: string;
  decision?: "allow" | "ask" | "deny";
  /** Whether the action actually ran (false for a denial). */
  executed?: boolean;
  ok?: boolean;
  reason?: string;
  outputVerdict?: "clean" | "suspicious" | "malicious";
  detail?: string;
}

/** A sealed record: the event plus its position, time, and hash-chain links. */
export interface ForensicRecord extends ForensicEvent {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
}

function hashOf(entry: Omit<ForensicRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/**
 * Verify a chain: returns the seq of the first broken record, or -1 if intact. Pure, so a log
 * loaded from disk can be checked without instantiating the writer.
 */
export function verifyForensicChain(records: readonly ForensicRecord[]): number {
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const expectedPrev = i === 0 ? "" : records[i - 1]!.hash;
    if (r.prevHash !== expectedPrev) return i;
    const { hash, ...rest } = r;
    if (hashOf(rest) !== hash) return i;
  }
  return -1;
}

export class ForensicLog {
  private readonly records: ForensicRecord[] = [];

  /** `sink` persists each sealed record (e.g. to disk); optional, and never allowed to throw. */
  constructor(private readonly sink?: (record: Readonly<ForensicRecord>) => void) {}

  /** Seal an event into the chain and return the frozen record. */
  append(event: ForensicEvent): Readonly<ForensicRecord> {
    const seq = this.records.length;
    const prevHash = seq === 0 ? "" : this.records[seq - 1]!.hash;
    const base = { ...event, seq, ts: new Date().toISOString(), prevHash };
    const record: ForensicRecord = Object.freeze({ ...base, hash: hashOf(base) });
    this.records.push(record);
    try {
      this.sink?.(record);
    } catch {
      /* forensics bears witness; it must never break the thing it is witnessing */
    }
    return record;
  }

  entries(): ReadonlyArray<Readonly<ForensicRecord>> {
    return this.records;
  }

  /** First broken seq, or -1 if the whole chain is intact. */
  verify(): number {
    return verifyForensicChain(this.records);
  }
}
