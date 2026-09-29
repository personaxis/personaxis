/**
 * `personaxis-acp`, the process an editor launches to run one of our personas.
 *
 * Zed, JetBrains, VS Code and anything else that speaks the Agent Client Protocol
 * start an agent as a child process and talk to it over stdio. This is that process.
 * It is a binary rather than a subcommand for the same reason `personaxis-hook` is:
 * what an editor measures is how long it takes to start, and a subcommand pays for
 * the whole CLI's module graph before it answers anything.
 *
 * ## Deliberately thin
 *
 * Everything here is wiring, and everything it wires is tested elsewhere:
 * `serveAcpOverStdio` frames the protocol, `personaAgent` answers it,
 * `persona-updates.ts` translates, and `run.runnerFor` runs the turn with the gate
 * and the record already attached. What is left is the part that needs a real
 * persona and a real model, and a test of it would be a test of a model.
 *
 * So the rule for this file is that it must stay obvious. Anything that needs
 * explaining belongs in one of the modules above, where something can check it.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
	EventBus,
	mapLoopEvent,
	personaResourceRoots,
	policyFromFrontmatter,
	resolveModel,
	run,
	type LoopEvent,
} from "@personaxis/core";
import { ACP_PROTOCOL_VERSION, serveAcpOverStdio } from "@personaxis/protocol";

import { buildAwarenessBlock } from "./repl/awareness.js";
import { recompileHookFor } from "./repl/session.js";
import { personaAgent, type PersonaSession } from "./workspace/persona-agent.js";

/** Where a persona lives relative to the work it does. The same join the hook uses. */
function specPathFor(cwd: string): string {
	return join(cwd, ".personaxis", "personaxis.md");
}

/**
 * Opens the persona that lives in a directory.
 *
 * Throws when there is none, or when there is one and no model is configured, and
 * both reach the editor as a failed `session/new`. That is the honest place for them:
 * a session that opened and then failed every turn would look like a persona with
 * nothing to say.
 */
async function openPersona(cwd: string): Promise<PersonaSession> {
	const assembled = run.assemble(specPathFor(cwd));
	const frontmatter = assembled.handle.frontmatter as Record<string, unknown>;

	const llm = resolveModel({ personaPath: assembled.personaPath, frontmatter });
	if (!llm) {
		throw new Error(
			"this persona has no model configured: set config.json local.endpoint and local.model, " +
				"or PERSONAXIS_ENDPOINT and PERSONAXIS_MODEL",
		);
	}

	let controller: AbortController | null = null;
	// E117: the persona evolves from what it does here too. Until 2026-09-23 a persona working from an
	// editor never changed however much it worked, because only the TUI ran its living loop. The inline
	// recompile is the TUI's own, so a band crossed here rewrites the same document for the next session.
	const evolver = run.evolverFor(
		{ personaPath: assembled.personaPath, frontmatter },
		{ recompile: recompileHookFor(assembled.personaPath, assembled.compiledPath) },
	);

	return {
		cancel: () => controller?.abort(),
		run: async (prompt, hooks) => {
			const bus = new EventBus();
			// One call id per proposal, assigned before the mapping, so the request and
			// its result reuse it. The same rule `JobReporter` follows, and for the same
			// reason: an id minted on the other side would give one call two names.
			let calls = 0;
			let currentCall = "";
			bus.on((event: LoopEvent) => {
				if (event.type === "tool-propose") {
					calls += 1;
					currentCall = `call_${calls}`;
				}
				const mapped = mapLoopEvent(event, { callId: currentCall });
				// E24's ephemeral channel is not forwarded here, and that is a choice
				// rather than an oversight: ACP has its own streaming vocabulary for a
				// session, and translating one live channel into another without deciding
				// what a dropped delta means on the far side is how two protocols end up
				// disagreeing about what the persona said.
				if ("emit" in mapped) hooks.emit(mapped.emit);
			});

			controller = new AbortController();
			const runner = run.runnerFor(
				{ personaPath: assembled.personaPath, frontmatter, llm },
				{
					policy: {
						...policyFromFrontmatter(frontmatter, cwd),
						resourceRoots: personaResourceRoots(assembled.personaPath),
					},
					personaBody: run.identityOf(assembled),
					// E79: what the persona has and where its work goes. A turn from an editor used to get
					// none of it, so the same persona knew less about itself in Zed than in the TUI.
					awareness: buildAwarenessBlock(assembled.personaPath, { frontmatter, cwd }),
					// The envelope, in an application we did not write. When the policy wants
					// a person rather than a rule, the question goes to the editor and
					// whoever is sitting there answers it.
					onApproval: async (call, verdict) =>
						(await hooks.approve(
							{ name: call.name, args: call.args, id: currentCall },
							String(verdict?.reason ?? ""),
						))
							? "approve"
							: {
									decision: "deny" as const,
									// C6b: named, because this refusal has a person behind it and
									// the record used to credit "the user" on every path, including
									// the ones where nobody was asked at all.
									reason: "the person driving this editor was asked and said no",
								},
					// The record is written here, on this machine, whoever is driving.
					observer: run.recordingTurns({
						personaPath: assembled.personaPath,
						statePath: assembled.handle.statePath,
					}),
					bus,
				},
			);

			const outcome = await runner.run(
				{
					turn: randomUUID(),
					prompt,
					// A program drove this turn. Which program is the editor's business and
					// not something we can know, so it is named as what it is rather than
					// guessed at: `human` would put somebody's hand on a turn they did not
					// take, and `persona` would say it asked itself.
					asker: { kind: "component", name: "acp-client" },
				},
				controller.signal,
			);
			// After the answer is in hand, and never able to cost it: `livedThrough` does not throw.
			// The prompt is observed as a person's words because in an editor a person typed it; the
			// approval hook above already names that person as the one who said yes or no.
			await run.livedThrough(evolver, { request: prompt, outcome });

			// E149: and what the engine checked in the delivery, which `personaAgent` tells the editor when it failed.
			return { stopReason: outcome.stopReason, ...(outcome.delivered === undefined ? {} : { delivered: outcome.delivered }) };
		},
	};
}

serveAcpOverStdio({
	stdin: process.stdin,
	stdout: process.stdout,
	agent: (client) =>
		personaAgent(client, {
			protocolVersion: ACP_PROTOCOL_VERSION,
			name: "personaxis",
			open: openPersona,
		}),
});
