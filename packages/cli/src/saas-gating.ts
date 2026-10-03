/**
 * What this CLI does not offer while the Personaxis service is not live, and what brings each piece back.
 *
 * L14 (2026-10-03): the first published version works whole on the machine that installs it, and offers nothing that
 * needs the service. A command that needs it is not registered, so it cannot be run, listed in `--help`, or fail half
 * way for a missing account; the code stays, and coming back is removing its entry here. The same idea as the web app's
 * route gating: one table, each entry with its reason, and a test that nothing user-facing still announces an entry.
 */

/** A command this version does not register. */
interface GatedCommand {
	readonly name: string;
	readonly aliases: readonly string[];
	/** Why it is off, in the words a reader of this file needs. */
	readonly reason: string;
	/** What brings it back. */
	readonly returnsWith: string;
}

export const GATED_COMMANDS: readonly GatedCommand[] = [
	{
		name: "connect",
		aliases: ["login"],
		reason: "links the machine to a workspace and streams its work there; the local enforcement it used to start is `guard`",
		returnsWith: "sign-in and the workspace (R13)",
	},
	{ name: "pull", aliases: [], reason: "fetches a persona from the online Registry", returnsWith: "the Registry (R14)" },
	{ name: "push", aliases: [], reason: "publishes a persona to the online Registry", returnsWith: "the Registry (R15)" },
	{
		name: "runtime",
		aliases: [],
		reason: "opens hosted runtime sessions, which need a Personaxis account",
		returnsWith: "the hosted service",
	},
];

/** A model provider this version does not offer: the hosted inference, paid, behind an account. */
export const GATED_PROVIDERS: readonly string[] = ["remote"];

/** The entry that keeps this command (or alias) out of this version, if one does. */
export function notOffered(name: string): GatedCommand | undefined {
	return GATED_COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
}

/** True when this version registers the command (or alias). */
export function offered(name: string): boolean {
	return notOffered(name) === undefined;
}
