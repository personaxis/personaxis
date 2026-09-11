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

import { commandPathTokens, isDestructiveCommand, isProtectedUnder, pathEscapesWorkspace } from "../sandbox.js";

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
/**
 * The shells. E62, 2026-09-11: `PowerShell` and `pwsh` were not here, so on Windows every command
 * Claude Code ran through its `PowerShell` tool classified as nothing, `Remove-Item -Recurse -Force`
 * included. The verbs below learned the PowerShell spellings at the same time.
 */
const SHELL_TOOL = /^bash|^shell|^run_command|^execute|^powershell|^pwsh/i;

const RULES: readonly Rule[] = [
	{
		tool: SHELL_TOOL,
		args: /\brm\b|\brmdir\b|\bdel\b|\berase\b|\bunlink\b|\btruncate\b|\bshred\b|\bmkfs\b|\bRemove-Item\b|\bClear-Content\b|\bFormat-Volume\b|\bClear-Disk\b/i,
		classes: ["file_delete"],
		because: "a shell command that removes files",
	},
	{
		tool: SHELL_TOOL,
		args: /\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\bscp\b|\brsync\b|https?:\/\/|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\biwr\b|\birm\b|\bStart-BitsTransfer\b|Net\.WebClient/i,
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
		tool: SHELL_TOOL,
		args: /(?:[^-=<>&]|^)>>?\s*(?![&=])[A-Za-z0-9._~/\\$"'(]|\btee\b|\bdd\b[^|]*\bof=|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b/i,
		classes: ["external_write"],
		because: "a shell command that writes through redirection",
	},
	{
		tool: SHELL_TOOL,
		args: /\bgit\s+push\b|\bnpm\s+publish\b|\bdocker\s+push\b|\bterraform\s+apply\b/i,
		classes: ["external_write", "network_egress"],
		because: "a shell command that publishes somewhere outside",
	},
	{
		tool: SHELL_TOOL,
		args: /\bSend-MailMessage\b|\bsendmail\b/i,
		classes: ["email_send", "external_write", "network_egress"],
		because: "a shell command that sends mail",
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
 * documented to mean. The first two facts are what it was missing. The last two (E62)
 * are what a shell command says about where it acts and how hard.
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
	/**
	 * E62: the call names a place outside the workspace, or a path that climbs with `..`: a named
	 * argument, or a path token in a shell command. When a root was given and the call cannot be
	 * read, this is TRUE, the strict answer for the question it answers. False without a root,
	 * which is the answer before it existed.
	 */
	readonly namesOutside: boolean;
	/**
	 * E62: a shell command the documented classifier calls destructive: a tree or forced delete
	 * (`rm -r`, `rm -f`, `Remove-Item -Recurse`, `rd /s`), a disk format, `shred`. Needs no root.
	 */
	readonly destructive: boolean;
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
 * that is not listed, a limit written down in `E59` and in `docs/architecture/sandbox.md`.
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
	const record = objectArgs(argsText);

	if (SHELL_TOOL.test(tool)) {
		// A command's places are in its text. Where the shell will actually be standing is only
		// as good as the cwd the host reports: a host whose shell keeps its directory between
		// calls can `cd ..` in one call and delete in the next, and this sees the second alone.
		const command = commandOf(record, argsText);
		const destructive = isDestructiveCommand(command);
		if (!workspaceRoot) return { knownRead, withinWorkspace: false, namesOutside: false, destructive };
		const namesOutside = commandPathTokens(command).some((tok) => climbs(tok) || pathEscapesWorkspace(tok, workspaceRoot));
		// Never inside: what a command touches is not in its arguments.
		return { knownRead, withinWorkspace: false, namesOutside, destructive };
	}

	if (!workspaceRoot) return { knownRead, withinWorkspace: false, namesOutside: false, destructive: false };
	if (!record) return { knownRead, withinWorkspace: false, namesOutside: true, destructive: false };

	const named = [...PATH_KEYS, ...(extraKeys ?? [])].filter((key) => Object.hasOwn(record, key));
	const from = cwd ?? workspaceRoot;
	const outside = (key: string): boolean => {
		const value = record[key];
		if (typeof value !== "string") return true;
		// A path that climbs is never inside, even when it comes back. Resolved from a
		// directory below the root, `../../a/b/y` can name the root's own parents on the
		// way down and land somewhere the resolution against the root calls inside.
		// Braces name several places at once, and only one of them has to be outside.
		if (climbs(value) || value.includes("{")) return true;
		const target = value.startsWith("~") ? value : resolve(from, value);
		return pathEscapesWorkspace(target, workspaceRoot);
	};
	const namesOutside = named.some(outside);

	// A read with no path reads where it stands, which is inside. A write with no path
	// could be going anywhere, and "we could not see where" is not "inside".
	if (!knownRead && named.length === 0) return { knownRead, withinWorkspace: false, namesOutside, destructive: false };

	const withinWorkspace =
		!namesOutside &&
		named.every((key) => {
			// Reading its own files is ordinary, the persona reads its document every turn.
			// Writing them is governed elsewhere, so for a write they are never "inside".
			const target = resolve(from, record[key] as string);
			return knownRead || !isProtectedUnder(target, workspaceRoot);
		});
	return { knownRead, withinWorkspace, namesOutside, destructive: false };
}

/** A path with a `..` segment, anywhere in it. */
function climbs(path: string): boolean {
	return path.split(/[\\/]+/).includes("..");
}

/** The arguments as an object, or null when they are not one. */
function objectArgs(argsText: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(argsText);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * The command a shell call runs. Under `command` for Claude Code and our own loop, as an array
 * for Codex's shell, which takes `["bash", "-lc", "..."]`. Arguments that name no command are
 * scanned whole, which can only find more than there is.
 */
function commandOf(record: Record<string, unknown> | null, argsText: string): string {
	for (const key of ["command", "cmd", "script"]) {
		const value = record?.[key];
		if (typeof value === "string") return value;
		if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
	}
	return argsText;
}
