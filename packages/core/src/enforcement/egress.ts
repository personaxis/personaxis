/**
 * Where a persona may send data.
 *
 * The scope guard decides what may leave about the local filesystem. This
 * decides where anything may go at all, and it is the control that turns a
 * connector grant into a limit rather than a description.
 *
 * The threat is specific. A persona with a Gmail grant is meant to read a
 * support inbox. Nothing in that grant stops it from also POSTing what it read
 * to an address a prompt injection put in its context, and "it only has read
 * scope" does not help: reading is how it got the data, and sending is a
 * different call entirely.
 *
 * So: an allowlist of hosts, per persona and per connector, denying by default.
 * Absence is denial. A persona with no egress list reaches nothing, which is the
 * only default that makes a new connector safe before anyone has thought about
 * it.
 */

export type EgressVerdict =
	| { allowed: true; matched: string }
	| { allowed: false; reason: string };

/**
 * Whether a URL may be reached.
 *
 * @param url what the tool call is about to contact
 * @param allowlist hosts from `persona_connector.egressDomains`
 */
export function checkEgress(url: string, allowlist: readonly string[]): EgressVerdict {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// Refused rather than passed through. A string that is not a URL reaching
		// a network call means something upstream is wrong, and guessing what it
		// meant is how a check becomes decorative.
		return { allowed: false, reason: `not a URL: ${truncate(url)}` };
	}

	// http and https only. A `file:` URL is a filesystem read wearing a network
	// call's clothes, and the scope guard never sees it.
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { allowed: false, reason: `${parsed.protocol} is not a network scheme` };
	}

	if (allowlist.length === 0) {
		return {
			allowed: false,
			reason: "this persona has no egress allowlist, so it may not reach anything",
		};
	}

	const host = parsed.hostname.toLowerCase();

	for (const entry of allowlist) {
		const pattern = entry.trim().toLowerCase().replace(/^\./, "");
		if (!pattern) continue;

		// An entry matches the host itself and its subdomains. `example.com`
		// covers `api.example.com`, because a workspace naming a vendor means the
		// vendor, and making them enumerate every subdomain would produce a list
		// nobody keeps current.
		if (host === pattern || host.endsWith(`.${pattern}`)) {
			return { allowed: true, matched: entry };
		}
	}

	return {
		allowed: false,
		// Names what would have to change. "Blocked" alone sends somebody to
		// guess, and guessing about egress produces a wildcard.
		reason: `${host} is not in this persona's egress allowlist (${allowlist.join(", ")})`,
	};
}

/**
 * Every URL in a piece of text, for checking a tool call's arguments.
 *
 * The command a model writes is a string, and the host it contacts is inside
 * it. Extracting rather than requiring the caller to parse means a shell
 * command and a fetch are checked the same way.
 */
export function urlsIn(text: string): string[] {
	return [...text.matchAll(/https?:\/\/[^\s"'`<>\\]+/gi)].map((match) =>
		// Trailing punctuation belongs to the sentence.
		match[0].replace(/[.,;:!?)\]}'"`]+$/, ""),
	);
}

/**
 * Checks every URL a call would contact.
 *
 * Denies on the first one that fails. A call reaching two hosts where one is
 * allowed is not a call that is half fine: it is a call that would have sent
 * data somewhere it may not.
 */
export function checkEgressIn(text: string, allowlist: readonly string[]): EgressVerdict {
	const urls = urlsIn(text);

	// No URL is not an allowed URL. A call with no network in it is not this
	// check's business, and saying so keeps the verdict honest.
	if (urls.length === 0) return { allowed: true, matched: "no network address in this call" };

	for (const url of urls) {
		const verdict = checkEgress(url, allowlist);
		if (!verdict.allowed) return verdict;
	}

	return { allowed: true, matched: `${urls.length} address${urls.length === 1 ? "" : "es"} allowed` };
}

function truncate(value: string): string {
	return value.length > 80 ? `${value.slice(0, 79)}…` : value;
}
