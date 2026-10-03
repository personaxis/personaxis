/**
 * `personaxis guard`: enforce the persona's policy on the agents working in a directory, with no workspace.
 *
 * L14 (2026-10-03). A host's hook (Claude Code, Codex) asks a socket on this machine before every tool call, and that
 * socket answers from the persona's own file. It used to start only inside `connect`, after linking the machine to a
 * workspace; the first published version of the CLI works without one, so this starts the same enforcement on its own
 * and holds it until it is stopped. A call the policy says needs a person is asked here, at this terminal.
 */

import { createInterface } from "node:readline";
import chalk from "chalk";
import { Command } from "commander";

import { startEnforcement } from "../workspace/local-enforcement.js";
import { consentedDirs } from "../workspace/machine.js";
import { socketSupported, unsupportedSocketMessage } from "../workspace/socket.js";
import { askAtTerminal, type TerminalIo } from "../workspace/terminal-gate.js";

/** Reads one answer from this terminal, or null when the time runs out. */
function terminalIo(): TerminalIo {
	return {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		ask: (question, timeoutMs) =>
			new Promise((resolve) => {
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				const timer = setTimeout(() => {
					rl.close();
					process.stdout.write(chalk.yellow("\nno answer in time, so the call was refused\n"));
					resolve(null);
				}, timeoutMs);
				timer.unref?.();
				rl.question(question, (answer) => {
					clearTimeout(timer);
					rl.close();
					resolve(answer);
				});
			}),
	};
}

async function runGuard(opts: { dir?: string[] }): Promise<void> {
	const scope = consentedDirs(opts.dir?.length ? opts.dir : [process.cwd()]);
	if (!socketSupported()) {
		console.error(chalk.red(unsupportedSocketMessage()));
		process.exitCode = 1;
		return;
	}
	const io = terminalIo();
	const enforcement = startEnforcement(scope, { openGate: askAtTerminal(io) });
	if (enforcement.servers.length === 0) {
		console.error(chalk.red("nothing to guard: no directory could be enforced"));
		process.exitCode = 1;
		return;
	}
	console.log(
		chalk.dim(
			io.interactive
				? "guarding. A call that needs a person is asked here. Ctrl+C stops."
				: "guarding. This terminal cannot answer, so a call that needs a person is refused. Ctrl+C stops.",
		),
	);
	await new Promise<void>((resolve) => {
		const stop = () => resolve();
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	for (const server of enforcement.servers) server.close();
	console.log(chalk.dim("guard stopped; the hosts' hooks now refuse every call until it runs again"));
}

export const guardCommand = new Command("guard")
	.description("Enforce the persona's policy on the agents working here (Claude Code, Codex), on this machine only")
	.option("--dir <path>", "A directory to guard (repeatable; default: the current one)", (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
	.action(runGuard);
