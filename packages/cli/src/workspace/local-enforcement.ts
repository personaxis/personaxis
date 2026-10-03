/**
 * The machine's own enforcement: the policy socket a host's hook asks before every tool call, and the hooks that ask it.
 *
 * Lifted out of `connect` on 2026-10-03 (L14). The policy it enforces was always local, read from the persona's own
 * file, and it was written to start before the workspace is dialled and to hold whether or not the workspace answers;
 * but the only way to start it was `connect`, which links the machine first. The first published version of the CLI
 * works without the workspace, so `guard` starts the same enforcement with no link, and `connect` keeps using it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";
import chalk from "chalk";
import matter from "gray-matter";
import { policyFromPersona } from "@personaxis/core";

import { enforcementSocketPath, serveEnforcement } from "./enforcement-endpoint.js";
import { permissionFrom } from "./acp-gate.js";
import type { PermissionAnswer, PermissionAsk } from "./acp-session.js";
import { enforcementHandler, type GateOutcome, type GateRequest } from "./enforcement-service.js";
import { identityOver } from "./identity-axis.js";
import { HOST_ADAPTERS } from "./host-adapter.js";
import { PolicyCache } from "./policy-cache.js";
import { GateRelay } from "./gate-relay.js";

/** What a caller of `startEnforcement` may bring. */
interface StartOptions {
	/**
	 * Who answers a gate, instead of the workspace relay. Without it a gate goes to the relay, which answers
	 * `unreachable` when no workspace run is in flight here; the call is then refused with that reason.
	 */
	openGate?: (gate: GateRequest) => Promise<GateOutcome>;
}

export interface EnforcementRuntime {
	cache: PolicyCache;
	servers: Server[];
	/**
	 * Where a gated call goes to find a person.
	 *
	 * Built here, before the socket, because the hook can be asked the moment a
	 * host starts and a relay built afterwards would refuse the first call of the
	 * session for want of itself.
	 */
	relay: GateRelay;
	/**
	 * Answers a permission an ACP-driven agent asks, from the same policy the hook
	 * is enforced with.
	 *
	 * Carried on this object rather than rebuilt where the runner is, because a
	 * second `enforcementHandler` would hold a second policy cache, and two caches
	 * of one policy is two answers to one question waiting to happen.
	 */
	acpGate: (cwd: string, ask: PermissionAsk) => Promise<PermissionAnswer>;
	/**
	 * Records which persona acts in a directory.
	 *
	 * `connect` fills this from a local spec when it finds one. A persona created in
	 * the workspace has no local spec, so the first thing that can say is the job that
	 * assigns it, and until something does the hook refuses there by name.
	 */
	bind(root: string, personaVersionId: string): void;
	/** Hands over the runner once the socket exists, so a gate can find its run. */
	attachRuns(lookup: (cwd: string) => { jobId: string; reporter: unknown } | null): void;
}

/**
 * Puts the machine's limits in front of every tool call, before the wire is
 * even up.
 *
 * The order matters. Enforcement is local and starts first, so a persona is
 * governed on this machine whether or not the workspace is reachable. The
 * socket comes up, the hook is installed, and only then does the daemon dial
 * out. A design where the workspace had to answer first would mean an agent
 * that runs unchecked whenever the network is down, which is exactly backwards.
 */
export function startEnforcement(scope: string[], options: StartOptions = {}): EnforcementRuntime {
	const cache = new PolicyCache();
	const byRoot = new Map<string, string>();
	const servers: Server[] = [];

	// The runner arrives later, with the socket. Until it does, and whenever no run
	// is in flight, there is genuinely nobody to ask and the relay says so rather
	// than inventing somebody.
	let runFor: (cwd: string) => { jobId: string; reporter: { reportWire(body: never): void } } | null =
		() => null;
	const relay = new GateRelay({ runFor: (cwd) => runFor(cwd) as never });

	/**
	 * Which persona a working directory is acting as.
	 *
	 * Lifted out of the per-root loop when the ACP gate arrived, so the hook's socket
	 * and an agent driven over the protocol get the SAME answer. Two copies of this
	 * would be two ideas about who a call belongs to, and the divergence would surface
	 * as one road enforcing a persona the other had never heard of.
	 *
	 * Longest match, so a persona in a subdirectory wins over the one at the root.
	 */
	const personaVersionFor = (cwd: string): string | null => {
		let best: string | null = null;
		let bestLength = -1;
		for (const [candidate, id] of byRoot) {
			if (cwd === candidate || cwd.replace(/\\/g, "/").startsWith(`${candidate.replace(/\\/g, "/")}/`)) {
				if (candidate.length > bestLength) {
					best = id;
					bestLength = candidate.length;
				}
			}
		}
		return best;
	};

	/**
	 * The gate an ACP-driven agent asks, which is the gate the hook asks.
	 *
	 * Built once, outside the per-root loop, because its dependencies are the same
	 * for every root and a second instance would hold a second policy cache.
	 *
	 * Measured on 2026-09-03: the ACP adapter never loads project settings, so the
	 * hook does not run on that path. Without this the daemon would be driving an
	 * agent with nothing deciding for it, and every screen would still say a policy
	 * was in force.
	 */
	/**
	 * The second axis, built once over the consented scope.
	 *
	 * The differentiator, and until E1 it ran only in tests: `gate/identity.ts` had
	 * zero consumers, so a call that would push a coordinate outside the envelope its
	 * persona declared was refused nowhere. It is passed to both handlers below,
	 * because an agent driven over ACP and an agent running under the hook are the
	 * same agent in the same directory, and one of them enforcing less would be a way
	 * around the gate rather than a second road to it.
	 */
	const identity = identityOver(scope);

	const acpGate = permissionFrom(
		enforcementHandler({
			cache,
			scope,
			openGate: (gate) => (options.openGate ? options.openGate(gate) : relay.open(gate)),
			personaVersionFor,
			identity,
		}),
	);

	for (const root of scope) {
		const personaVersionId = loadLocalPolicy(root, cache);
		if (personaVersionId) byRoot.set(root, personaVersionId);

		const handler = enforcementHandler({
			cache,
			// What the operator typed, and the only authority on whether a call is in
			// scope. Whether a persona is known there is the next question, not this one.
			scope,
			// The half of the gate that was missing. Without it every call a policy
			// gated was refused for want of anyone to ask, forever.
			openGate: (gate) => (options.openGate ? options.openGate(gate) : relay.open(gate)),
			personaVersionFor,
			identity,
		});

		try {
			servers.push(serveEnforcement(enforcementSocketPath(root), handler));
		} catch (error) {
			// Reported and not fatal: one unwritable project should not stop the
			// others, and the operator needs to know which one it was.
			console.error(
				chalk.yellow(`could not enforce in ${root}: ${error instanceof Error ? error.message : String(error)}`),
			);
			continue;
		}

		// D4: every adapter, not a named host. Arming only the agent somebody happened to
		// wire first would leave the other one running unchecked in the same directory, and
		// running two agents against one repository is the normal case.
		const armed: string[] = [];
		for (const adapter of HOST_ADAPTERS) {
			try {
				adapter.install(root);
				// The assurance travels with the host, because "installed" means something
				// different for a host whose hook nobody has watched fire.
				armed.push(adapter.assurance === "verified" ? adapter.name : `${adapter.name} (unverified)`);
			} catch (error) {
				// One host's unreadable settings file must not disarm the others in the
				// same project, and it has to be named rather than counted.
				console.error(
					chalk.yellow(
						`could not arm ${adapter.name} in ${root}: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		}
		console.log(chalk.dim("enforcing in"), root, chalk.dim(`· ${armed.join(", ") || "no host armed"}`));
	}

	return {
		cache,
		servers,
		relay,
		acpGate,
		bind: (root, personaVersionId) => byRoot.set(root, personaVersionId),
		attachRuns: (lookup) => {
			runFor = lookup as never;
		},
	};
}

/**
 * Compiles the persona that lives in a directory, so the machine can enforce
 * without asking anyone.
 *
 * A directory with no persona is not an error. It means this machine has
 * nothing to say about calls made there, and the handler refuses them rather
 * than inventing a policy, because a made-up policy is worse than none: it
 * would look like enforcement while enforcing something nobody wrote.
 */
function loadLocalPolicy(root: string, cache: PolicyCache): string | null {
	const path = join(root, ".personaxis", "personaxis.md");
	if (!existsSync(path)) return null;
	try {
		const spec = matter(readFileSync(path, "utf-8")).data as Record<string, unknown>;
		const identity = spec.identity as { name?: string } | undefined;
		const personaVersionId = `local:${identity?.name ?? "persona"}@${root}`;
		cache.put(policyFromPersona(spec, { personaVersionId }));
		return personaVersionId;
	} catch (error) {
		console.error(
			chalk.yellow(`could not read the persona in ${root}: ${error instanceof Error ? error.message : String(error)}`),
		);
		return null;
	}
}
