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
		tool: /^bash|^shell|^run_command|^execute/i,
		args: /\bgit\s+push\b|\bnpm\s+publish\b|\bdocker\s+push\b|\bterraform\s+apply\b/i,
		classes: ["external_write", "network_egress"],
		because: "a shell command that publishes somewhere outside",
	},
	{
		tool: /^(write|edit|create|delete|remove)[_-]?file$|^str_replace|^apply_patch/i,
		classes: ["external_write"],
		because: "writes to the working tree",
	},
	{
		tool: /^(delete|remove)[_-]?file$/i,
		classes: ["file_delete"],
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
