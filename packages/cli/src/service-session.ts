/**
 * E89: the sessions a service run keeps, opened as the work happens and closed when the run is over.
 *
 * Out of `commands/service.ts` for two reasons. The first is that this is the only part of a step that can be
 * checked without a model: driving `localPorts` in a test would mean faking the provider, and a test that
 * fakes what it measures proves nothing. The second is the export sweep, which reads a thing consumed only by
 * its own module as unreachable, so a seam that stayed inside the command would have to be tested through the
 * command or not at all.
 *
 * One session per PERSONA per run, not one per run. A service whose steps belong to two personas is two
 * working conversations, and keeping a single session would have written the second persona's turns into the
 * first one's file, or, as the first version of this did, dropped them: a persona that did the work and
 * remembers none of it.
 */
import { appendTurn, closeSessionMemory, ensureSession, fallbackName, newSessionId, type SessionClose } from "@personaxis/core";

/**
 * What one persona's session left behind.
 *
 * `closeSessionMemory` returns this for a reason its own header gives: a close that consolidates in silence
 * reads exactly like a close that never ran, and that absence had to be corrected twice today (`E85`, `E88`).
 * Throwing the report away here would have rebuilt it a third time.
 */
interface ClosedSession {
	personaRef: string;
	result: SessionClose;
}

/**
 * One step, as the two turns it leaves behind.
 *
 * Neither this nor `ServiceSessions` is exported: the command calls `note` and `close` and needs no name for
 * either, and a name exported here would be reached only from this module and its own test, which is what the
 * export sweep counts as designed and not connected.
 */
interface StepNote {
	personaPath: string;
	personaRef: string;
	prompt: string;
	answer: string;
	frontmatter: Record<string, unknown>;
}

interface ServiceSessions {
	/** The step, as two turns of that persona's session for this run. Opens the session on its first step. */
	note(step: StepNote): void;
	/**
	 * The run is over for good: every session it opened closes the way each persona's document says, and what
	 * each close did comes back so the run can say it.
	 */
	close(): ClosedSession[];
}

export function serviceSessions(): ServiceSessions {
	const open = new Map<string, { id: string; personaRef: string; frontmatter: Record<string, unknown> }>();

	return {
		note({ personaPath, personaRef, prompt, answer, frontmatter }) {
			try {
				let at = open.get(personaPath);
				if (at === undefined) {
					const id = newSessionId();
					ensureSession(personaPath, {
						id,
						kind: "background",
						participants: [personaRef],
						name: fallbackName(prompt),
						created: new Date().toISOString(),
						persona: personaRef,
					});
					at = { id, personaRef, frontmatter };
					open.set(personaPath, at);
				}
				// `note` and not `user`/`assistant`: the role exists for provenance that is not dialogue, and
				// writing a step's brief as something a person said would put words in a mouth that never opened.
				appendTurn(personaPath, at.id, { role: "note", content: prompt, from: personaRef });
				appendTurn(personaPath, at.id, { role: "note", content: answer, from: personaRef });
			} catch {
				/* a session that cannot be written never fails the step that did the work */
			}
		},

		close() {
			const closed: ClosedSession[] = [];
			for (const [personaPath, at] of open) {
				try {
					closed.push({ personaRef: at.personaRef, result: closeSessionMemory(personaPath, at.id, at.frontmatter) });
				} catch {
					/* closing memory must never fail a run that already did its work */
				}
			}
			open.clear();
			return closed;
		},
	};
}
