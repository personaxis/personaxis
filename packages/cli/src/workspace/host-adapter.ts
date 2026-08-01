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

export interface HostAdapter {
	name: HostAgentName;
	/** Where this host reads project settings from, given a working directory. */
	settingsPath(root: string): string;
	install(root: string): AdapterStatus;
	uninstall(root: string): AdapterStatus;
	status(root: string): AdapterStatus;
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

function hasOurHook(settings: Settings, event: string): boolean {
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
 * Claude Code: `.claude/settings.json`, event `PreToolUse`.
 *
 * The matcher is deliberately absent, which the host reads as every tool. A
 * matcher listing tool names would be a list to keep in sync with a host that
 * adds tools, and the one it forgot would be the one that runs unchecked.
 */
export const claudeCodeAdapter: HostAdapter = {
	name: "claude-code",

	settingsPath(root: string): string {
		return join(root, ".claude", "settings.json");
	},

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
		if (hasOurHook(settings, "PreToolUse")) {
			return { host: this.name, settingsPath: path, installed: true };
		}

		settings.hooks = settings.hooks ?? {};
		settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];
		settings.hooks.PreToolUse.push({
			hooks: [{ type: "command", command: hookCommandFor(root), timeout: HOOK_TIMEOUT_SECONDS }],
		});

		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
		return { host: this.name, settingsPath: path, installed: true };
	},

	uninstall(root: string): AdapterStatus {
		const path = this.settingsPath(root);
		const settings = readSettings(path);
		const groups = settings.hooks?.PreToolUse;
		if (!groups) return { host: this.name, settingsPath: path, installed: false };

		const kept = groups
			.map((group) => ({
				...group,
				hooks: (group.hooks ?? []).filter((hook) => !hook.command?.includes(HOOK_MARKER)),
			}))
			.filter((group) => (group.hooks ?? []).length > 0);

		if (kept.length > 0) {
			settings.hooks!.PreToolUse = kept;
		} else {
			delete settings.hooks!.PreToolUse;
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
			installed: hasOurHook(readSettings(path), "PreToolUse"),
		};
	},
};

export const HOST_ADAPTERS: HostAdapter[] = [claudeCodeAdapter];

export function adapterFor(name: HostAgentName): HostAdapter | undefined {
	return HOST_ADAPTERS.find((adapter) => adapter.name === name);
}
