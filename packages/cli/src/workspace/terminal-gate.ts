/**
 * Who answers a gate when there is no workspace: the person at the terminal that started `guard`.
 *
 * L14 (2026-10-03): the first published version of the CLI works without the workspace, so a call the persona's policy
 * says needs a person cannot be sent to a browser. It is asked here, one at a time, with the reason the policy gave and
 * the time the policy allows. When nobody can answer (the terminal is not interactive), the answer is `unreachable`,
 * which the enforcement turns into a refusal with that reason; a gated call is never let through for want of a person.
 */

import type { GateOutcome, GateRequest } from "./enforcement-service.js";

/** How the gate reaches a person. `ask` resolves with what they typed, or null when the time ran out. */
export interface TerminalIo {
	readonly interactive: boolean;
	ask(question: string, timeoutMs: number): Promise<string | null>;
}

/**
 * Builds the `openGate` that asks at the terminal.
 *
 * Questions are queued, because two hosts can ask at once and two prompts on one terminal would take one person's
 * answer for both. Only a typed `y` or `yes` approves; anything else, including an empty line, declines.
 */
export function askAtTerminal(io: TerminalIo): (gate: GateRequest) => Promise<GateOutcome> {
	let queue: Promise<unknown> = Promise.resolve();
	return (gate) => {
		if (!io.interactive) return Promise.resolve("unreachable");
		const turn = queue.then(async (): Promise<GateOutcome> => {
			const args = gate.args_text.length > 200 ? `${gate.args_text.slice(0, 200)}…` : gate.args_text;
			const question = `\n${gate.tool} ${args}\n  in ${gate.cwd}\n  ${gate.reason}\nAllow this call? [y/N] `;
			const answer = await io.ask(question, gate.timeout_seconds * 1000);
			if (answer === null) return "expired";
			return /^(y|yes)$/i.test(answer.trim()) ? "approved" : "denied";
		});
		queue = turn.catch(() => undefined);
		return turn;
	};
}
