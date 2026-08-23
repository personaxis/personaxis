/**
 * D4: the contract every host adapter meets, run against every adapter there is.
 *
 * The point of the item is not that Codex works. It is that the daemon and the enforcement
 * path learn nothing new when a second host arrives. A test written against one adapter and
 * then copied for the next proves the opposite: it lets the two drift, and the one that
 * drifts is whichever host fewer people run.
 *
 * So the properties below are stated once and executed over `HOST_ADAPTERS`. A third
 * adapter inherits the whole verification by being added to that array, and an adapter that
 * quietly does something different fails here rather than in somebody's project.
 *
 * What these do NOT prove is that a given host actually runs the hook. Nothing in a settings
 * file can. That is what `assurance` is for, and there is a test below that it is told
 * truthfully rather than set to the reassuring value.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
	describeAssurance,
	isOurHook,
	HOST_ADAPTERS,
	adapterFor,
	claudeCodeAdapter,
	codexAdapter,
	type HostAdapter,
} from "../src/workspace/host-adapter.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pxs-adapter-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function settingsOf(adapter: HostAdapter): Record<string, any> {
	return JSON.parse(readFileSync(adapter.settingsPath(root), "utf-8"));
}

function groupsOf(adapter: HostAdapter): any[] {
	return settingsOf(adapter).hooks[adapter.preToolUseEvent];
}

describe.each(HOST_ADAPTERS)("$name meets the adapter contract", (adapter) => {
	it("writes its settings inside the project it was given", () => {
		// A hook path escaping the root would configure a host outside the directory the
		// operator consented to, which is the whole boundary `connect` is built on.
		const path = adapter.settingsPath(root);
		expect(path.startsWith(root)).toBe(true);
	});

	it("installs a hook with no matcher, so it covers every tool", () => {
		// A matcher listing tool names is a list to keep in sync with a host that keeps
		// adding them, and the one it forgot is the one that runs unchecked.
		adapter.install(root);
		const groups = groupsOf(adapter);

		expect(groups).toHaveLength(1);
		expect(groups[0].matcher).toBeUndefined();
		// Recognition rather than the literal name: the command names an absolute
		// script when there is no global install, and that is still ours.
		expect(isOurHook(groups[0].hooks[0].command)).toBe(true);
	});

	it("gives the hook longer than a person takes to answer a gate", () => {
		// The default timeouts hosts ship are tuned for a script, and a gate is a human
		// deciding. Too short and the host kills the hook, which fails open on some hosts.
		adapter.install(root);
		expect(groupsOf(adapter)[0].hooks[0].timeout).toBeGreaterThan(600);
	});

	it("writes the socket of THIS root into the command", () => {
		// Derived at hook time instead, a settings file copied into another repository
		// would reach whichever daemon happened to be listening. Failing to reach one is
		// the safe outcome; reaching the wrong one is not.
		adapter.install(root);
		const command = groupsOf(adapter)[0].hooks[0].command;

		const other = mkdtempSync(join(tmpdir(), "pxs-other-"));
		try {
			adapter.install(other);
			const theirs = JSON.parse(readFileSync(adapter.settingsPath(other), "utf-8")).hooks[
				adapter.preToolUseEvent
			][0].hooks[0].command;
			expect(theirs).not.toBe(command);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("is idempotent", () => {
		adapter.install(root);
		adapter.install(root);
		expect(groupsOf(adapter)).toHaveLength(1);
	});

	it("leaves a project's own hooks alone, and takes only ours back out", () => {
		const path = adapter.settingsPath(root);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					[adapter.preToolUseEvent]: [
						{ matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }] },
					],
				},
				model: "opus",
			}),
		);

		adapter.install(root);
		expect(groupsOf(adapter)).toHaveLength(2);

		adapter.uninstall(root);
		const after = settingsOf(adapter);
		expect(after.hooks[adapter.preToolUseEvent]).toHaveLength(1);
		expect(after.hooks[adapter.preToolUseEvent][0].hooks[0].command).toBe("./mine.sh");
		// Adopting this must not cost somebody the rest of their configuration.
		expect(after.model).toBe("opus");
	});

	it("leaves no empty scaffolding behind when it uninstalls the only hook", () => {
		adapter.install(root);
		adapter.uninstall(root);

		const after = settingsOf(adapter);
		expect(after.hooks?.[adapter.preToolUseEvent]).toBeUndefined();
		expect(after.hooks).toBeUndefined();
	});

	it("refuses to overwrite settings it could not parse", () => {
		// Rewriting a file we failed to read would delete configuration someone wrote by
		// hand, and they would find out the next time they needed it.
		const path = adapter.settingsPath(root);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ not json");

		expect(() => adapter.install(root)).toThrow(/not valid JSON/);
		expect(readFileSync(path, "utf-8")).toBe("{ not json");
	});

	it("reports status truthfully at every stage", () => {
		expect(adapter.status(root).installed).toBe(false);
		adapter.install(root);
		expect(adapter.status(root).installed).toBe(true);
		adapter.uninstall(root);
		expect(adapter.status(root).installed).toBe(false);
	});

	it("says not-installed for a project with no settings file rather than throwing", () => {
		// `status` runs on every project a machine exposed, including ones nobody has
		// configured. Throwing there would make the whole report fail on the first.
		expect(existsSync(adapter.settingsPath(root))).toBe(false);
		expect(() => adapter.status(root)).not.toThrow();
	});

	it("uninstalling something never installed is not an error", () => {
		expect(() => adapter.uninstall(root)).not.toThrow();
		expect(adapter.status(root).installed).toBe(false);
	});

	it("states how far its enforcement has actually been checked", () => {
		const said = describeAssurance(adapter);
		expect(["verified", "documented"]).toContain(adapter.assurance);

		if (adapter.assurance === "documented") {
			// The gap has to be named, not implied. An operator who believes calls are
			// being refused while nothing intercepts them is worse off than one who knows
			// there is no hook at all.
			expect(said).toContain("nobody here has watched it fire");
		} else {
			expect(said).toContain("observed end to end");
		}
	});
});

describe("the adapters are distinct hosts, not one host twice", () => {
	it("each has its own settings file", () => {
		const paths = new Set(HOST_ADAPTERS.map((a) => a.settingsPath(root)));
		expect(paths.size).toBe(HOST_ADAPTERS.length);
	});

	it("installing one does not install the other", () => {
		// They share an implementation; they must not share a file. A single write that
		// satisfied both would mean uninstalling from one silently disarms the other.
		claudeCodeAdapter.install(root);

		expect(claudeCodeAdapter.status(root).installed).toBe(true);
		expect(codexAdapter.status(root).installed).toBe(false);
	});

	it("both can be installed in the same project at once", () => {
		// Somebody running both agents against one repository is the normal case, not an
		// edge one, and each host has to be armed independently.
		claudeCodeAdapter.install(root);
		codexAdapter.install(root);

		expect(claudeCodeAdapter.status(root).installed).toBe(true);
		expect(codexAdapter.status(root).installed).toBe(true);
	});

	it("is reachable by name", () => {
		for (const adapter of HOST_ADAPTERS) {
			expect(adapterFor(adapter.name)).toBe(adapter);
		}
	});

	it("does not claim a host it has no adapter for", () => {
		// `openclaw` and `hermes` have per-turn hooks in this project and no pre-tool-call
		// adapter. Returning something here would arm nothing and report success.
		expect(adapterFor("openclaw" as never)).toBeUndefined();
	});
});
