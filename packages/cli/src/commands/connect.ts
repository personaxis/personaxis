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
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";
import chalk from "chalk";
import { Command } from "commander";
import matter from "gray-matter";
import { readFileSync } from "node:fs";
import { policyFromPersona } from "@personaxis/core";

import { version } from "../generated/assets.js";
import { enforcementSocketPath, serveEnforcement } from "../workspace/enforcement-endpoint.js";
import { enforcementHandler } from "../workspace/enforcement-service.js";
import { HOST_ADAPTERS } from "../workspace/host-adapter.js";
import { PolicyCache } from "../workspace/policy-cache.js";
import {
	claimDeviceToken,
	startDeviceFlow,
	type ClaimOutcome,
	type StartedFlow,
} from "../workspace/device-flow.js";
import { DaemonConnection, type ConnectionState } from "../workspace/connection.js";
import { launchCommandFor } from "../workspace/host-adapter.js";
import { JobRunner } from "../workspace/job-runner.js";
import { consentedDirs, describeMachine, detectHostAgents } from "../workspace/machine.js";
import { nodeSocketFactory, socketSupported, unsupportedSocketMessage } from "../workspace/socket.js";
import {
	forgetDevice,
	loadDevice,
	readRecord,
	rememberMachineId,
	saveDevice,
} from "../workspace/token-store.js";
import { WorkspaceClient, WorkspaceError } from "../workspace/client.js";
import { appUrl, daemonSocketUrl } from "../workspace/urls.js";

interface ConnectOptions {
	dir?: string[];
	open?: boolean;
	linkOnly?: boolean;
}

async function runConnect(opts: ConnectOptions): Promise<void> {
	const app = appUrl();
	const scope = consentedDirs(opts.dir ?? []);

	let device = loadDevice();
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
		await holdTheWire(device.token, scope, enforcement.cache);
	} finally {
		for (const server of enforcement.servers) server.close();
	}
}

interface EnforcementRuntime {
	cache: PolicyCache;
	servers: Server[];
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
function startEnforcement(scope: string[]): EnforcementRuntime {
	const cache = new PolicyCache();
	const byRoot = new Map<string, string>();
	const servers: Server[] = [];

	for (const root of scope) {
		const personaVersionId = loadLocalPolicy(root, cache);
		if (personaVersionId) byRoot.set(root, personaVersionId);

		const handler = enforcementHandler({
			cache,
			personaVersionFor: (cwd) => {
				// Longest match, so a persona in a subdirectory wins over the one
				// at the repository root.
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
			},
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

	return { cache, servers };
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
function holdTheWire(token: string, scope: string[], cache: PolicyCache): Promise<void> {
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
				onServerMessage: (message) => runner.handle(message),
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
		});

		const stop = () => {
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
