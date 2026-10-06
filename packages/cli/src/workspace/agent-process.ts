/**
 * The one place the daemon starts an agent, and the one line that decides whether
 * anybody can talk to it.
 *
 * Extracted when the ACP bridge arrived, because there were about to be two session
 * models and the boundary test says an agent process starts in one place. Adding an
 * exemption would have been the cheap answer and the wrong one: the reason for the
 * rule is that a second launcher is a second thing to find and change, and a bridge
 * that made itself an exception would have proved the rule right by breaking it.
 *
 * ## `input` is the whole difference, and it is why phase 11 exists
 *
 * The stdout-parsing path launches with `stdin: "ignore"`. That single word is why
 * talking to a persona while it works has been impossible rather than unbuilt: the
 * agent is handed a prompt as an argument and the channel back into it is closed
 * before it starts. Every screen that would have shown an intervention was
 * downstream of a pipe that was never opened.
 *
 * The ACP path opens it. Same spawn, same consented directory, same kill on the way
 * out; a session instead of a shot.
 *
 * Keeping both here means the contrast is one parameter in one file rather than two
 * files that happen to differ, and it means the next transport gets the working
 * directory, the environment and the exit handling for free instead of by copying.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** Re-exported so nothing else in the daemon has to reach for `node:child_process`. */
export type { ChildProcess };

/** The shape tests inject in place of the real thing. */
export type SpawnFn = typeof spawn;

export interface AgentProcessOptions {
	/** The agent binary. Named by the adapter, never guessed at here. */
	readonly command: string;
	readonly args: readonly string[];
	/** The directory the agent runs in. One of the consented ones. */
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Whether anything can be said to it once it starts.
	 *
	 * `ignore` is a shot: the prompt went in as an argument and there is no way back
	 * in. `pipe` is a session. See the header; this is the parameter phase 11 is about.
	 */
	readonly input: "ignore" | "pipe";
	/** Injected for tests. */
	readonly spawnFn?: SpawnFn;
}

/**
 * Starts it, and throws the way `spawn` throws.
 *
 * Synchronous throws are real: a command that is not a string, an invalid working
 * directory. `ENOENT` arrives on the error event instead, so both have to be handled,
 * and this function deliberately does neither. A launcher that swallowed a failure
 * would decide on its caller's behalf what a dead agent means, and the two callers
 * mean different things by it.
 */
export function startAgent(options: AgentProcessOptions): ChildProcess {
	const spawnFn = options.spawnFn ?? spawn;
	return spawnFn(options.command, [...options.args], {
		cwd: options.cwd,
		env: options.env,
		stdio: [options.input, "pipe", "pipe"],
	});
}
