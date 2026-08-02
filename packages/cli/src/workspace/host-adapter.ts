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

import type { HostAgentName } from "@personaxis/protocol/workspace";

import { enforcementSocketPath } from "./enforcement-endpoint.js";

/** Recognises our hook among a project's others, across versions. */
export const HOOK_MARKER = "personaxis-hook";

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

export interface HostAdapter {
	name: HostAgentName;
	/** Where this host reads project settings from, given a working directory. */
	settingsPath(root: string): string;
	/** The host's name for the event that fires BEFORE a tool call runs. */
	preToolUseEvent: string;
	assurance: EnforcementAssurance;
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

function hasOurHookIn(settings: Settings, event: string): boolean {
	return (settings.hooks?.[event] ?? []).some((group) =>
		(group.hooks ?? []).some((hook) => hook.command?.includes(HOOK_MARKER)),
	);
}

/**
 * The command the host runs.
 *
 * The socket path is written in rather than derived at hook time, so a hook
 * that ends up in a copied repository fails to reach a daemon instead of
 * quietly reaching the wrong one.
 */
export function hookCommandFor(root: string): string {
	return `${HOOK_MARKER} --socket "${enforcementSocketPath(root)}"`;
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
}): HostAdapter {
	return {
		name: spec.name,
		preToolUseEvent: spec.event,
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
			if (hasOurHookIn(settings, spec.event)) {
				return { host: this.name, settingsPath: path, installed: true };
			}

			settings.hooks = settings.hooks ?? {};
			settings.hooks[spec.event] = settings.hooks[spec.event] ?? [];
			settings.hooks[spec.event].push({
				hooks: [{ type: "command", command: hookCommandFor(root), timeout: HOOK_TIMEOUT_SECONDS }],
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
					hooks: (group.hooks ?? []).filter((hook) => !hook.command?.includes(HOOK_MARKER)),
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
	// Measured: the hook binary refuses a call before it runs, p95 0.0011 ms over 20k
	// decisions, and end to end through a real socket in the contract test.
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
	assurance: "documented",
});

export const HOST_ADAPTERS: HostAdapter[] = [claudeCodeAdapter, codexAdapter];

export function adapterFor(name: HostAgentName): HostAdapter | undefined {
	return HOST_ADAPTERS.find((adapter) => adapter.name === name);
}
