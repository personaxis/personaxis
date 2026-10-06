/**
 * Compacting the conversation of a live session, once, for both doors that reach it.
 *
 * ## Why this module exists
 *
 * A person meets compaction two ways: they type `/compact`, or the session crosses its threshold between
 * turns and it happens for them. Both did the same four things afterwards, and both wrote them out
 * separately: shorten the conversation, count it against the session, put it in the record, and persist the
 * checkpoint so `/resume` returns the compacted history rather than the bloat.
 *
 * Two copies of one procedure drift, and these had already drifted where it mattered: the automatic one
 * called `meter.compacted(...)` and the asked-for one never did, so a session where somebody compacted by
 * hand reported ZERO compactions and zero tokens freed under `/context`. The work happened and the session
 * did not know. That is the defect this module removes by having one copy.
 *
 * What stays with each caller is what genuinely differs: the threshold (`/compact` means now, so 0), and
 * what is said afterwards, because the one a person asked for owes them a number and the automatic one is a
 * notice on the activity channel. Failure handling stays outside too: an automatic compaction is
 * best-effort and must never break the turn, while a command may let its error reach the prompt.
 */
import { compactMessages, recordCompaction } from "@personaxis/core";

import { recordReplCompaction } from "./compaction-record.js";
import { ensureCtxSession } from "./session.js";
import type { Ctx } from "./types.js";

/** What a compaction cost and bought, for the caller to report in its own words. */
export interface Compaction {
	/** False when the conversation still fits, which is the normal answer below the threshold. */
	readonly compacted: boolean;
	/** How many messages became the summary. */
	readonly removed: number;
	/** The session's context before and after, and the difference, already floored at zero. */
	readonly before: number;
	readonly after: number;
	readonly freed: number;
}

export interface CompactOpts {
	/** 0 for a compaction somebody asked for: they mean now, not when it gets tight. */
	readonly threshold: number;
	/** Who asked. It reaches the record as the reason, so `/context` and the journal agree on why. */
	readonly kind: "asked" | "auto";
	/**
	 * The model, injected only by a test. `llmConfig` answers from the persona and the project config and
	 * carries no `fetchImpl`, so a caller that wants a scripted endpoint passes one here.
	 */
	readonly llm: { endpoint: string; model: string; apiKey?: string; fetchImpl?: typeof fetch };
	/** Told when the record could not be written. The compaction itself still stands. */
	readonly onProblem: (problem: Error) => void;
}

/**
 * Compact this session's conversation and leave every trace of it that a session owes.
 *
 * Order matters and is the order a reader would want it: shorten, count, record, persist. The count goes in
 * before the record because a record written first would describe a session whose numbers had not moved yet.
 */
export async function compactConversation(ctx: Ctx, opts: CompactOpts): Promise<Compaction> {
	const before = ctx.meter.used;
	const r = await compactMessages([{ role: "system", content: "" }, ...ctx.conversation], ctx.meter, {
		llm: opts.llm,
		threshold: opts.threshold,
	});
	if (!r.compacted) return { compacted: false, removed: 0, before, after: before, freed: 0 };

	// E18: this happens OUTSIDE the agent loop, so the loop's own bookkeeping never sees it. A session that
	// compacted here and reported zero compactions would be reporting on the agent, not on the session.
	ctx.meter.compacted(before, ctx.meter.used);
	ctx.conversation = r.messages.filter((m) => m.role !== "system");

	// E25: and into the RECORD, because this happens between turns and no turn observer is going to see it.
	// Awaited rather than fired off: an entry written after the next turn opened would sit behind facts that
	// happened later.
	if (r.plan) {
		const why = opts.kind === "auto" ? ({ kind: "auto", pct: ctx.meter.pct } as const) : ({ kind: "asked" } as const);
		await recordReplCompaction(ctx.handle.personaPath, ctx.handle.statePath, why, r.plan, opts.onProblem);
	}

	// PERSIST the checkpoint, so leaving and coming back with `/resume` returns the COMPACTED conversation
	// rather than the raw bloat. Nobody should have to compact the same session twice.
	if (r.summary) {
		ensureCtxSession(ctx, ctx.conversation[0]?.content ?? "session");
		recordCompaction(ctx.handle.personaPath, ctx.sessionId, r.summary);
	}

	const after = ctx.meter.used;
	return { compacted: true, removed: r.removed ?? 0, before, after, freed: Math.max(0, before - after) };
}
