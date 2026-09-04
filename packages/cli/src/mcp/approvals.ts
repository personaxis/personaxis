/**
 * Which MCP servers an operator approved, kept where a persona cannot reach it.
 *
 * K9. `security/mcp-provenance.ts` has been able to hash a declaration and check one
 * since it was written, and nothing called it. This is the caller, and the interesting
 * decision is not the hashing: it is WHERE the record lives.
 *
 * ## The attack this is actually for
 *
 * A server's tool descriptions are injected into the prompt. So a malicious server needs
 * nothing to execute: being listed is the whole attack, which is why `K4` put what a
 * server advertises through the manifest reader. But that only checks the SHAPE of what
 * arrives. It says nothing about how the server came to be registered.
 *
 * And registration is reachable. `mountRegistered` merges the global config with the
 * PROJECT one, and the project config is `<cwd>/.personaxis/config.json`, inside the
 * workspace a persona writes to. A persona that can write a file can add an MCP server,
 * or replace an approved one, and its descriptions are in the next prompt. That is the
 * agentic supply chain in one paragraph, and nothing checked it.
 *
 * ## So the record lives in the operator's home
 *
 * Beside the global config, in `~/.personaxis`, which is outside every workspace and
 * therefore outside the sandbox a persona runs under. A record kept next to the thing it
 * attests is worth nothing: whatever can edit one can edit the other, and the operator
 * would be reading a signature the attacker wrote.
 *
 * This is an asymmetry the product already has rather than a new mechanism, and using it
 * is most of what makes the control real.
 *
 * ## What is promised, and what is not
 *
 * The declaration. `npx -y @acme/server@1.2.3` with these arguments and these environment
 * variable NAMES is a statement somebody approved, and a change to it is caught. What
 * cannot be promised is what the command does when it runs: `npx` fetches at execution
 * time, a binary on PATH can be replaced, a pinned version can be republished. The
 * provenance module says so at length and every message here follows it, because a
 * control that overclaims teaches people to trust something that was never checked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	hashDeclaration,
	personaxisHome,
	recordMcp,
	verifyMcp,
} from "@personaxis/core";

type Declaration = Parameters<typeof hashDeclaration>[0];
type Provenance = ReturnType<typeof recordMcp>;

/**
 * Where approvals are kept.
 *
 * Its own file rather than a key in the global config, because the two are read by
 * different people for different reasons: a config is edited by hand and often, and an
 * approval is a record of a decision. Mixing them invites an editor to reformat one while
 * meaning to change the other.
 */
export function approvalsPath(): string {
	return join(personaxisHome(), "mcp-approvals.json");
}

interface Stored {
	version: 1;
	servers: Record<string, Provenance>;
}

const EMPTY: Stored = { version: 1, servers: {} };

/**
 * What has been approved, or nothing.
 *
 * Never throws. A file that cannot be read is treated as no approvals, which fails
 * CLOSED: every server is then unapproved and none is mounted. The alternative, treating
 * an unreadable record as permission, is the one reading that cannot be recovered from.
 */
export function readApprovals(): Stored {
	const path = approvalsPath();
	if (!existsSync(path)) return EMPTY;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<Stored>;
		if (parsed.version !== 1 || typeof parsed.servers !== "object" || !parsed.servers) {
			return EMPTY;
		}
		return { version: 1, servers: parsed.servers };
	} catch {
		return EMPTY;
	}
}

/** Records one, replacing whatever was there for that name. */
export function approve(server: Declaration, now: Date = new Date()): Provenance {
	const stored = readApprovals();
	const provenance = recordMcp(server, now);
	const next: Stored = {
		version: 1,
		servers: { ...stored.servers, [server.name]: provenance },
	};

	const path = approvalsPath();
	mkdirSync(dirname(path), { recursive: true });
	// User-only, like the config beside it. An approval is not a secret, and a file
	// somebody else can write is an approval somebody else can grant.
	writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });

	return provenance;
}

/** Why a server may not be mounted, or nothing when it may. */
export type Refusal = { readonly server: string; readonly reason: string };

/**
 * Whether this declaration is the one that was approved.
 *
 * Three answers and they are deliberately different. Never approved is not the same
 * failure as approved-and-changed: the first is an operator who has not decided, and the
 * second is a decision that no longer matches what is on disk, which is the case worth
 * being loud about.
 */
export function checkApproval(server: Declaration): Refusal | null {
	const recorded = readApprovals().servers[server.name];

	if (!recorded) {
		return {
			server: server.name,
			reason:
				`never approved. Run \`personaxis mcp approve ${server.name}\` to record the ` +
				"declaration that is registered now.",
		};
	}

	const verdict = verifyMcp(recorded, server);
	return verdict.ok ? null : { server: server.name, reason: verdict.reason };
}
