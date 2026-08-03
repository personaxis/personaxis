/**
 * What this machine tells the workspace about itself, and what it refuses to.
 *
 * Two rules shape everything here.
 *
 * The register frame is a claim, not a fact. A machine says it is called
 * "mac-studio" and that Claude Code 2.1 is installed; the workspace records the
 * claim and derives no authority from it. Identity comes from the device token,
 * which the workspace issued.
 *
 * Consent is local and only local. The set of directories a machine exposes is
 * decided at the keyboard, by the person sitting at it, and stored on that
 * machine. Nothing the workspace sends can widen it. This is the reason the
 * daemon can be pointed at a workspace an operator does not fully control
 * without that being a mistake.
 */

import { spawnSync } from "node:child_process";
import { hostname, platform, release } from "node:os";
import { isAbsolute, resolve } from "node:path";

import type { HostAgentName } from "@personaxis/protocol/workspace";

import { HOST_ADAPTERS } from "./host-adapter.js";

export interface DetectedHostAgent {
	name: HostAgentName;
	version: string;
}

/**
 * Derived from the adapters, not written again here.
 *
 * The binary's name is a fact about a host, and the adapter already owns every other fact
 * about one. Two lists would agree until somebody added a host to one of them, and the
 * failure that produces is a machine that reports it has no agent installed while the
 * runner is perfectly able to start it.
 */
const HOST_AGENT_PROBES: Array<{ name: HostAgentName; bin: string }> = HOST_ADAPTERS.map(
	(adapter) => ({ name: adapter.name, bin: adapter.launch.bin }),
);

/**
 * Asks each known host agent for its version.
 *
 * A missing binary is not an error and not a warning: most machines have one of
 * these, not all of them. The timeout exists because a probe that hangs would
 * hang `connect`, and a linking flow that stalls on an unrelated binary is a
 * linking flow people stop trusting.
 */
export function detectHostAgents(run = defaultRun): DetectedHostAgent[] {
	const found: DetectedHostAgent[] = [];
	for (const probe of HOST_AGENT_PROBES) {
		const version = run(probe.bin, ["--version"]);
		if (version) found.push({ name: probe.name, version });
	}
	return found;
}

function defaultRun(bin: string, args: string[]): string | null {
	const result = spawnSync(bin, args, {
		encoding: "utf-8",
		timeout: 3000,
		windowsHide: true,
		shell: process.platform === "win32",
	});
	if (result.status !== 0 || !result.stdout) return null;
	// Version output is one line of prose around a number ("2.1.4 (Claude
	// Code)"). The whole first line is kept: parsing it into a semver would
	// throw away the part that identifies a fork or a beta.
	return result.stdout.split("\n")[0]?.trim() || null;
}

export interface MachineIdentity {
	machine_name: string;
	os: string;
	daemon_version: string;
}

export function describeMachine(daemonVersion: string): MachineIdentity {
	return {
		machine_name: hostname(),
		os: `${platform()} ${release()}`,
		daemon_version: daemonVersion,
	};
}

/**
 * Normalises the directories an operator consented to expose.
 *
 * Rejects rather than silently drops: a person who typed a path that does not
 * resolve wants to hear about it now, not to discover later that the daemon has
 * been running with an empty scope. Relative paths resolve against the cwd,
 * because that is what a person typing `.` means.
 */
export function consentedDirs(input: string[], cwd = process.cwd()): string[] {
	const seen = new Set<string>();
	for (const raw of input) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const full = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
		seen.add(full);
	}
	return [...seen].sort();
}

/**
 * True when a path lies inside the consented scope.
 *
 * The check is on resolved paths with a separator boundary, so `/work` does not
 * admit `/workspace-of-someone-else`. The daemon calls this before anything
 * leaves the machine.
 */
export function isWithinScope(candidate: string, scope: string[]): boolean {
	if (scope.length === 0) return false;
	const full = resolve(candidate);
	return scope.some((dir) => {
		const root = resolve(dir);
		if (full === root) return true;
		const prefix = root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`;
		const normalised = full.replace(/\\/g, "/");
		return normalised.startsWith(prefix.replace(/\\/g, "/"));
	});
}
