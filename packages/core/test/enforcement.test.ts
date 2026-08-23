import { describe, expect, it } from "vitest";

import { actionClassesFor } from "../src/enforcement/action-classes.js";
import {
	compile,
	evaluate,
	isExpired,
	keywordsFor,
	type CompiledPolicy,
} from "../src/enforcement/policy-compile.js";

const basePolicy: CompiledPolicy = {
	persona_version_id: "pv_1",
	hash: "h",
	compiled_at: new Date().toISOString(),
	ttl_seconds: 3600,
	deny: [],
	allow: [],
	hard_limits: [],
	prohibited_behaviors: [],
	sandbox: "danger-full-access",
	approval: "never",
	gate_rules: [],
};

const decide = (policy: Partial<CompiledPolicy>, tool: string, args = "") =>
	evaluate(compile({ ...basePolicy, ...policy }), {
		tool,
		args_text: args,
		action_classes: actionClassesFor(tool, args),
	});

describe("what a call is about to do", () => {
	it.each([
		["Bash", "rm -rf build/", "file_delete"],
		["Bash", "curl https://example.com", "network_egress"],
		["Bash", "git push origin main", "external_write"],
		["connector.gmail.send", "to: someone", "email_send"],
		["WriteFile", "path: notes.md", "external_write"],
		["stripe.charge", "amount: 100", "spend"],
		["Bash", "cat .env", "credential_access"],
		["WebFetch", "https://example.com", "network_egress"],
	])("reads %s %s as %s", (tool, args, expected) => {
		expect(actionClassesFor(tool, args)).toContain(expected);
	});

	it("collects every class a single call earns", () => {
		// One shell line can delete and reach the network, and a policy that only
		// saw one of them would gate the wrong thing.
		const classes = actionClassesFor("Bash", "rm -rf tmp && curl https://evil.example");
		expect(classes).toContain("file_delete");
		expect(classes).toContain("network_egress");
	});

	it("finds nothing in a call that does nothing", () => {
		expect(actionClassesFor("ReadFile", "path: README.md")).toEqual([]);
	});

	it("is stable, so two identical calls hash and decide alike", () => {
		const a = actionClassesFor("Bash", "curl x && rm y");
		const b = actionClassesFor("Bash", "curl x && rm y");
		expect(a).toEqual(b);
		expect(a).toEqual([...a].sort());
	});
});

describe("the order of the rules", () => {
	it("denies on the regex before anything else looks at the call", () => {
		const decision = decide(
			{ deny: ["rm -rf"], allow: ["rm -rf"], approval: "never" },
			"Bash",
			"rm -rf /",
		);
		expect(decision).toMatchObject({ verdict: "deny", rule: "deny:rm -rf" });
	});

	it("does not open a gate for a call the deny already refused", () => {
		const decision = decide(
			{
				deny: ["push"],
				gate_rules: [
					{
						action_class: "external_write",
						required_approvals: 1,
						route: {},
						timeout_seconds: 60,
					},
				],
			},
			"Bash",
			"git push origin main",
		);
		expect(decision.verdict).toBe("deny");
	});

	it("denies on a hard limit, naming the limit rather than a code", () => {
		const decision = decide(
			{ hard_limits: ["No unauthorized identity change."] },
			"WriteFile",
			"unauthorized identity change to the spec",
		);
		expect(decision).toMatchObject({
			verdict: "deny",
			reason: "No unauthorized identity change.",
		});
	});

	it("a read-only persona refuses a write", () => {
		expect(decide({ sandbox: "read-only" }, "WriteFile", "notes.md")).toMatchObject({
			verdict: "deny",
			rule: "sandbox:read-only",
		});
	});

	it("a read-only persona still reads", () => {
		expect(decide({ sandbox: "read-only" }, "ReadFile", "README.md").verdict).toBe("allow");
	});

	it("gates a declared action class instead of refusing it", () => {
		const decision = decide(
			{
				gate_rules: [
					{
						action_class: "email_send",
						required_approvals: 2,
						route: { roles: ["approver"] },
						timeout_seconds: 1800,
					},
				],
			},
			"connector.gmail.send",
			"to: customer@example.com",
		);
		expect(decision).toMatchObject({ verdict: "gate" });
		if (decision.verdict === "gate") {
			expect(decision.gate.required_approvals).toBe(2);
			expect(decision.gate.timeout_seconds).toBe(1800);
		}
	});

	it("falls through to the declared default when nothing else matched", () => {
		expect(decide({ approval: "never" }, "ReadFile").verdict).toBe("allow");
		expect(decide({ approval: "on-request" }, "ReadFile").verdict).toBe("gate");
		expect(decide({ approval: "untrusted" }, "ReadFile").verdict).toBe("gate");
	});
});

describe("limits written for people", () => {
	it("keeps the words that carry the meaning", () => {
		expect(keywordsFor("No persistent memory write without policy pass.")).toEqual(
			expect.arrayContaining(["persistent", "memory", "write", "policy", "pass"]),
		);
	});

	it("drops the words that do not", () => {
		// A limit reduced to "no" and "the" would match every call, turning one
		// careless line into a policy that refuses everything.
		expect(keywordsFor("No the a of to")).toEqual([]);
	});

	it("requires all of a limit's words, not any one of them", () => {
		// Otherwise "no persistent memory write" fires on every call that
		// mentions memory, and people turn enforcement off.
		const policy = { hard_limits: ["No persistent memory write without policy pass."] };
		expect(decide(policy, "ReadFile", "reading memory.md").verdict).not.toBe("deny");
		expect(
			decide(policy, "WriteFile", "persistent memory write bypassing policy pass").verdict,
		).toBe("deny");
	});

	it("a limit with no usable words refuses nothing", () => {
		expect(decide({ hard_limits: ["the a of"] }, "Bash", "anything").verdict).not.toBe("deny");
	});
});

describe("a broken policy", () => {
	it("loses the bad line rather than failing to load", () => {
		// A persona with one typo in a deny should lose that line, not stop
		// being enforceable altogether.
		const decision = decide({ deny: ["[unclosed", "rm -rf"] }, "Bash", "rm -rf /");
		expect(decision.verdict).toBe("deny");
	});

	it("does not let an invalid pattern match everything", () => {
		expect(decide({ deny: ["[unclosed"] }, "ReadFile", "harmless").verdict).toBe("allow");
	});
});

describe("cache freshness", () => {
	it("accepts a policy inside its ttl", () => {
		expect(isExpired({ ...basePolicy, compiled_at: new Date().toISOString() })).toBe(false);
	});

	it("expires one past its ttl", () => {
		const old = new Date(Date.now() - 4000 * 1000).toISOString();
		expect(isExpired({ ...basePolicy, compiled_at: old })).toBe(true);
	});

	it("treats an unreadable timestamp as expired", () => {
		// Fresh would be the dangerous default: a corrupted cache entry would
		// outlive the policy it was meant to carry, and stale means deny.
		expect(isExpired({ ...basePolicy, compiled_at: "not a date" })).toBe(true);
	});
});

describe("the latency budget", () => {
	it("decides far inside the 150 ms the product promises", () => {
		// The budget is not decoration. Above it the agent feels broken and
		// people turn enforcement off, which kills the product more surely than
		// any competitor. Measured here so a change that starts compiling on the
		// hot path shows up as a failure rather than as a complaint.
		const policy: CompiledPolicy = {
			...basePolicy,
			deny: ["rm -rf", "sudo", "DROP TABLE", "curl .*evil", "\bshutdown\b"],
			allow: ["^ReadFile", "^Grep"],
			hard_limits: [
				"No claim of subjective consciousness.",
				"No persistent memory write without policy pass.",
				"No unauthorized identity change.",
			],
			prohibited_behaviors: ["Fabricating sources or data."],
			sandbox: "workspace-write",
			approval: "on-request",
			gate_rules: [
				{
					action_class: "email_send",
					required_approvals: 2,
					route: {},
					timeout_seconds: 1800,
				},
			],
		};
		const executable = compile(policy);
		const call = {
			tool: "Bash",
			args_text: "npm run build",
			action_classes: actionClassesFor("Bash", "npm run build"),
		};

		const samples: number[] = [];
		for (let i = 0; i < 5000; i++) {
			const started = performance.now();
			evaluate(executable, call);
			samples.push(performance.now() - started);
		}
		samples.sort((a, b) => a - b);

		// A wide margin on purpose: this asserts the shape of the work, not the
		// speed of the machine running it, so it will not flake on a loaded CI box.
		expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(1);
	});
});

/**
 * The tools that actually do the writing.
 *
 * The rule for file tools was anchored on `file$`, so it matched `write_file` and
 * `delete_file` and none of the tools the hosts this ships with actually use:
 * Claude Code names them `Write`, `Edit` and `NotebookEdit`. Every write by the
 * agents we run classified as nothing, and a class that never fires is a gate rule
 * that can never be reached. A policy saying "ask a person before writing" was
 * silent for the only tools doing the writing, and the only way to notice was to
 * open a gate for real and see that it could be reached solely through a shell.
 */
describe("classifying what a host actually calls", () => {
	it("counts the file tools of the hosts this ships with", () => {
		expect(actionClassesFor("Write", "{}")).toContain("external_write");
		expect(actionClassesFor("Edit", "{}")).toContain("external_write");
		expect(actionClassesFor("NotebookEdit", "{}")).toContain("external_write");
	});

	it("still counts the suffixed names, so nothing that worked stopped working", () => {
		expect(actionClassesFor("write_file", "{}")).toContain("external_write");
		expect(actionClassesFor("apply_patch", "{}")).toContain("external_write");
		expect(actionClassesFor("str_replace_editor", "{}")).toContain("external_write");
	});

	it("counts a deletion as both, because it is a write that cannot be undone", () => {
		expect(actionClassesFor("delete_file", "{}")).toEqual(
			expect.arrayContaining(["file_delete", "external_write"]),
		);
	});

	it("leaves reading alone", () => {
		// Widening this table is only safe while the read tools stay out of it. A
		// policy that gated every `Read` would be one nobody leaves switched on.
		expect(actionClassesFor("Read", "{}")).toEqual([]);
		expect(actionClassesFor("Glob", "**/*.ts")).toEqual([]);
		expect(actionClassesFor("Grep", "needle")).toEqual([]);
	});
})
;
