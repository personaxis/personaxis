/**
 * The agent never sees a secret.
 *
 * Not "the agent is instructed not to print secrets", which is a request, and not "we
 * redact the transcript afterwards", which is a cleanup. The credential is not in the
 * agent's world at all: it holds a REFERENCE, the reference is exchanged for the real
 * value at the moment a request leaves this process, and what comes back is redacted
 * before anything reads it.
 *
 * Hermes reaches the same place with `iron-proxy`, a separate process holding the
 * keys. The shape is the same and the reasoning is the same: a secret an agent cannot
 * name is a secret no prompt injection can talk it into revealing, because there is
 * nothing in its context to reveal.
 *
 * ## Three rules, and the third is the one people skip
 *
 * **A reference is opaque.** `{{secret:github}}` names a slot, not a value. It can go
 * in a transcript, a record entry, a log, a screenshot.
 *
 * **Substitution happens at the boundary and nowhere earlier.** The moment before the
 * bytes leave. Anything that substitutes sooner has produced a string holding a
 * credential, and that string will be logged by somebody.
 *
 * **What comes back is redacted.** This is the rule that gets skipped, and skipping it
 * undoes the other two: an agent that can run `curl -H "Authorization: {{secret:x}}"`
 * and read the response can also run something that echoes the header back, and the
 * secret arrives in the output it was never supposed to hold. So a result crossing
 * back through the broker is scrubbed of every value the broker holds, by value and
 * not by pattern: the broker knows exactly what its own secrets look like.
 */

import { REDACTED } from "../wire/redact.js";

/** How a reference is written where an agent can see it. */
const REFERENCE = /\{\{secret:([a-zA-Z0-9_.-]+)\}\}/g;

/** Writes the reference for a slot, which is what an agent is given. */
export function secretRef(name: string): string {
	return `{{secret:${name}}}`;
}

/** What a substitution did, so a caller can refuse rather than send a broken request. */
export interface Filled {
	/** The text with every known reference replaced. Never logged, never recorded. */
	readonly text: string;
	/** Slots that were named and are not held. The request should not be sent. */
	readonly missing: readonly string[];
	/** Slots that were filled, by name, which is safe to report. */
	readonly used: readonly string[];
}

/**
 * Holds credentials and exchanges references for them.
 *
 * Values live in a closure rather than on a field, so there is no object to inspect in
 * a debugger, no property to serialise by accident, and nothing for a `JSON.stringify`
 * of some enclosing structure to walk into. It is not a defence against code in this
 * process, which could read anything; it is a defence against the ordinary accident of
 * a secret being carried somewhere by a generic serialiser.
 */
export class CredentialBroker {
	readonly #values: Map<string, string>;

	constructor(secrets: Readonly<Record<string, string>> = {}) {
		this.#values = new Map(Object.entries(secrets).filter(([, value]) => value.length > 0));
	}

	/** The slots that exist, so a caller can offer them without offering values. */
	names(): readonly string[] {
		return [...this.#values.keys()].sort();
	}

	/**
	 * Exchanges references for values, at the boundary.
	 *
	 * A reference naming a slot that does not exist is reported rather than left in
	 * place or replaced with an empty string. Both of those send a request: one with a
	 * literal `{{secret:x}}` where a token belongs, which some servers log verbatim,
	 * and one with an empty credential, which reads as an authentication bug for as
	 * long as it takes somebody to find this function.
	 */
	fill(text: string): Filled {
		const missing: string[] = [];
		const used: string[] = [];

		const filled = text.replace(REFERENCE, (whole, name: string) => {
			const value = this.#values.get(name);
			if (value === undefined) {
				missing.push(name);
				return whole;
			}
			used.push(name);
			return value;
		});

		return { text: filled, missing, used: [...new Set(used)] };
	}

	/**
	 * Removes every held value from text coming back.
	 *
	 * By value, not by pattern. A pattern-based scrubber guesses what a secret looks
	 * like and is wrong in both directions; the broker knows exactly what it holds, so
	 * this is exact. `redactSecrets` still runs over the same text elsewhere for the
	 * credentials the broker does NOT hold, which is the ordinary case of a persona
	 * reading somebody else's `.env`.
	 *
	 * Longest first, so a secret that contains another one does not leave a fragment
	 * behind.
	 */
	scrub(text: string): string {
		let out = text;
		for (const value of [...this.#values.values()].sort((a, b) => b.length - a.length)) {
			out = out.split(value).join(REDACTED);
		}
		return out;
	}

	/** True when the text still holds something this broker knows. For assertions. */
	leaks(text: string): boolean {
		return this.scrub(text) !== text;
	}
}
