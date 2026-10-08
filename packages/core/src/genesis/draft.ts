/**
 * INTERVIEW DRAFTS: leaving the interview must not throw the answers away.
 *
 * Answers are written as they are given and offered back on the next run. Since 2026-10-07 the questions are
 * written by a model for the sources at hand, so a draft is kept with a fingerprint of those sources and is
 * resumed only over the same ones: answers to questions about another brief would be answers to nothing.
 *
 * Deliberately NOT a permanent artifact: the draft lives in the project's `.personaxis` directory, is
 * deleted the moment the persona is created, and holds nothing but the questions asked and the answers
 * given. It is a crash-safety file, not a new part of the model.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InterviewTurn } from "./interview.js";

/** Bumped when the draft's shape changes, so an older draft is never misread. */
const DRAFT_VERSION = 2;

export interface InterviewDraft {
	version: number;
	/** `sourcesFingerprint` of the sources the questions were written for. */
	sources: string;
	turns: InterviewTurn[];
	/** ISO timestamp of the last write. */
	updated: string;
}

function draftPath(dir: string): string {
	return join(dir, ".personaxis", "interview-draft.json");
}

/** Persist the turns so far. Best-effort: a failed save must never end the run. */
export function saveDraft(dir: string, sources: string, turns: readonly InterviewTurn[]): void {
	try {
		const p = draftPath(dir);
		mkdirSync(dirname(p), { recursive: true });
		const draft: InterviewDraft = { version: DRAFT_VERSION, sources, turns: [...turns], updated: new Date().toISOString() };
		writeFileSync(p, JSON.stringify(draft, null, 2), "utf-8");
	} catch {
		/* losing a draft is bad; failing the interview over it is worse */
	}
}

/** A resumable draft over the same sources, or undefined. A torn or foreign draft is simply not offered. */
export function loadDraft(dir: string, sources: string): InterviewDraft | undefined {
	const p = draftPath(dir);
	if (!existsSync(p)) return undefined;
	try {
		const d = JSON.parse(readFileSync(p, "utf-8")) as InterviewDraft;
		if (!d || d.version !== DRAFT_VERSION || d.sources !== sources || !Array.isArray(d.turns) || d.turns.length === 0) return undefined;
		return d;
	} catch {
		return undefined;
	}
}

/** Remove the draft. Called once the persona exists, and when the person declines to resume. */
export function clearDraft(dir: string): void {
	try {
		rmSync(draftPath(dir), { force: true });
	} catch {
		/* nothing to do */
	}
}
