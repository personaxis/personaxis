// J.2b: asking for a tool that is not in the subset.
//
// The failure this prevents does not look like a failure. A model that needs `send_email`
// and only has `run_command` does not say "I cannot do this"; it writes a shell command that
// almost works, and the run looks like a capable agent making a bad choice.
//
// The failures these tests DO have to catch are the ones that undo the narrowing: a search
// that grants, and a model that rebuilds the whole catalog one query at a time.

import { describe, expect, it } from "vitest";

import { describeMatches, expandActive, findTools } from "../src/tools/find-tools.js";
import type { ToolSpec } from "../src/tools/registry.js";

function tool(name: string, category: string, description: string): ToolSpec {
	return {
		name,
		category: category as ToolSpec["category"],
		description,
		parameters: {},
		isReadOnly: true,
		isConcurrencySafe: true,
		gate: () => ({ decision: "allow", reason: "" }),
		execute: async () => "",
	};
}

const CATALOG: ToolSpec[] = [
	tool("run_command", "shell", "Run a shell command in the workspace."),
	tool("read_file", "file", "Read a file from the workspace."),
	tool("send_email", "network", "Send an email to a recipient."),
	tool("send_slack_message", "network", "Post a message to a Slack channel."),
	tool("search_web", "network", "Search the web and return results."),
	tool("remember", "memory", "Write something to the persona's memory."),
];

const ACTIVE = [CATALOG[0], CATALOG[1]];

describe("searching", () => {
	it("finds a tool by its name before one that only mentions it", () => {
		// A description mentioning "email" is much weaker evidence than a name that IS
		// `send_email`, and a boolean filter orders them by whatever the registry returned.
		const matches = findTools("send an email", CATALOG, ACTIVE);
		expect(matches[0].name).toBe("send_email");
	});

	it("finds by category too", () => {
		const names = findTools("network", CATALOG, ACTIVE).map((m) => m.name);
		expect(names).toContain("send_email");
		expect(names).toContain("search_web");
	});

	it("marks what the model already has", () => {
		// Otherwise a model asks for a tool it is holding, gets it "added", and learns
		// nothing about why its earlier attempt failed.
		const matches = findTools("run a command", CATALOG, ACTIVE);
		expect(matches.find((m) => m.name === "run_command")?.active).toBe(true);
	});

	it("returns nothing rather than the closest thing", () => {
		// Returning a near-miss is how a model ends up using `run_command` because it asked
		// for something that does not exist.
		expect(findTools("mint an nft", CATALOG, ACTIVE)).toEqual([]);
	});

	it("ignores words too short to mean anything", () => {
		// Without this, "to" and "an" match half the catalog by substring and the ranking
		// becomes noise.
		expect(findTools("to an of", CATALOG, ACTIVE)).toEqual([]);
	});

	it("returns nothing for an empty query instead of the whole catalog", () => {
		// A model calling this with no argument must not be handed everything: that is
		// exactly the tool-overload the subsetting exists to prevent.
		expect(findTools("", CATALOG, ACTIVE)).toEqual([]);
		expect(findTools("   ", CATALOG, ACTIVE)).toEqual([]);
	});

	it("caps how many it returns", () => {
		const many = Array.from({ length: 50 }, (_, i) => tool(`email_tool_${i}`, "network", "email"));
		expect(findTools("email", many, []).length).toBeLessThanOrEqual(10);
	});

	it("is deterministic when scores tie", () => {
		// A trace that shows different results for the same query is a trace nobody can use
		// to reproduce what the model saw.
		const a = findTools("send", CATALOG, ACTIVE).map((m) => m.name);
		const b = findTools("send", CATALOG, ACTIVE).map((m) => m.name);
		expect(a).toEqual(b);
	});
});

describe("what the model is told", () => {
	it("says plainly when nothing matches, and says not to substitute", () => {
		const said = describeMatches("mint an nft", []);
		expect(said).toContain("No tool matches");
		expect(said).toContain("rather than substituting");
	});

	it("lists names, categories and descriptions", () => {
		const said = describeMatches("email", findTools("email", CATALOG, ACTIVE));
		expect(said).toContain("send_email");
		expect(said).toContain("network");
		expect(said).toContain("Send an email");
	});

	it("says a found tool's own limits still apply", () => {
		// Searching is not granting. A model told it "has" a tool now might reasonably
		// assume the tool will run; its gate still decides.
		const said = describeMatches("email", findTools("email", CATALOG, ACTIVE));
		expect(said).toContain("Their own limits still apply");
	});
});

describe("expanding the subset", () => {
	it("adds what was found and keeps what was there", () => {
		const matches = findTools("send an email", CATALOG, ACTIVE);
		const next = expandActive(ACTIVE, CATALOG, matches);

		expect(next.map((t) => t.name)).toContain("send_email");
		expect(next.map((t) => t.name)).toContain("run_command");
	});

	it("does not duplicate a tool already active", () => {
		const matches = findTools("run a command", CATALOG, ACTIVE);
		const next = expandActive(ACTIVE, CATALOG, matches);

		expect(next.filter((t) => t.name === "run_command")).toHaveLength(1);
	});

	it("stops at a ceiling, so repeated searches cannot rebuild the catalog", () => {
		// The quiet way the narrowing gets undone: a model searches ten times over a long
		// run and ends up with everything, one query at a time, with nothing to show for it
		// in any single step.
		const many = Array.from({ length: 100 }, (_, i) => tool(`net_${i}`, "network", "network thing"));
		const matches = findTools("network", many, []);

		expect(expandActive([], many, matches, 5).length).toBeLessThanOrEqual(5);
	});

	it("ignores a match naming a tool that is not in the catalog", () => {
		// The match list is data; a caller could hand back one it did not get from here, and
		// inventing a ToolSpec for a name would be the loop granting itself a capability.
		const next = expandActive(ACTIVE, CATALOG, [
			{ name: "definitely_not_real", category: "shell", description: "", active: false },
		]);

		expect(next.map((t) => t.name)).toEqual(ACTIVE.map((t) => t.name));
	});

	it("does not mutate the array it was given", () => {
		const before = [...ACTIVE];
		expandActive(ACTIVE, CATALOG, findTools("email", CATALOG, ACTIVE));
		expect(ACTIVE).toEqual(before);
	});
});
