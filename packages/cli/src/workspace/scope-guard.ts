/**
 * The last check before content crosses the machine boundary.
 *
 * The operator consented to a set of directories, at their own keyboard. The
 * hook enforces that on the way in: a tool call touching a path outside the
 * scope is refused before it runs. This is the other direction, on the way out,
 * and it exists because those are different failures with different causes.
 *
 * A path can reach an event without any tool call being refused. A model
 * summarising what it read quotes a filename. An error message from a library
 * names the config file it could not open. A stack trace carries the whole
 * source tree. None of those is a policy violation, and all of them put a path
 * from outside the consented scope onto a wire that ends in a record nobody can
 * edit afterwards.
 *
 * So this is defence in depth rather than the primary control, and it behaves
 * accordingly: it redacts the path and lets the event through. Dropping the
 * event would be worse. A run whose events vanish because a message mentioned
 * `/etc/hosts` is a run nobody can audit, and the record's value is that it is
 * complete.
 */

import { isAbsolute, resolve, sep } from "node:path";

export const OUT_OF_SCOPE = "[out-of-scope]";

/**
 * Matches an absolute path in either convention, including a UNC share.
 *
 * The left boundary is the whole difficulty. Without it, the leading slash of a
 * path matches anywhere a slash appears, and the first version of this turned
 * `the ratio is 3/4` into `3[out-of-scope]`, `docs/commands/connect.md` into
 * `docs[out-of-scope]`, and `https://api.example.com` into
 * `http[out-of-scope]`. A guard that mangles every URL in a trace is a guard
 * people learn to ignore, which is worse than not having one.
 *
 * So a root only counts at the start of a token: not after a word character, a
 * colon, a dot or another slash. A Windows drive letter gets the same treatment,
 * or the `s:` of `https:` would read as a drive.
 */
const PATH_PATTERN =
	/(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|(?<![\w:/.])\/)(?:[^\s"'`,;:()[\]{}<>|]+)/g;

/**
 * Replaces every absolute path outside the consented scope.
 *
 * Paths inside it survive: the whole point of naming directories is that the
 * workspace may see what happens in them, and a trace that redacted the file a
 * persona just edited would be unreadable for the person who asked for the
 * edit.
 */
export function guardPaths(text: string, scope: readonly string[]): string {
	if (!text) return text;

	// An empty scope means nothing was consented to. Everything absolute goes.
	// This is the same direction as `connect`: empty means empty rather than
	// defaulting to a home directory.
	return text.replace(PATH_PATTERN, (match) => {
		const cleaned = trimTrailingPunctuation(match);
		if (!isAbsolute(cleaned)) return match;
		return withinScope(cleaned, scope) ? match : match.replace(cleaned, OUT_OF_SCOPE);
	});
}

/** Same walk as `guardPaths`, over a structure, preserving its shape. */
export function guardDeep(value: unknown, scope: readonly string[], depth = 0): unknown {
	// Bounded for the same reason redaction is: tool arguments come from a model
	// and can be cyclic. Past the limit the value is dropped rather than walked.
	if (depth > 12) return OUT_OF_SCOPE;

	if (typeof value === "string") return guardPaths(value, scope);
	if (Array.isArray(value)) return value.map((item) => guardDeep(item, scope, depth + 1));

	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = guardDeep(item, scope, depth + 1);
		}
		return out;
	}

	return value;
}

/**
 * Whether a path is inside one of the consented directories.
 *
 * The boundary is a separator, not a prefix. `/work` must not admit
 * `/workspace-of-someone-else`, and a prefix comparison would, which is the
 * classic way a scope check turns out to have never been one.
 */
export function withinScope(candidate: string, scope: readonly string[]): boolean {
	if (scope.length === 0) return false;

	const full = normalise(resolve(candidate));

	return scope.some((dir) => {
		const root = normalise(resolve(dir));
		if (full === root) return true;
		return full.startsWith(root.endsWith("/") ? root : `${root}/`);
	});
}

/**
 * Case folding matters here.
 *
 * Windows and macOS compare paths case-insensitively, so a scope of `C:\Work`
 * that refused `C:\work` would redact the operator's own directory, and one
 * that accepted `/Etc/passwd` on a case-insensitive volume would admit a path
 * the operator never named. Folding on the platforms that fold is the only
 * answer that is right in both directions.
 */
function normalise(path: string): string {
	const forward = path.replace(/\\/g, "/");
	return sep === "\\" || process.platform === "darwin" ? forward.toLowerCase() : forward;
}

/**
 * Trailing punctuation belongs to the sentence, not to the path.
 *
 * "could not open /etc/hosts." would otherwise be matched with the full stop
 * attached, and the redaction would leave the stop stranded inside the
 * placeholder.
 */
function trimTrailingPunctuation(match: string): string {
	return match.replace(/[.,;:!?)\]}'"`]+$/, "");
}
