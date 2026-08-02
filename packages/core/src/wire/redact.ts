/**
 * Removing secrets from anything on its way to the wire.
 *
 * The protocol states that free text has already passed redaction at the
 * producer, and that nothing downstream redacts. That is the right shape: one
 * place that can be audited, rather than five that can each forget. This file
 * is that place, and it runs on the daemon, before an event leaves the machine
 * the secret lives on.
 *
 * What it is defending against is ordinary rather than exotic. A persona runs
 * `curl -H "Authorization: Bearer sk-live-..."`, or reads a `.env`, or a tool
 * returns a connection string in an error message. Every one of those becomes a
 * `args_preview` or an `output_preview`, and from there a record entry that is
 * hash chained and cannot be edited afterwards. A secret that reaches the record
 * is a secret that has to be rotated, and the record still holds the old one
 * forever.
 *
 * Deliberately conservative:
 *
 *   It over-redacts rather than under-redacts. A preview with `[redacted]` where
 *   a value used to be is still readable; a leaked key is not recoverable.
 *
 *   It never returns the input unchanged when it matched. There is no "probably
 *   fine" path.
 *
 *   It is pure and total: same input, same output, no IO, and it cannot throw
 *   on any string, because throwing here would drop an event and a tool call
 *   missing from the record is the one thing this pipeline must not do.
 */

export const REDACTED = "[redacted]";

/**
 * Patterns, each with a name so a test failure says which rule matched.
 *
 * Order matters: the more specific patterns run first, so a bearer token is
 * reported as a bearer token rather than as generic high-entropy noise.
 */
interface Rule {
	name: string;
	pattern: RegExp;
	/** Rebuilds the match with the secret part replaced, keeping the context. */
	replace: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
	{
		// Authorization headers, in curl, in fetch, in a log line.
		name: "authorization-header",
		pattern: /\b(authorization\s*[:=]\s*["']?\s*(?:bearer|basic|token)\s+)(\S+)/gi,
		replace: (_m, prefix) => `${prefix}${REDACTED}`,
	},
	{
		// Provider keys with a recognisable prefix. Listed rather than inferred,
		// because these are the ones whose leak is immediately exploitable.
		name: "provider-key",
		pattern:
			/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/g,
		replace: () => REDACTED,
	},
	{
		// A credential inside a URL, which is how a database password reaches a
		// log without anyone typing the word "password".
		name: "url-credentials",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi,
		replace: (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`,
	},
	{
		// An assignment whose name says it is a secret. Catches .env lines,
		// export statements, JSON fields and CLI flags in one rule.
		name: "named-secret",
		pattern:
			/\b([A-Za-z_][A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*["']?)([^\s"',}]+)/gi,
		replace: (_m, name, separator) => `${name}${separator}${REDACTED}`,
	},
	{
		// A PEM block. Replaced whole: the body is the secret and the header is
		// what makes it findable.
		name: "private-key-block",
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replace: () => REDACTED,
	},
	{
		// A JWT. Three base64url segments is specific enough not to catch prose.
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		replace: () => REDACTED,
	},
];

export interface RedactionResult {
	text: string;
	/** Which rules matched, for a caller that wants to say something happened. */
	matched: string[];
}

/**
 * Redacts and reports what it found.
 *
 * The report exists so a surface can say "3 values were redacted" rather than
 * leaving a person to wonder whether the preview was always that short.
 */
export function redactSecretsVerbose(text: string): RedactionResult {
	let output = text;
	const matched: string[] = [];

	for (const rule of RULES) {
		// A fresh regex per call: a shared global regex carries lastIndex between
		// calls and would skip matches on every other invocation.
		const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
		if (!pattern.test(output)) continue;

		matched.push(rule.name);
		output = output.replace(
			new RegExp(rule.pattern.source, rule.pattern.flags),
			rule.replace as (substring: string, ...args: unknown[]) => string,
		);
	}

	return { text: output, matched };
}

/** The common case: give me the text with the secrets gone. */
export function redactSecrets(text: string): string {
	return redactSecretsVerbose(text).text;
}

/**
 * Redacts every string inside a structure, at any depth, preserving its shape.
 *
 * Tool arguments arrive as objects and the secret is usually one leaf of one of
 * them. Serialising first and redacting the JSON would work, but it would also
 * mean the caller could no longer inspect the arguments, and a redactor that
 * forces its caller to give up structure gets bypassed.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
	// Bounded because tool arguments come from a model and can be cyclic or
	// pathological. Past the limit the value is replaced rather than walked,
	// which fails closed.
	if (depth > 12) return REDACTED;

	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));

	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			// A key whose name says secret has its value replaced whatever the
			// value looks like. A password of "hunter2" matches no pattern.
			out[key] = SECRET_KEY.test(key) ? REDACTED : redactDeep(item, depth + 1);
		}
		return out;
	}

	return value;
}

const SECRET_KEY =
	/(secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)/i;
