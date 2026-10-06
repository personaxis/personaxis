/**
 * Provenance for MCP servers.
 *
 * A skill is a directory, so its integrity is the hash of its files. An MCP
 * server is a **command**, and that difference changes what can honestly be
 * promised.
 *
 * What can be pinned: the declaration. `npx -y @acme/mcp-server@1.2.3` with a
 * given set of arguments and a given set of environment variable names is a
 * statement somebody approved, and it is checkable. If tomorrow it reads
 * `npx -y @acme/mcp-server@latest --allow-write`, that is a different command
 * and this catches it.
 *
 * What cannot: what the command does when it runs. `npx` fetches at execution
 * time; a binary on PATH can be replaced; a pinned version can be republished
 * on a registry that permits it. This file does not pretend otherwise, and the
 * surfaces that use it say "the declaration is unchanged" rather than "this
 * server is safe".
 *
 * That distinction is the entire value. A control that overclaims teaches people
 * to trust something that was never checked, which is worse than an absent
 * control they know is absent.
 */

import { createHash } from "node:crypto";

export interface McpServerDeclaration {
	name: string;
	command: string;
	args?: readonly string[];
	/**
	 * Environment variable NAMES only.
	 *
	 * Never values. An MCP server's environment is where its credentials live,
	 * and hashing them would put a credential's digest into a file we write to
	 * disk and show in a manifest. The names are what somebody approved; the
	 * values are what the operator holds.
	 */
	envKeys?: readonly string[];
}

export interface McpProvenance {
	name: string;
	/** sha256 over the canonical declaration. */
	declarationHash: string;
	/** True when the command commits to a specific version. */
	pinned: boolean;
	recordedAt: string;
}

/**
 * Hashes what was approved.
 *
 * Arguments keep their order, because order is meaning in a command line:
 * `--allow write` and `write --allow` are not the same invocation. Environment
 * names are sorted, because a set has no order and sorting keeps the hash
 * stable across the map iteration that produced it.
 */
export function hashDeclaration(server: McpServerDeclaration): string {
	const canonical = JSON.stringify({
		command: server.command,
		args: [...(server.args ?? [])],
		envKeys: [...(server.envKeys ?? [])].sort(),
	});

	return createHash("sha256").update(canonical).digest("hex");
}

export function recordMcp(server: McpServerDeclaration, now: Date = new Date()): McpProvenance {
	return {
		name: server.name,
		declarationHash: hashDeclaration(server),
		pinned: isCommandPinned(server),
		recordedAt: now.toISOString(),
	};
}

export type McpVerdict =
	| { ok: true }
	| { ok: false; reason: string; expected: string; actual: string };

/** Whether the declaration on disk is still the one somebody approved. */
export function verifyMcp(recorded: McpProvenance, server: McpServerDeclaration): McpVerdict {
	const actual = hashDeclaration(server);
	if (actual === recorded.declarationHash) return { ok: true };

	return {
		ok: false,
		// Says what changed rather than that something did, because the reader
		// has to decide whether they made this change.
		reason: `the declaration for ${recorded.name} has changed since it was approved: now \`${describe(server)}\``,
		expected: recorded.declarationHash,
		actual,
	};
}

/**
 * Whether the command commits to a version.
 *
 * `npx -y pkg@1.2.3` does. `npx -y pkg` and `npx -y pkg@latest` do not: both
 * resolve at execution time to whatever the registry serves then.
 */
export function isCommandPinned(server: McpServerDeclaration): boolean {
	const args = server.args ?? [];

	// A path to a local file or a binary is as pinned as the filesystem, which
	// is the same trust level as anything else on that machine.
	if (server.command.includes("/") || server.command.includes("\\")) return true;

	if (server.command === "npx" || server.command === "pnpm" || server.command === "bunx") {
		const pkg = args.find((arg) => !arg.startsWith("-"));
		if (!pkg) return false;

		// Scoped packages carry a leading @, so the version separator is the one
		// after the first character.
		const at = pkg.indexOf("@", 1);
		if (at === -1) return false;

		const version = pkg.slice(at + 1);
		return Boolean(version) && version !== "latest" && !/^[\^~]/.test(version);
	}

	if (server.command === "uvx" || server.command === "pipx") {
		return args.some((arg) => arg.includes("=="));
	}

	// An unrecognised launcher is reported as not pinned. Claiming otherwise
	// about a command nobody here understands is the overclaim this file exists
	// to avoid.
	return false;
}

/** A one-line rendering of the invocation, for a message a person reads. */
export function describe(server: McpServerDeclaration): string {
	return [server.command, ...(server.args ?? [])].join(" ");
}

/**
 * What a surface should say about this server, in full.
 *
 * Deliberately two sentences: what is checked, and what is not. A single
 * reassuring word here is how a control starts being trusted for something it
 * never did.
 */
export function describeAssurance(provenance: McpProvenance): string {
	const pinning = provenance.pinned
		? "The command pins a version."
		: "The command does not pin a version, so it resolves to whatever is published when it runs.";

	return `${pinning} What is verified is the declaration, not what the server does when it executes.`;
}
