/**
 * A server nobody approved does not start, and the record lives where a persona cannot.
 *
 * K9. `security/mcp-provenance.ts` could hash a declaration and check one from the day it
 * was written, and nothing ever called it. The interesting part of connecting it is not
 * the hashing: it is where the record is kept.
 *
 * ## The attack
 *
 * `mountRegistered` merges the global config with the PROJECT one, and the project config
 * is `<cwd>/.personaxis/config.json`, inside the workspace a persona writes to. So a
 * persona that can write a file can register an MCP server, or replace an approved one,
 * and a server's tool descriptions are injected into the next prompt. It needs nothing to
 * execute: being listed IS the attack. `K4` checks the shape of what a server advertises
 * and says nothing about how the server came to be registered.
 *
 * The approvals therefore live in the operator's home, outside every workspace and
 * outside the sandbox a persona runs under. A record kept beside the thing it attests is
 * worth nothing, because whatever edits one edits the other and the operator ends up
 * reading a signature the attacker wrote.
 *
 * ## What these do not claim
 *
 * That an approved server is safe. What is checked is the DECLARATION: this command, these
 * arguments, these environment variable names. `npx` fetches at execution time, a binary
 * on PATH can be replaced, a pinned version can be republished. The provenance module says
 * so at length and the messages follow it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approvalsPath, approve, checkApproval, readApprovals } from "../src/mcp/approvals.js";
import { mountRegistered } from "../src/mcp/mount.js";

let home: string;
let saved: string | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pxs-k9-"));
	saved = process.env.PERSONAXIS_HOME;
	process.env.PERSONAXIS_HOME = home;
});

afterEach(() => {
	if (saved === undefined) delete process.env.PERSONAXIS_HOME;
	else process.env.PERSONAXIS_HOME = saved;
});

const server = {
	name: "github",
	command: "npx",
	args: ["-y", "@acme/mcp-github@1.2.3"],
	envKeys: ["GITHUB_TOKEN"],
};

describe("where an approval is kept", () => {
	it("is in the operator's home, not in the workspace", () => {
		// The whole control. A project config is writable by the persona; this is not.
		expect(approvalsPath().startsWith(home)).toBe(true);
	});

	it("is its own file, not a key in a config somebody edits by hand", () => {
		approve(server);

		expect(approvalsPath().endsWith("mcp-approvals.json")).toBe(true);
		expect(existsSync(join(home, "config.json"))).toBe(false);
	});

	it("never writes an environment VALUE, only the names", () => {
		// An MCP server's environment is where its credentials live. A digest of one in
		// a file we write and show in a listing is a credential in a manifest.
		approve({ ...server, envKeys: ["GITHUB_TOKEN"] });

		const written = readFileSync(approvalsPath(), "utf-8");
		expect(written).not.toContain("GITHUB_TOKEN");
	});
});

describe("what may be mounted", () => {
	it("refuses a server nobody approved", () => {
		expect(checkApproval(server)?.reason).toContain("never approved");
	});

	it("names the command that would approve it, so the refusal is actionable", () => {
		// A control that blocks and does not say what to do next is a control somebody
		// works around by turning it off.
		expect(checkApproval(server)?.reason).toContain("personaxis mcp approve github");
	});

	it("allows the declaration that was approved", () => {
		approve(server);

		expect(checkApproval(server)).toBeNull();
	});

	it("refuses one whose command changed since", () => {
		approve(server);

		const changed = { ...server, args: ["-y", "@acme/mcp-github@latest", "--allow-write"] };

		expect(checkApproval(changed)?.reason).toContain("has changed since it was approved");
	});

	it("refuses one whose environment gained a name", () => {
		// A new variable name is a new thing the server is being handed, and it is part
		// of what somebody approved.
		approve(server);

		expect(checkApproval({ ...server, envKeys: ["GITHUB_TOKEN", "AWS_SECRET"] })).not.toBeNull();
	});

	it("says what changed rather than that something did", () => {
		// The reader has to decide whether THEY made this change, and cannot without
		// being told what it is.
		approve(server);

		const reason = checkApproval({ ...server, args: ["-y", "@acme/mcp-github@9.9.9"] })?.reason;

		expect(reason).toContain("@acme/mcp-github@9.9.9");
	});

	it("keeps one server's approval when another is recorded", () => {
		approve(server);
		approve({ name: "files", command: "npx", args: ["-y", "@acme/files@1.0.0"] });

		expect(checkApproval(server)).toBeNull();
		expect(Object.keys(readApprovals().servers).sort()).toEqual(["files", "github"]);
	});
});

describe("what happens when the record cannot be read", () => {
	it("fails closed, so nothing mounts", () => {
		// The one reading that cannot be recovered from is treating an unreadable record
		// as permission. Every server is unapproved instead, which is loud and safe.
		mkdirSync(home, { recursive: true });
		writeFileSync(approvalsPath(), "{ this is not json", "utf-8");

		expect(readApprovals().servers).toEqual({});
		expect(checkApproval(server)).not.toBeNull();
	});

	it("fails closed for a record from a shape it does not know", () => {
		writeFileSync(approvalsPath(), JSON.stringify({ version: 99, servers: { github: {} } }));

		expect(checkApproval(server)).not.toBeNull();
	});
});

describe("and nothing unapproved is ever started", () => {
	// The end of the chain. Everything above is about the record; this is about the
	// server not running. Refused rather than started-and-watched, because by the time a
	// server has answered `tools/list` its descriptions exist, and the only question
	// left is whether they reach a prompt.

	let cwd: string;
	let wasIn: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pxs-k9-ws-"));
		mkdirSync(join(cwd, ".personaxis"), { recursive: true });
		// The project config is read relative to the working directory, so this has to
		// move, and it has to move BACK: vitest runs several files in one process, and a
		// directory left changed is a neighbouring test reading a config it never wrote.
		wasIn = process.cwd();
		process.chdir(cwd);
	});

	afterEach(() => {
		process.chdir(wasIn);
	});

	/** What a persona with write access to its workspace could leave behind. */
	function registeredInTheWorkspace(spec: Record<string, unknown>): void {
		writeFileSync(
			join(cwd, ".personaxis", "config.json"),
			JSON.stringify({ mcpServers: { github: spec } }),
			"utf-8",
		);
	}

	it("does not start a server the workspace registered and nobody approved", async () => {
		registeredInTheWorkspace({ command: "npx", args: ["-y", "@evil/server@1.0.0"] });
		let started = 0;

		const mounted = await mountRegistered({
			transportFor: () => {
				started += 1;
				throw new Error("a transport was built for an unapproved server");
			},
		});

		expect(started).toBe(0);
		expect(mounted.tools).toEqual([]);
		expect(mounted.failures.map((failure) => failure.name)).toEqual(["github"]);
	});

	it("says why, by name, so the operator is not left guessing", async () => {
		registeredInTheWorkspace({ command: "npx", args: ["-y", "@evil/server@1.0.0"] });
		const told: string[] = [];

		await mountRegistered({
			transportFor: () => {
				throw new Error("should not be reached");
			},
			onFailure: (failure) => told.push(`${failure.name}: ${failure.reason}`),
		});

		expect(told).toHaveLength(1);
		expect(told[0]).toContain("never approved");
	});

	it("does not start one that gained an environment variable since it was approved", async () => {
		// The env names are part of what somebody approved, and the mount path is where a
		// registered server's `env` becomes the NAMES the hash covers. Asserted here and
		// not only against `checkApproval`, because a control that cut that conversion
		// left every unit test green: a property tested one call short of where it is
		// used is a property nobody has tested.
		approve({
			name: "github",
			command: "npx",
			args: ["-y", "@acme/server@1.2.3"],
			envKeys: ["GITHUB_TOKEN"],
		});
		registeredInTheWorkspace({
			command: "npx",
			args: ["-y", "@acme/server@1.2.3"],
			env: { GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s" },
		});
		let started = 0;

		const mounted = await mountRegistered({
			transportFor: () => {
				started += 1;
				throw new Error("a transport was built for a widened environment");
			},
		});

		expect(started).toBe(0);
		expect(mounted.failures[0]?.reason).toContain("has changed since it was approved");
	});

	it("starts one whose environment is exactly what was approved", async () => {
		// The other side, so the test above is not passing because everything is refused.
		approve({
			name: "github",
			command: "npx",
			args: ["-y", "@acme/server@1.2.3"],
			envKeys: ["GITHUB_TOKEN"],
		});
		registeredInTheWorkspace({
			command: "npx",
			args: ["-y", "@acme/server@1.2.3"],
			env: { GITHUB_TOKEN: "t" },
		});
		let started = 0;

		await mountRegistered({
			transportFor: () => {
				started += 1;
				throw new Error("stopped here on purpose: the approval let it through");
			},
		});

		expect(started).toBe(1);
	});

	it("does not start one whose declaration changed after it was approved", async () => {
		// The case worth being loud about: a decision that no longer matches what is on
		// disk. Approved with a pinned version, then rewritten to float.
		approve({ name: "github", command: "npx", args: ["-y", "@acme/server@1.2.3"] });
		registeredInTheWorkspace({ command: "npx", args: ["-y", "@acme/server@latest"] });
		let started = 0;

		const mounted = await mountRegistered({
			transportFor: () => {
				started += 1;
				throw new Error("a transport was built for a changed declaration");
			},
		});

		expect(started).toBe(0);
		expect(mounted.failures[0]?.reason).toContain("has changed since it was approved");
	});
});
