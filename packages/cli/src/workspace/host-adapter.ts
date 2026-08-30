/**
 * Making a host agent ask before it acts.
 *
 * One interface, because the second adapter is the point: the daemon should not
 * learn anything new when Codex arrives, and neither should the enforcement
 * path. What differs between hosts is where a settings file lives and what
 * shape a hook takes in it. What does not differ is that a call is refused
 * before it runs.
 *
 * Installation is idempotent and additive: a project's existing hooks are left
 * alone, ours is recognised by its command, and uninstalling removes only ours.
 * Anything else would make adopting this cost someone their own configuration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { HostAgentName } from "@personaxis/protocol/workspace";

import { enforcementEndpointToken } from "./enforcement-endpoint.js";

/** Recognises our hook among a project's others, across versions. */
export const HOOK_MARKER = "personaxis-hook";

/**
 * The other half of recognising it, and the half that survives how it is spawned.
 *
 * A hook written when the CLI was installed globally names `personaxis-hook`; one
 * written from a checkout names a Node binary and a script path, and neither string
 * contains the other. Recognising only the first would make an upgrade install a
 * SECOND hook beside the first, so every tool call would be gated twice, and would
 * make uninstall leave one behind.
 *
 * The endpoint is in both, because a hook that does not name an endpoint is not ours
 * whatever it is called.
 */
export const HOOK_ENDPOINT_MARKER = "personaxis-enforce-";

/** Whether a command in somebody's settings file is one of ours, in any form. */
export function isOurHook(command: string | undefined): boolean {
	return Boolean(command && (command.includes(HOOK_MARKER) || command.includes(HOOK_ENDPOINT_MARKER)));
}

/**
 * The host's own ceiling on how long a hook may take, in seconds.
 *
 * Set explicitly rather than left to the default, because a gate is a person
 * deciding and people are slower than any default. Thirty minutes matches the
 * gate timeout the workspace uses; past it the daemon answers with a refusal of
 * its own, so this is a backstop and not the mechanism.
 */
export const HOOK_TIMEOUT_SECONDS = 1830;

export interface AdapterStatus {
	host: HostAgentName;
	settingsPath: string;
	installed: boolean;
}

/**
 * How far the claim "this host asks before it acts" has actually been checked.
 *
 * Writing a hook into a settings file is not the same as a host running it, and the gap
 * between those two is the most dangerous state this code can be in: an operator who
 * believes calls are being refused, while nothing is intercepting them. Nothing in a
 * settings file can tell them apart, so the adapter says which it is and every surface
 * repeats it.
 *
 * `verified` means a call has been observed being refused before it ran, in a test against
 * the real binary. `documented` means the hook is written in the shape the host's own
 * documentation specifies, and nobody here has watched it fire.
 */
export type EnforcementAssurance = "verified" | "documented";

/**
 * How a host is started for a job the workspace sent, and how it is recognised on a machine.
 *
 * Here rather than beside the process that spawns it, for the same reason the settings path
 * is: this is the file that owns what differs between vendors, and the runner should not
 * learn anything new when a second host arrives.
 *
 * `bin` is also what the machine probe looks for, so the binary's name is written once.
 *
 * `streamArgs` absent means this host cannot be driven programmatically by us yet. That is a
 * refusal with a reason rather than a guess: starting a host with flags taken from memory
 * produces either an error nobody can read or, worse, an agent running in a mode we did not
 * intend, in a real directory, with real tools.
 */
export interface HostLaunchSpec {
	/** The executable, as it is found on PATH. */
	bin: string;
	/** Everything before the prompt: the flags that make it print a machine-readable stream. */
	streamArgs?: readonly string[];
}

export interface HostAdapter {
	name: HostAgentName;
	/** Where this host reads project settings from, given a working directory. */
	settingsPath(root: string): string;
	/** The host's name for the event that fires BEFORE a tool call runs. */
	preToolUseEvent: string;
	assurance: EnforcementAssurance;
	launch: HostLaunchSpec;
	install(root: string): AdapterStatus;
	uninstall(root: string): AdapterStatus;
	status(root: string): AdapterStatus;
}

/**
 * What a surface should say about a host's enforcement, in full.
 *
 * Two sentences on purpose, the same reason MCP provenance takes two: a single reassuring
 * word is how a control starts being trusted for something nobody checked.
 */
export function describeAssurance(adapter: HostAdapter): string {
	return adapter.assurance === "verified"
		? `Calls are refused before they run; that has been observed end to end for ${adapter.name}.`
		: `The hook is installed in the shape ${adapter.name} documents, and nobody here has watched it fire. ` +
				`If this host names the event differently, nothing intercepts the call and nothing says so.`;
}

interface CommandHook {
	type: string;
	command: string;
	timeout?: number;
}

interface HookGroup {
	matcher?: string;
	hooks?: CommandHook[];
}

interface Settings {
	hooks?: Record<string, HookGroup[]>;
	[key: string]: unknown;
}

function readSettings(path: string): Settings {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Settings) : {};
	} catch {
		// Unreadable settings are treated as absent for READING, and install
		// refuses to write over them below. Overwriting a file we could not
		// parse would delete configuration someone wrote by hand.
		return {};
	}
}

/**
 * Brings any hook of ours up to the command we would write today.
 *
 * Returns whether one was found, so the caller knows not to add a second. The
 * timeout is rewritten too: it is part of what makes a gate answerable by a
 * person, and a machine that upgraded should not keep an old ceiling.
 */
function replaceOurHookIn(settings: Settings, event: string, command: string): boolean {
	let found = false;
	for (const group of settings.hooks?.[event] ?? []) {
		for (const hook of group.hooks ?? []) {
			if (!isOurHook(hook.command)) continue;
			hook.command = command;
			hook.timeout = HOOK_TIMEOUT_SECONDS;
			found = true;
		}
	}
	return found;
}

function hasOurHookIn(settings: Settings, event: string): boolean {
	return (settings.hooks?.[event] ?? []).some((group) =>
		(group.hooks ?? []).some((hook) => isOurHook(hook.command)),
	);
}

/**
 * How the host is told to start our hook: this Node, this script, both absolute.
 *
 * The bare name only resolves when the package was installed globally. A daemon
 * started from a checkout, from `npx`, or from a workspace link writes a settings
 * file naming a command the host cannot run, and every host we support treats a
 * hook that fails to start as a hook that said nothing: the tool call proceeds.
 *
 * That is precisely the state the note at the top of this file calls the most
 * dangerous one, an operator believing calls are refused while nothing intercepts
 * them, and it is reached not by a bug but by how somebody installed the package.
 * It was found by running a real job on a machine with no global install and
 * watching the agent's first `Bash` call run unchecked.
 *
 * `process.execPath` is the Node already running this daemon, so the command needs
 * no PATH at all. The bare marker stays as the fallback for a build where the
 * script cannot be located, because a hook that might resolve beats none.
 */
export function hookScriptPath(): string {
	return fileURLToPath(new URL("../hook-bin.js", import.meta.url));
}

export function hookInvocation(script: string = hookScriptPath()): string {
	return existsSync(script) ? `"${process.execPath}" "${script}"` : HOOK_MARKER;
}

/**
 * The command the host runs.
 *
 * The socket path is written in rather than derived at hook time, so a hook
 * that ends up in a copied repository fails to reach a daemon instead of
 * quietly reaching the wrong one.
 */
export function hookCommandFor(root: string): string {
	return `${hookInvocation()} --endpoint "${enforcementEndpointToken(root)}"`;
}

/**
 * An adapter for a host that keeps its hooks as JSON groups.
 *
 * Claude Code and Codex both do, in the same shape, in different files under different
 * event names. Writing the second adapter as a copy would have been quicker and would have
 * meant two places to fix the next time somebody notices that uninstall should leave a
 * project's own hooks alone. D4 exists to prove the daemon learns nothing new when a second
 * host arrives; a duplicated adapter would have made that false in the one place it counts.
 */
function jsonHookAdapter(spec: {
	name: HostAgentName;
	settingsPath(root: string): string;
	event: string;
	assurance: EnforcementAssurance;
	launch: HostLaunchSpec;
}): HostAdapter {
	return {
		name: spec.name,
		preToolUseEvent: spec.event,
		launch: spec.launch,
		assurance: spec.assurance,
		settingsPath: spec.settingsPath,

		install(root: string): AdapterStatus {
			const path = this.settingsPath(root);
			if (existsSync(path)) {
				try {
					JSON.parse(readFileSync(path, "utf-8"));
				} catch {
					throw new Error(
						`${path} is not valid JSON. Fix it first; overwriting it would delete settings you wrote by hand.`,
					);
				}
			}

			const settings = readSettings(path);
			const command = hookCommandFor(root);

			// Idempotent means converging on the command we would write now, not
			// leaving whatever is there. Returning early on any hook of ours meant an
			// upgrade that changed how the hook is started never took effect: the
			// machine kept running the old command forever, and the only symptom was
			// enforcement quietly not happening.
			if (replaceOurHookIn(settings, spec.event, command)) {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${JSON.stringify(settings, null, 2)}
`, "utf-8");
				return { host: this.name, settingsPath: path, installed: true };
			}

			settings.hooks = settings.hooks ?? {};
			settings.hooks[spec.event] = settings.hooks[spec.event] ?? [];
			settings.hooks[spec.event].push({
				hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
			});

			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
			return { host: this.name, settingsPath: path, installed: true };
		},

		uninstall(root: string): AdapterStatus {
			const path = this.settingsPath(root);
			const settings = readSettings(path);
			const groups = settings.hooks?.[spec.event];
			if (!groups) return { host: this.name, settingsPath: path, installed: false };

			const kept = groups
				.map((group) => ({
					...group,
					hooks: (group.hooks ?? []).filter((hook) => !isOurHook(hook.command)),
				}))
				.filter((group) => (group.hooks ?? []).length > 0);

			if (kept.length > 0) {
				settings.hooks![spec.event] = kept;
			} else {
				delete settings.hooks![spec.event];
				if (Object.keys(settings.hooks ?? {}).length === 0) delete settings.hooks;
			}

			writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
			return { host: this.name, settingsPath: path, installed: false };
		},

		status(root: string): AdapterStatus {
			const path = this.settingsPath(root);
			return {
				host: this.name,
				settingsPath: path,
				installed: hasOurHookIn(readSettings(path), spec.event),
			};
		},
	};
}

/**
 * Claude Code: `.claude/settings.json`, event `PreToolUse`.
 *
 * The matcher is deliberately absent, which the host reads as every tool. A
 * matcher listing tool names would be a list to keep in sync with a host that
 * adds tools, and the one it forgot would be the one that runs unchecked.
 */
export const claudeCodeAdapter: HostAdapter = jsonHookAdapter({
	name: "claude-code",
	settingsPath: (root) => join(root, ".claude", "settings.json"),
	event: "PreToolUse",
	// Print mode with a machine-readable stream. --verbose is required alongside
	// stream-json: without it the host prints only the final result, and the room
	// would show a job that started, went silent, and finished.
	launch: { bin: "claude", streamArgs: ["-p", "--output-format", "stream-json", "--verbose"] },
	// Measured: the hook binary refuses a call before it runs, and end to end
	// through a real socket in the contract test. The cost is held by
	// `workspace-gate-regression.test.ts` rather than by this comment, which is the
	// point of moving it there: it said p95 0.0011 ms and the measurement on
	// 2026-08-30 was 0.021, twenty times off, because nothing re-ran it.
	assurance: "verified",
});

/**
 * Codex: `.codex/hooks.json`, event `PreToolUse`.
 *
 * A separate file rather than a section of a shared settings file, which is how Codex reads
 * hooks and is already how `personaxis hooks` installs the Stop hook for it. The group
 * shape is identical to Claude Code's, so the same adapter serves both.
 *
 * ASSURANCE IS `documented`, DELIBERATELY. Codex's per-turn Stop hook is exercised by this
 * project; its pre-tool-call event is written here from the host's documentation and has
 * not been watched firing. That gap matters more than most: an operator who believes calls
 * are being refused while nothing intercepts them is worse off than one who knows there is
 * no hook, so `connect` and `status` say so rather than reporting a uniform green.
 */
export const codexAdapter: HostAdapter = jsonHookAdapter({
	name: "codex",
	settingsPath: (root) => join(root, ".codex", "hooks.json"),
	event: "PreToolUse",
	// No streamArgs, deliberately. The flags that make Codex emit a machine-readable
	// stream have not been checked against the real binary here, and inventing them
	// starts an agent in a mode nobody intended, in a real directory, with real tools.
	// The runner refuses with that reason, which is worth more than a guess.
	launch: { bin: "codex" },
	assurance: "documented",
});

export const HOST_ADAPTERS: HostAdapter[] = [claudeCodeAdapter, codexAdapter];

/** What is wrong with an installed hook, or nothing. */
export type HookAilment =
	/** The command names a bare binary that only resolves after a global install. */
	| { readonly kind: "unrunnable"; readonly command: string }
	/** The address was written with backslashes, which a POSIX shell collapses. */
	| { readonly kind: "mangled_address"; readonly command: string };

export interface HookFinding {
	readonly host: HostAgentName;
	readonly settingsPath: string;
	readonly ailment: HookAilment;
}

/**
 * Whether the hook a host would run is one it can actually start.
 *
 * This exists because of a real day. A settings file written by an older version named
 * the bare binary, the CLI was updated, nobody re-ran the installer, and the host
 * reported `command not found` as a NON-BLOCKING failure on every single tool call. A
 * non-blocking failure means the call proceeds. So for as long as that sat there, the
 * operator saw a governed session and had an ungoverned one, and the only evidence was
 * a line of noise that looks like a warning.
 *
 * That is the worst state this code can be in, and it is worse than no hook at all: no
 * hook is honest about what it is not doing.
 *
 * The installer already converges an old entry to the current form, so the window is
 * exactly "between an update and the next `connect`". Nothing closed that window,
 * because nothing looked. This looks.
 *
 * It deliberately does NOT check whether a daemon is answering. A hook pointed at a
 * daemon that is down is fine: it fails closed and refuses the call, loudly, which is
 * the design. What this catches is the other thing entirely, a hook that cannot start
 * and therefore refuses nothing.
 */
export function hookHealth(root: string): HookFinding[] {
	const findings: HookFinding[] = [];

	for (const adapter of HOST_ADAPTERS) {
		const path = adapter.settingsPath(root);
		if (!existsSync(path)) continue;

		let settings: Settings;
		try {
			settings = JSON.parse(readFileSync(path, "utf-8")) as Settings;
		} catch {
			// An unreadable settings file is the host's problem to report, not ours:
			// claiming a hook is broken when we could not read the file would be
			// guessing, and a check that guesses is one nobody believes twice.
			continue;
		}

		for (const group of settings.hooks?.[adapter.preToolUseEvent] ?? []) {
			for (const hook of group.hooks ?? []) {
				const command = hook.command;
				if (!isOurHook(command) || !command) continue;

				// The bare name resolves only after a global install. Ours starts with a
				// quoted absolute path to this Node, so anything that does not is old.
				if (!command.startsWith('"')) {
					findings.push({ host: adapter.name, settingsPath: path, ailment: { kind: "unrunnable", command } });
					continue;
				}
				// A shell collapses a Windows pipe address before the hook sees it, so the
				// current form sends a token with no separators and rebuilds the address.
				if (command.includes("--socket") && command.includes("\\")) {
					findings.push({
						host: adapter.name,
						settingsPath: path,
						ailment: { kind: "mangled_address", command },
					});
				}
			}
		}
	}

	return findings;
}

/** One line a person can act on, per finding. */
export function describeAilment(finding: HookFinding): string {
	const where = `${finding.host} (${finding.settingsPath})`;
	switch (finding.ailment.kind) {
		case "unrunnable":
			return `${where}: the hook names a command the host cannot start, so every tool call has been proceeding ungated. Run \`personaxis connect\` to rewrite it, or delete the entry if this folder is not connected.`;
		case "mangled_address":
			return `${where}: the hook's socket address contains backslashes, which a shell collapses before the hook sees them. Run \`personaxis connect\` to rewrite it.`;
	}
}


export function adapterFor(name: HostAgentName): HostAdapter | undefined {
	return HOST_ADAPTERS.find((adapter) => adapter.name === name);
}

/**
 * How to start a host, or null when this build cannot start it.
 *
 * Null is a real answer and the runner reports it as a refusal with a reason. The two ways
 * to get it are an unknown host and one whose stream flags have not been checked against
 * the real binary, and both should stop a run rather than produce a guess.
 */
export function launchCommandFor(
	name: HostAgentName,
): { command: string; args: string[] } | null {
	const adapter = adapterFor(name);
	if (!adapter?.launch.streamArgs) return null;
	return { command: adapter.launch.bin, args: [...adapter.launch.streamArgs] };
}
