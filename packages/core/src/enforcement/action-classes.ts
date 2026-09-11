/**
 * What a tool call is about to do, in the six terms a policy reasons about.
 *
 * A persona's limits are written against consequences ("never email a customer
 * without approval"), not against tool names, because tool names change with
 * every host agent and a limit that named them would stop holding the day one
 * was renamed. This is the one place that translates.
 *
 * The table is deliberately conservative. When a call could be in a class, it
 * is: a missed class means a gate that never opened, and the cost of a gate
 * that opens once too often is a person clicking approve.
 */

import { resolve } from "node:path";

import { isProtectedUnder, pathEscapesWorkspace } from "../sandbox.js";

export type ActionClass =
	/** Reaches something outside the workspace: an API, a repository, a doc. */
	| "external_write"
	/** Sends a message to a person. Separated from external_write because it is
	 *  the one people most often want gated on its own. */
	| "email_send"
	/** Destroys something. */
	| "file_delete"
	/** Opens a connection out. */
	| "network_egress"
	/** Reads a secret, a token or a key. */
	| "credential_access"
	/** Moves money. */
	| "spend";

export const ACTION_CLASSES: readonly ActionClass[] = [
	"external_write",
	"email_send",
	"file_delete",
	"network_egress",
	"credential_access",
	"spend",
];

interface Rule {
	/** Matched against the tool name, case insensitively. */
	tool?: RegExp;
	/** Matched against the arguments as text. */
	args?: RegExp;
	classes: ActionClass[];
	/** Why this rule exists, for whoever reads a verdict later. */
	because: string;
}

/**
 * The table. One row per way a call earns a class.
 *
 * Rules are additive: a call collects every class whose rule matches, because a
 * shell command can delete a file and reach the network in the same line.
 */
const RULES: readonly Rule[] = [
	{
		tool: /^bash|^shell|^run_command|^execute/i,
		args: /\brm\b|\brmdir\b|\bdel\b|\bunlink\b|\btruncate\b|\bshred\b|\bmkfs\b/i,
		classes: ["file_delete"],
		because: "a shell command that removes files",
	},
	{
		tool: /^bash|^shell|^run_command|^execute/i,
		args: /\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\bscp\b|\brsync\b|https?:\/\//i,
		classes: ["network_egress", "external_write"],
		because: "a shell command that reaches the network",
	},
	{
		// E26: a write done with `>` is still a write.
		//
		// The rows above earn a write class for reaching the network, publishing, or
		// deleting. None of them looked at redirection, so `echo x > secrets.env`
		// classified as NOTHING, and everything hanging off `external_write` stopped
		// looking: the gate, the identity axis, and the rule deciding whether a call
		// touches the persona's own state. The shell's oldest way to write a file was
		// the one way the table could not see.
		//
		// What the pattern deliberately does NOT match: `2>&1` and `>&2`, which
		// redirect a stream onto another stream and create no file. The `&` after the
		// arrow is the whole discriminator, and `2> log.txt` DOES match, because that
		// one writes. `>=` and `->` are excluded for the same reason: they are
		// comparison and arrow syntax, not redirection.
		tool: /^bash|^shell|^run_command|^execute/i,
		args: /(?:[^-=<>&]|^)>>?\s*(?![&=])[A-Za-z0-9._~/\\$"'(]|\btee\b|\bdd\b[^|]*\bof=|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b/i,
		classes: ["external_write"],
		because: "a shell command that writes through redirection",
	},
	{
		tool: /^bash|^shell|^run_command|^execute/i,
		args: /\bgit\s+push\b|\bnpm\s+publish\b|\bdocker\s+push\b|\bterraform\s+apply\b/i,
		classes: ["external_write", "network_egress"],
		because: "a shell command that publishes somewhere outside",
	},
	{
		// The `_file` suffix is OPTIONAL, and that is the whole of this edit.
		//
		// The hosts this ships with name their file tools `Write`, `Edit` and
		// `NotebookEdit`, with no suffix, so a pattern anchored on `file$` matched
		// none of them. Every write by the agents we actually run classified as
		// nothing, which meant no gate rule could fire on one: a policy saying "ask
		// before writing" was silent for the only tools doing the writing.
		//
		// Found by opening a gate for real and noticing it could only ever be
		// reached through a shell command.
		tool: /^(write|edit|create|update|patch)([_-]?file)?$|^notebook[_-]?edit$|^str_replace|^apply_patch/i,
		classes: ["external_write"],
		because: "writes to the working tree",
	},
	{
		tool: /^(delete|remove)([_-]?file)?$/i,
		classes: ["file_delete", "external_write"],
		because: "removes from the working tree",
	},
	{
		tool: /gmail|email|sendmail|smtp|resend|postmark|mailgun/i,
		classes: ["email_send", "external_write", "network_egress"],
		because: "sends mail to a person",
	},
	{
		tool: /slack|discord|teams|twilio|sms/i,
		classes: ["email_send", "external_write", "network_egress"],
		because: "sends a message to a person",
	},
	{
		tool: /^web[_-]?fetch|^http|^fetch$|^request$|^browser/i,
		classes: ["network_egress"],
		because: "makes a request out",
	},
	{
		tool: /^connector\./i,
		classes: ["external_write", "network_egress"],
		because: "reaches a customer system",
	},
	{
		tool: /stripe|polar|checkout|payment|invoice|charge|refund|transfer/i,
		classes: ["spend", "external_write", "network_egress"],
		because: "moves money",
	},
	{
		args: /\bAPI[_-]?KEY\b|\bSECRET\b|\bTOKEN\b|\bPASSWORD\b|\bCREDENTIAL\b|\.env\b|id_rsa|\bPRIVATE[_-]?KEY\b/i,
		classes: ["credential_access"],
		because: "names a credential",
	},
	{
		tool: /vault|secret|credential|keychain/i,
		classes: ["credential_access"],
		because: "reads from a secret store",
	},
];

/**
 * Derives the classes for one call. Pure, and the only input is what the call
 * says about itself.
 *
 * Returned sorted and deduplicated so two identical calls always produce the
 * same list, which matters because the list feeds a hash and a decision.
 */
export function actionClassesFor(tool: string, argsText: string): ActionClass[] {
	const found = new Set<ActionClass>();

	for (const rule of RULES) {
		if (rule.tool && !rule.tool.test(tool)) continue;
		if (rule.args && !rule.args.test(argsText)) continue;
		// A rule with neither pattern would match everything; the table has none,
		// and this guard keeps it that way if someone adds one.
		if (!rule.tool && !rule.args) continue;
		for (const cls of rule.classes) found.add(cls);
	}

	return [...found].sort();
}

/** The rules that fired, for explaining a verdict to a person. */
export function explainActionClasses(tool: string, argsText: string): string[] {
	return RULES.filter((rule) => {
		if (rule.tool && !rule.tool.test(tool)) return false;
		if (rule.args && !rule.args.test(argsText)) return false;
		return Boolean(rule.tool || rule.args);
	}).map((rule) => rule.because);
}

/**
 * What the gate knows about a call besides its classes: whether it only reads, and
 * whether it stays inside the workspace.
 *
 * E59, 2026-09-11. The classes say what a call does, not where. `write_file` is
 * `external_write` whether it writes `docs/refunds.md` or `../other-client/x`, and it
 * has to stay that way: the identity axis reads `external_write` to find a write to
 * the persona's own state, which is inside the project. So the compiled policy could
 * not tell a write inside from one outside, refused both under `workspace-write`, and
 * sent every read to a person under `on-request`, against what the postures are
 * documented to mean. These two facts are what it was missing.
 */
export interface CallFacts {
	/** The tool is on the list of tools that only read. A name nobody listed is not a read. */
	readonly knownRead: boolean;
	/**
	 * Every path the call names lands inside the workspace. For a call that is not a
	 * known read it also names at least one, and none under a protected folder. False
	 * whenever that cannot be established: no root, arguments that are not a JSON
	 * object, a path that is not a string, a shell command.
	 */
	readonly withinWorkspace: boolean;
}

/**
 * The tools that only read, by exact name, folded to lower case, with any argument
 * that names where they read besides the common ones below.
 *
 * A list and not a pattern, because a pattern is a guess about names and this is the
 * one place where a wrong guess loosens the gate. Our own loop's reads first, then the
 * ones Claude Code sends through its hooks. A tool somebody adds is not a read until
 * somebody adds it here.
 */
const KNOWN_READS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
	["read_file", []],
	["list_dir", []],
	["find_in_files", []],
	["memory_search", []],
	["memory_get", []],
	["read_output", []],
	["grep_output", []],
	["read", []],
	// A Glob pattern IS a path, and `../**` lists outside.
	["glob", ["pattern"]],
	["grep", []],
	["ls", []],
	["notebookread", []],
]);

/**
 * The arguments that name a place, in the spellings the hosts use.
 *
 * `cwd` is here because it moves where every other path lands: a write to `x` from a
 * `cwd` of `/etc` is a write to `/etc/x`. What this cannot see is a path under a key
 * that is not listed, which is written down in `E59` for review.
 */
const PATH_KEYS = [
	"path",
	"file_path",
	"filePath",
	"notebook_path",
	"target_file",
	"targetPath",
	"dir",
	"directory",
	"cwd",
];

/** The shells, which are never "inside": what a command touches is not in its arguments. */
const SHELL = /^bash|^shell|^run_command|^execute|^powershell|^pwsh/i;

/**
 * Derives the facts for one call. Pure, like the classes.
 *
 * @param workspaceRoot where "inside" is measured from. Without it nothing is inside,
 *   which is the answer the gate gave before these facts existed.
 * @param cwd where a relative path in the arguments starts, when that is not the root:
 *   a hook's call is made from the host's working directory, which can be below it.
 */
export function callFacts(tool: string, argsText: string, workspaceRoot?: string, cwd?: string): CallFacts {
	const extraKeys = KNOWN_READS.get(tool.toLowerCase());
	const knownRead = extraKeys !== undefined;
	if (!workspaceRoot || SHELL.test(tool)) return { knownRead, withinWorkspace: false };

	let args: unknown;
	try {
		args = JSON.parse(argsText);
	} catch {
		return { knownRead, withinWorkspace: false };
	}
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return { knownRead, withinWorkspace: false };
	}

	const record = args as Record<string, unknown>;
	const named = [...PATH_KEYS, ...(extraKeys ?? [])].filter((key) => Object.hasOwn(record, key));
	// A read with no path reads where it stands, which is inside. A write with no path
	// could be going anywhere, and "we could not see where" is not "inside".
	if (!knownRead && named.length === 0) return { knownRead, withinWorkspace: false };

	const from = cwd ?? workspaceRoot;
	const withinWorkspace = named.every((key) => {
		const value = record[key];
		if (typeof value !== "string") return false;
		// A path that climbs is never inside, even when it comes back. Resolved from a
		// directory below the root, `../../a/b/y` can name the root's own parents on the
		// way down and land somewhere the resolution against the root calls inside.
		// Braces name several places at once, and only one of them has to be outside.
		if (value.split(/[\\/]+/).includes("..") || value.includes("{")) return false;
		const target = value.startsWith("~") ? value : resolve(from, value);
		if (pathEscapesWorkspace(target, workspaceRoot)) return false;
		// Reading its own files is ordinary, the persona reads its document every turn.
		// Writing them is governed elsewhere, so for a write they are never "inside".
		return knownRead || !isProtectedUnder(target, workspaceRoot);
	});
	return { knownRead, withinWorkspace };
}
