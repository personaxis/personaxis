/**
 * E89: closing a session, for any surface rather than for one.
 *
 * ## Why this exists
 *
 * The pieces were already here. `distillSession`, `consolidateSemantic`, `pruneMemory` and the
 * autobiographical milestone all live in `core`, and every one of them is reachable from anywhere. What lived
 * in the TUI, and only there, was the DECISION of when to call them and under which declared policy. So a
 * conversation in the terminal consolidated its memory and the same persona working through a service step or
 * an editor over ACP consolidated nothing, not because anybody decided that, but because the orchestration had
 * one caller and it happened to be the terminal.
 *
 * Measured on 2026-09-16: `distillSession` has exactly one caller, the TUI's close; only the TUI writes
 * session turns at all; and the close itself appears in four places in `src` and in **no test**. Five
 * decisions that nothing ever watched.
 *
 * ## What it decides, and what it refuses to decide
 *
 * Every step reads what the persona declared and does nothing the document did not ask for: episodic
 * distillation only when that kind is on and the write policy is not `ephemeral`; the first-conversation
 * milestone only when the autobiographical kind is on and this is genuinely the first; semantic consolidation
 * only in the mode the persona declared, and `assisted` means proposed rather than done, which is what
 * `loop.ts` already means by it.
 *
 * It does NOT touch the caller's own bookkeeping. The TUI folds per-model usage into its stats cache when a
 * session ends, and that is the terminal's business, not the persona's memory: a shared close that carried it
 * would make every surface keep the terminal's files.
 *
 * ## It says what it did
 *
 * A close that consolidates in silence is the same shape of absence `E85` and `E88` had to correct twice
 * today: a surface that never closed and one that closed and kept nothing read identically. So this returns
 * what happened, and a caller that wants to say so can.
 */

import { readAutobiographical, appendAutobiographical } from "../memory-kinds.js";
import { consolidateSemantic, readMemoryTypes } from "../memory.js";
import { distillSession, pruneMemory } from "./consolidate.js";
import { readConsolidationMode, readMemoryKnobs, readWritePolicy } from "./knobs.js";
import { listSessions } from "../sessions.js";

/** What a close did, so a surface can report it instead of consolidating in silence. */
export interface SessionClose {
	/** Entries written from this session's turns. Zero is a real answer: nothing new was said. */
	readonly distilled: number;
	/** Whether the first-conversation milestone was written in this close. */
	readonly milestone: boolean;
	/**
	 * What happened to semantic memory: folded now, proposed for a person, or left alone.
	 *
	 * `proposed` is not "nothing". It is the persona's declared `assisted` mode, and a surface that shows it
	 * is how a person learns there is something to fold.
	 */
	readonly semantic: "consolidated" | "proposed" | "skipped";
	readonly pruned: number;
	/** Why nothing was distilled, when nothing was: the policy that said so, in a word. */
	readonly why?: string;
}

/**
 * Close a session the way the persona's document says to.
 *
 * Every surface calls this: the terminal at the end of a conversation, a service run when it finishes or
 * fails, and anything else that opens a session. What it never does is decide FOR the persona.
 */
export function closeSessionMemory(
	personaPath: string,
	sessionId: string,
	frontmatter: Record<string, unknown>,
): SessionClose {
	const kinds = readMemoryTypes(frontmatter);
	const write = readWritePolicy(frontmatter);

	let distilled = 0;
	let why: string | undefined;
	if (!kinds.episodic) why = "episodic memory is off";
	else if (write.default === "ephemeral") why = "write policy is ephemeral";
	else distilled = distillSession(personaPath, sessionId).written;

	// The milestone is the engine's own count, not something anybody said, so it is written as an internal
	// observation. Only once: a persona that resumed its first conversation twice has still had one.
	let milestone = false;
	if (kinds.autobiographical && listSessions(personaPath).length === 1) {
		const already = readAutobiographical(personaPath).some((entry) => entry.tags.includes("first-conversation"));
		if (!already) {
			appendAutobiographical(personaPath, {
				event: "first conversation with the user",
				tags: ["milestone", "first-conversation"],
				owner: "internal",
			});
			milestone = true;
		}
	}

	const mode = readConsolidationMode(frontmatter);
	let semantic: SessionClose["semantic"] = "skipped";
	if (kinds.semantic) {
		if (mode === "auto") {
			consolidateSemantic(personaPath);
			semantic = "consolidated";
		} else if (mode === "assisted") {
			// Proposed, not done. `loop.ts` already means exactly this by `assisted`, and a close that folded
			// anyway would be overriding a persona's declared preference from a surface it never named.
			semantic = "proposed";
		}
	}

	const pruned = pruneMemory(personaPath, readMemoryKnobs(frontmatter).retentionDays).pruned;

	return { distilled, milestone, semantic, pruned, ...(why === undefined ? {} : { why }) };
}
