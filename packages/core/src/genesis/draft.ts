/**
 * INTERVIEW DRAFTS: leaving the interview must not throw the answers away.
 *
 * The deep interview is twenty questions. Abandoning it halfway and losing everything is
 * the kind of small cruelty that stops people from starting at all, so answers are written
 * as they are given and offered back on the next run.
 *
 * Deliberately NOT a permanent artifact: the draft lives beside the project's `.personaxis`
 * directory, is deleted the moment the persona is created, and holds nothing but the
 * answers already typed. It is a crash-safety file, not a new part of the model, and the
 * spec keeps a single source of truth for a finished persona.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InterviewAnswers } from "./interview.js";

export interface InterviewDraft {
  /** Answers recorded so far, keyed by item id. */
  answers: InterviewAnswers;
  /** Which interview was running, so resuming asks the same set. */
  depth: "core" | "deep";
  /** Slug the run was creating, when one was given. */
  slug?: string;
  /** ISO timestamp of the last write. */
  updated: string;
  /** Bank version: a draft from an older question set is not resumable. */
  bankVersion: string;
}

export function draftPath(dir: string): string {
  return join(dir, ".personaxis", "interview-draft.json");
}

/** Persist the answers given so far. Best-effort: a failed save must never end the run. */
export function saveDraft(dir: string, draft: Omit<InterviewDraft, "updated">): void {
  try {
    const p = draftPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...draft, updated: new Date().toISOString() }, null, 2), "utf-8");
  } catch {
    /* losing a draft is bad; failing the interview over it is worse */
  }
}

/**
 * A resumable draft, or undefined.
 *
 * A draft written against a DIFFERENT question bank is discarded rather than resumed: the
 * answers are keyed by item id, and replaying them into a changed set would map an answer
 * onto a question that no longer asks what it asked.
 */
export function loadDraft(dir: string, bankVersion: string): InterviewDraft | undefined {
  const p = draftPath(dir);
  if (!existsSync(p)) return undefined;
  try {
    const d = JSON.parse(readFileSync(p, "utf-8")) as InterviewDraft;
    if (!d || typeof d !== "object" || !d.answers) return undefined;
    if (d.bankVersion !== bankVersion) return undefined;
    if (Object.keys(d.answers).length === 0) return undefined;
    return d;
  } catch {
    return undefined; // a torn draft is simply not offered
  }
}

/** Remove the draft. Called once the persona exists, and when the user declines to resume. */
export function clearDraft(dir: string): void {
  try {
    rmSync(draftPath(dir), { force: true });
  } catch {
    /* nothing to do */
  }
}
