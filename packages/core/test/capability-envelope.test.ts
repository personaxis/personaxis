/**
 * A capability says what it can DO, not only what it needs permission for.
 *
 * K6, and the row calls it the advantage no protocol can express. The measurement is
 * what makes that concrete rather than a slogan.
 *
 * Action classes were INFERRED, by a regex table over the tool's name and its argument
 * text. That table knows the six built-ins because they were written together. It has
 * never seen a plugin, and it never will. Measured before any of this was written:
 *
 *     run_command "rm -rf /"        ["file_delete"]
 *     write_file  "a.txt"           ["external_write"]
 *     github:create_issue {...}     []            <- a remote write, weighed as nothing
 *     tools:search "hello"          []
 *
 * So a permission answers "may this persona use it" and nothing answered "and what will
 * that do", for exactly the capabilities where the question matters most.
 *
 * ## A declaration widens and never shrinks
 *
 * The declared envelope is unioned with whatever the runtime can still infer. This is
 * the one place where the subject of a measurement supplies its own input, so a
 * capability that could REPLACE the inference would be marking its own homework: it
 * would declare `[]` and disappear from the axis. What it can do is add the classes
 * nobody else could see.
 */

import { describe, expect, it } from "vitest";

import { actionClassesFor } from "../src/enforcement/action-classes.js";
import { mcpToolToSpec } from "../src/tools/mcp-adapter.js";
import { builtinManifest, mountBuiltins } from "../src/tools/mounted.js";
import { Kernel } from "../src/kernel/index.js";
import { readManifest } from "../src/kernel/manifest.js";
import { PersonaAgent } from "../src/agent.js";
import { EventBus } from "../src/events.js";
import { compile } from "../src/enforcement/policy-compile.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";
import type { ToolSpec } from "../src/tools/registry.js";

describe("what the inference table can and cannot see", () => {
	it("still classifies the built-ins it was written alongside", () => {
		expect(actionClassesFor("write_file", "a.txt")).toEqual(["external_write"]);
	});

	it("sees nothing at all in a plugin's remote write, which is the whole row", () => {
		// Not a hypothetical. This is what the table returns today for a tool that opens
		// an issue on somebody's repository.
		expect(actionClassesFor("github:create_issue", '{"title":"x"}')).toEqual([]);
	});
});

describe("a contribution has to say what it can do", () => {
	it("is refused when it does not", () => {
		const missing = {
			name: "acme.weather",
			version: "1.0.0",
			contributes: {
				tools: [
					{
						name: "weather",
						description: "looks the weather up",
						category: "net",
						isReadOnly: true,
						isConcurrencySafe: true,
					},
				],
			},
		};

		const read = readManifest(missing);

		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.faults.join("|")).toContain("envelope must be an array");
	});

	it("is refused when it names a class that does not exist", () => {
		// Refused rather than ignored. Ignoring turns a typo into silence on the very axis
		// the entry was written to raise, which is the failure this row is about.
		const typo = {
			name: "acme.weather",
			version: "1.0.0",
			contributes: {
				tools: [
					{
						name: "weather",
						description: "looks the weather up",
						category: "net",
						isReadOnly: true,
						isConcurrencySafe: true,
						envelope: ["netwrok_egress"],
					},
				],
			},
		};

		const read = readManifest(typo);

		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.faults.join("|")).toContain("is not an action class");
	});

	it("accepts an empty envelope, because a tool that does none of the six is real", () => {
		const readOnly = {
			name: "acme.weather",
			version: "1.0.0",
			contributes: {
				tools: [
					{
						name: "weather",
						description: "looks the weather up",
						category: "net",
						isReadOnly: true,
						isConcurrencySafe: true,
						envelope: [],
					},
				],
			},
		};

		expect(readManifest(readOnly).ok).toBe(true);
	});
});

describe("what the built-ins declare", () => {
	it("says a reader does nothing and a writer writes", () => {
		const tools = builtinManifest().contributes.tools ?? [];
		const envelopeOf = (name: string) => tools.find((tool) => tool.name === name)?.envelope;

		expect(envelopeOf("read_file")).toEqual([]);
		expect(envelopeOf("list_dir")).toEqual([]);
		expect(envelopeOf("write_file")).toEqual(["external_write"]);
	});

	it("carries the envelope on the tool the kernel actually contributes", () => {
		// Two places computed this and a negative control caught them drifting: breaking
		// the envelope on the contributed spec left the manifest, which read the table
		// directly, describing a tool that no longer carried one.
		const kernel = new Kernel();
		const bench = mountBuiltins(kernel, { answer: () => ({ granted: true }) });
		const offered = bench.tools.find((tool) => tool.name === "write_file");

		expect(offered?.envelope).toEqual(["external_write"]);
	});

	it("says a shell can do everything, which is the honest ugly answer", () => {
		// Not a failure of the declaration. It is the reason a persona that declares narrow
		// limits should not be handed a shell in the first place, said in a place a reader
		// can see rather than left to be discovered.
		const shell = (builtinManifest().contributes.tools ?? []).find(
			(tool) => tool.name === "run_command",
		);

		expect(shell?.envelope).toHaveLength(6);
	});
});

describe("what an MCP tool declares", () => {
	const descriptor = { name: "create_issue", description: "opens an issue" };
	const call = async () => "done";

	it("says it reaches the network, which the table could not see", () => {
		const spec = mcpToolToSpec("github", descriptor, call);

		expect(actionClassesFor(spec.name, "{}")).toEqual([]);
		expect(spec.envelope).toContain("network_egress");
	});

	it("says it writes outside the workspace unless the server called it read-only", () => {
		const writes = mcpToolToSpec("github", descriptor, call);
		const reads = mcpToolToSpec("github", { ...descriptor, annotations: { readOnlyHint: true } }, call);

		expect(writes.envelope).toEqual(["network_egress", "external_write"]);
		// A hint is the server talking about itself, so it may only ever remove the
		// stronger claim, never add permission to anything.
		expect(reads.envelope).toEqual(["network_egress"]);
	});
});

describe("what the gate is actually handed", () => {
	/** Runs one turn in which the model calls this tool once, and reports the verdict. */
	async function verdictFor(tool: ToolSpec): Promise<{ decision: string; reason: string }> {
		const bus = new EventBus();
		let seen = { decision: "none", reason: "" };
		bus.on((event) => {
			if (event.type === "tool-verdict") seen = { decision: event.decision, reason: event.reason };
		});

		const agent = new PersonaAgent({
			llm: {
				endpoint: "http://x/v1",
				model: "m",
				fetchImpl: (async (url: string) => {
					if (String(url).endsWith("/models")) {
						return { ok: true, status: 200, json: async () => ({ data: [] }) };
					}
					return {
						ok: true,
						status: 200,
						json: async () => ({
							choices: [
								{
									message: {
										content: "",
										tool_calls: [
											{ id: "c1", type: "function", function: { name: tool.name, arguments: "{}" } },
										],
									},
								},
							],
						}),
					};
				}) as unknown as typeof fetch,
			},
			policy: { ...DEFAULT_POLICY, workspaceRoot: process.cwd() },
			capability: readOnlyPersona(),
			personaBody: "You are a tester.",
			maxSteps: 1,
			tools: [tool],
			bus,
		});

		await agent.run("do it");
		return seen;
	}

	/** A persona that reads and does not write, which is the posture the envelope meets. */
	function readOnlyPersona() {
		return compile({
			persona_version_id: "pv_test",
			hash: "h",
			compiled_at: new Date().toISOString(),
			ttl_seconds: 3600,
			deny: [],
			allow: [],
			hard_limits: [],
			prohibited_behaviors: [],
			egress_allowlist: [],
			sandbox: "read-only",
			approval: "never",
			gate_rules: [],
		});
	}

	it("refuses a remote write that the table could not see, because the tool declared it", async () => {
		// The end of the chain, and the row in one assertion. This exact call infers to an
		// empty class list, so before the declaration the second axis had nothing to weigh
		// and a read-only persona would have made the write.
		const remote = mcpToolToSpec("github", { name: "create_issue" }, async () => "done");
		expect(actionClassesFor(remote.name, "{}")).toEqual([]);

		const verdict = await verdictFor(remote);

		expect(verdict.decision).toBe("deny");
		expect(verdict.reason).toContain("read-only");
	});

	it("still weighs what the runtime can infer, so a capability cannot classify itself down", async () => {
		// The property that makes a DECLARATION safe to accept from a stranger: it widens
		// and never shrinks. This tool declares it does nothing at all, and its name is one
		// the table does know, so the inference has to survive the declaration.
		const liar: ToolSpec = {
			name: "write_file",
			description: "swears it is harmless",
			category: "fs",
			isReadOnly: true,
			isConcurrencySafe: true,
			envelope: [],
			parameters: { type: "object", properties: {} },
			gate: () => ({
				decision: "allow",
				reason: "says so",
				class: {
					writesFiles: false,
					network: false,
					destructive: false,
					escapesWorkspace: false,
				},
			}),
			execute: async () => "written",
		};

		const verdict = await verdictFor(liar);

		expect(verdict.decision).toBe("deny");
	});

	it("lets a read-only capability through, so the envelope is doing the deciding", async () => {
		// The other side of the same measurement. Without it, the test above would pass
		// for a persona that refuses everything.
		const reader = mcpToolToSpec(
			"github",
			{ name: "read_issue", annotations: { readOnlyHint: true } },
			async () => "done",
		);

		const verdict = await verdictFor(reader);

		expect(verdict.decision).not.toBe("deny");
	});
});
