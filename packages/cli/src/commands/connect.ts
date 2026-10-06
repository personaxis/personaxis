/**
 * `personaxis connect`: link this machine to a workspace and hold the wire open.
 *
 * The whole command is one promise to the operator. Their repository does not
 * move, their files are not uploaded, and the workspace sees exactly what
 * happens inside the directories they named here and nothing outside them. Every
 * choice below is downstream of that: consent is asked for at this keyboard,
 * the scope is printed before the socket opens, and the token is never echoed.
 */

import { spawn } from "node:child_process";
import chalk from "chalk";
import { Command } from "commander";

import { version } from "../generated/assets.js";
import {
	claimDeviceToken,
	startDeviceFlow,
	type ClaimOutcome,
	type StartedFlow,
} from "../workspace/device-flow.js";
import { DaemonConnection, type ConnectionState } from "../workspace/connection.js";
import { launchCommandFor } from "../workspace/host-adapter.js";
import { endingsFor, rememberInFlight, takeInFlight } from "../workspace/in-flight.js";
import { JobRunner } from "../workspace/job-runner.js";
import { consentedDirs, describeMachine, detectHostAgents } from "../workspace/machine.js";
import { nodeSocketFactory, socketSupported, unsupportedSocketMessage } from "../workspace/socket.js";
import {
	credentialIsDamaged,
	devicePath,
	forgetDevice,
	loadDevice,
	readRecord,
	rememberMachineId,
	saveDevice,
} from "../workspace/token-store.js";
import { WorkspaceClient, WorkspaceError } from "../workspace/client.js";
import { appUrl, daemonSocketUrl } from "../workspace/urls.js";
import { startEnforcement, type EnforcementRuntime } from "../workspace/local-enforcement.js";

interface ConnectOptions {
	dir?: string[];
	open?: boolean;
	linkOnly?: boolean;
}

async function runConnect(opts: ConnectOptions): Promise<void> {
	const app = appUrl();
	const scope = consentedDirs(opts.dir ?? []);

	let device = loadDevice();

	// A credential that exists and cannot be read is not the same as none.
	//
	// Linking again over one is how a workspace collects several machines for a
	// single computer: the old row keeps a token nobody will use, and the operator
	// is never told why they were asked twice. So this stops, and says which file.
	if (!device && credentialIsDamaged()) {
		console.error(
			chalk.red(`${devicePath()} exists and cannot be read, so this machine may already be linked.`),
		);
		console.error(
			chalk.dim(
				"Linking again would add a second machine for this computer. Run `personaxis connect logout --local` to forget it here, then connect again.",
			),
		);
		process.exitCode = 1;
		return;
	}

	if (!device) {
		const linked = await linkMachine(app, opts.open !== false);
		if (!linked) process.exitCode = 1;
		if (!linked) return;
		device = loadDevice();
		if (!device) {
			console.error(chalk.red("The token was claimed but could not be read back."));
			process.exitCode = 1;
			return;
		}
	} else {
		console.log(chalk.dim("machine already linked to"), device.record.app_url || app);
	}

	if (opts.linkOnly) {
		printScope(scope);
		return;
	}

	if (!socketSupported()) {
		console.error(chalk.red(unsupportedSocketMessage()));
		process.exitCode = 1;
		return;
	}

	printScope(scope);
	const enforcement = startEnforcement(scope);
	try {
		await holdTheWire(device.token, scope, enforcement);
	} finally {
		for (const server of enforcement.servers) server.close();
	}
}


/**
 * Runs the device authorization flow.
 *
 * The URL is printed before the browser is opened, because opening a browser
 * fails on servers, over SSH, and inside containers, and an operator who can
 * read the URL is never stuck.
 */
async function linkMachine(app: string, openBrowser: boolean): Promise<boolean> {
	const machine = describeMachine(version);
	let flow: StartedFlow;
	try {
		flow = await startDeviceFlow(app, machine);
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		return false;
	}

	console.log();
	console.log(chalk.bold("Approve this machine in your workspace:"));
	console.log(`  ${chalk.cyan(flow.verification_url)}`);
	console.log();
	console.log(chalk.dim("machine:"), machine.machine_name);
	console.log(chalk.dim("os:     "), machine.os);
	console.log();

	if (openBrowser) tryOpen(flow.verification_url);

	let lastPrinted = -1;
	const outcome: ClaimOutcome = await claimDeviceToken(app, flow, undefined, (secondsLeft) => {
		// Printed once a minute rather than every poll: a countdown that
		// redraws every two seconds is noise, and a wait with no sign of life
		// looks like a hang.
		const minute = Math.ceil(secondsLeft / 60);
		if (minute !== lastPrinted) {
			lastPrinted = minute;
			console.log(chalk.dim(`waiting for approval (${minute} min left)`));
		}
	});

	if (outcome.status !== "approved") {
		console.error(chalk.red(`not linked: ${outcome.reason}`));
		return false;
	}

	const record = saveDevice({
		token: outcome.value.token,
		record: {
			app_url: app,
			machine_name: machine.machine_name,
			machine_id: outcome.value.machine_id,
			space: outcome.value.space,
		},
	});

	console.log(chalk.green("machine linked"));
	console.log(chalk.dim("workspace:"), outcome.value.space_name);
	console.log(chalk.dim("machine:  "), outcome.value.machine_id);
	console.log(
		chalk.dim("token:    "),
		record.storage === "os"
			? "stored in the OS credential store"
			: "stored in ~/.personaxis/device.json (0600), this platform has no readable OS store",
	);
	return true;
}

/** Holds the socket open until the operator stops it. */
function holdTheWire(token: string, scope: string[], enforcement: EnforcementRuntime): Promise<void> {
	const { cache, relay } = enforcement;
	return new Promise((resolve) => {
		// What turns an assignment into a running agent. Constructed before the connection
		// because the connection can deliver a job the moment it registers, and a runner
		// built afterwards would miss it.
		let runner: JobRunner;

		const connection = new DaemonConnection({
			url: daemonSocketUrl(),
			token,
			register: {
				...describeMachine(version),
				host_agents: detectHostAgents(),
				working_dirs: scope,
				// What this machine already holds, so the workspace can push only
				// what changed instead of every policy on every connection.
				cached_policies: cache.summary(),
			},
			socketFactory: nodeSocketFactory,
			forgetToken: () => forgetDevice(),
			handlers: {
				onRegistered: (machineId) => {
					rememberMachineId(machineId);
					console.log(chalk.green("connected"), chalk.dim(machineId));

					// What the last process was doing when it stopped.
					//
					// Reported here rather than at startup because it has to go down a
					// socket that is registered: an event sent before that is an event
					// in a dialect the server has not agreed to yet.
					//
					// It reports, it does not resume. The agent went with the process,
					// and `personaAgent` says `loadSession: false` out loud, so what a
					// person is owed is the truth: this stopped, here is why, nothing
					// after it happened.
					const abandoned = takeInFlight();
					for (const ending of endingsFor(abandoned)) {
						connection.emit(ending);
					}
					if (abandoned.length > 0) {
						console.error(
							chalk.yellow(
								`ended ${abandoned.length} run(s) that did not survive the last restart`,
							),
						);
					}
				},
				onStateChange: (state, detail) => report(state, detail),
				onRevoked: () => {
					console.error(
						chalk.red("this machine was revoked in the workspace; the local token was deleted"),
					);
					process.exitCode = 1;
					resolve();
				},
				onDropped: (jobId, count) => {
					console.error(chalk.yellow(`dropped ${count} queued events for job ${jobId} (offline too long)`));
				},
				onServerMessage: (message) => {
					// A tightening of the rules, applied before anything else looks at
					// the message. Dropping the cached policy makes the next call for
					// that persona deny with `no_policy`, which is the closed answer and
					// names itself; the next assignment carries the rules that replaced
					// these.
					//
					// Handled here rather than in the runner because it is the CACHE that
					// changes, and the runner deliberately does not own it: it hands over
					// what arrived and never evicts, so that a job cannot rewrite policy
					// for jobs that are not its own.
					if (message.type === "policy.stale") {
						for (const versionId of message.persona_version_ids) cache.drop(versionId);
						console.error(
							chalk.yellow(
								`dropped ${message.persona_version_ids.length} cached policy/policies: ${message.reason}`,
							),
						);
						return;
					}
					runner.handle(message);
				},
			},
		});

		// The host is chosen here, on the machine, from what is installed. The workspace
		// does not get to name it: which agent runs on somebody's laptop is theirs to
		// decide, and a message that could pick it would be a message that picks which
		// binary this daemon executes.
		const installed = detectHostAgents();
		runner = new JobRunner({
			sink: connection,
			scope,
			host: installed[0]?.name ?? "claude-code",
			launcher: launchCommandFor,
			// The policy that arrives with a job goes into the cache the hook reads.
			// Until now the cache held only what `connect` found in a local
			// `.personaxis/personaxis.md`, so a persona created in the workspace had
			// no policy on this machine at all and every one of its calls was refused
			// for having none.
			// A person's answer comes down this socket and has to reach the hook that
			// is still holding its call open.
			// The persona's own policy answering the agent it drives, BEFORE the call
			// runs rather than as a veto after. Same gate the hook asks, so one rule has
			// one answer whichever road a call arrives on.
			decide: (cwd, ask) => enforcement.acpGate(cwd, ask),
			onGateResolved: (gateId, outcome) => relay.resolve(gateId, outcome),
			// And a run that ended answers nothing more, so its gates stop waiting.
			onJobEnded: (jobId) => relay.abandon(jobId),
			// Kept on disk so the next process can end what this one was doing, if
			// this one does not get to.
			onInFlight: (jobs) => rememberInFlight(jobs),
			onPolicy: (policy, cwd) => {
				// E30: `compile` refuses a policy it cannot enforce, and that refusal
				// arrives here, on a callback from the wire. Caught rather than allowed to
				// escape, for two reasons that point the same way. A throw out of a socket
				// handler takes the whole daemon's connection with it, so one bad push
				// would stop this machine enforcing anything anywhere. And the directory
				// is deliberately left UNBOUND: a policy nobody could compile is a policy
				// nobody can enforce, so calls there are refused for having no persona,
				// which is the closed answer. What was missing before was the sentence
				// saying why.
				try {
					cache.put(policy);
				} catch (error) {
					console.error(
						chalk.red(
							`refused a policy for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
						),
					);
					return;
				}
				// Without this the machine holds the policy and still cannot say who it
				// belongs to in that directory, so every call there is refused for having
				// no persona while the policy sits in the cache unused.
				enforcement.bind(cwd, policy.persona_version_id);
			},
		});

		// Now the relay can find a run. Before this the lookup answered "none", which
		// is the honest answer while there is no runner rather than a missing case.
		enforcement.attachRuns((cwd) => runner.runFor(cwd));

		const stop = () => {
			// A gate waiting on a person cannot be answered once the wire is down.
			relay.abandon();
			connection.stop();
			console.log(chalk.dim("disconnected"));
			resolve();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);

		connection.start();
		console.log(chalk.dim("holding the wire, ctrl+c to stop"));
	});
}

function report(state: ConnectionState, detail?: string): void {
	if (state === "online") return; // onRegistered already said it
	const label = detail ? `${state}: ${detail}` : state;
	console.log(chalk.dim(label));
}

function printScope(scope: string[]): void {
	if (scope.length === 0) {
		console.log(
			chalk.yellow("no directories exposed."),
			chalk.dim("Nothing on this machine is visible to the workspace. Add --dir <path> to change that."),
		);
		return;
	}
	console.log(chalk.dim("exposed directories:"));
	for (const dir of scope) console.log(`  ${dir}`);
}

/** Best effort. A browser that does not open is not an error, only a URL to paste. */
function tryOpen(url: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
	} catch {
		/* the URL is already printed */
	}
}

const statusCmd = new Command("status")
	.description("Show which workspace this machine is linked to")
	.action(async () => {
		const record = readRecord();
		const device = loadDevice();
		if (!record && !device) {
			console.log(chalk.dim("this machine is not linked. Run `personaxis connect`."));
			return;
		}

		console.log(chalk.dim("workspace:"), record?.app_url || appUrl());
		console.log(chalk.dim("machine:  "), record?.machine_name ?? "(unknown)");
		if (record?.machine_id) console.log(chalk.dim("machine id:"), record.machine_id);
		if (record?.linked_at) console.log(chalk.dim("linked:   "), record.linked_at);
		console.log(
			chalk.dim("token:    "),
			device ? `held (${device.storage})` : chalk.yellow("described but missing, re-run `personaxis connect`"),
		);

		if (!device) return;
		try {
			const me = await new WorkspaceClient().whoami();
			console.log(chalk.green("token accepted by the workspace"));
			console.log(chalk.dim("workspace:"), me.space_name);
			console.log(chalk.dim("scopes:   "), me.scopes.join(", ") || "(none)");
		} catch (error) {
			// Reported, not swallowed: a token the workspace no longer accepts is
			// the single most useful thing this command can tell someone.
			const message = error instanceof WorkspaceError ? error.message : String(error);
			console.error(chalk.red(`the workspace refused this token: ${message}`));
			process.exitCode = 1;
		}
	});

const logoutCmd = new Command("logout")
	.description("Revoke this machine's token and forget it locally")
	.option("--local", "Only forget the token here, do not revoke it in the workspace", false)
	.action(async (opts: { local?: boolean }) => {
		const record = readRecord();
		const device = loadDevice();

		if (!opts.local && device && record?.machine_id) {
			try {
				await new WorkspaceClient().revokeMachine(record.machine_id);
				console.log(chalk.green("revoked in the workspace"));
			} catch (error) {
				const message = error instanceof WorkspaceError ? error.message : String(error);
				// The local token is still deleted below. Leaving it in place
				// because a revoke call failed would be the worse of the two.
				console.error(chalk.yellow(`could not revoke server-side: ${message}`));
				console.error(chalk.yellow("delete the machine in the workspace settings to be sure."));
				process.exitCode = 1;
			}
		} else if (!opts.local && device && !record?.machine_id) {
			console.error(
				chalk.yellow("no machine id on file, so nothing was revoked server-side. Deleting the local token."),
			);
			process.exitCode = 1;
		}

		const { removed } = forgetDevice();
		console.log(removed ? chalk.green("local token deleted") : chalk.dim("no local token to delete"));
	});

export const connectCommand = new Command("connect")
	.description(
		"[requires a Personaxis workspace] Link this machine and stream its work to the workspace (device flow → gw.personaxis.com)",
	)
	.alias("login")
	.option("--dir <path>", "Expose a directory to the workspace (repeatable)", collect, [])
	.option("--no-open", "Do not open a browser, just print the approval URL")
	.option("--link-only", "Link the machine and exit without holding the socket open", false)
	.action(runConnect)
	.addCommand(statusCmd)
	.addCommand(logoutCmd);

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}
