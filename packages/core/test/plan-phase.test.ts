// J.4c: thinking before acting, and what happens when the thought does not survive.
//
// Two quiet failures on either side of `assessPlan`, which was already tested and which
// nothing called. A parser that accepts anything turns a malformed plan into an EMPTY one,
// and an empty plan assesses perfectly clean: the operator is told their agent planned
// nothing dangerous. A rejection that does not say what was refused produces a second plan
// that differs at random, which is not thinking, it is retrying.

import { describe, expect, it } from "vitest";

import { decidePlan, describeBlocked, parsePlan } from "../src/plan-phase.js";
import type { ToolSpec } from "../src/tools/registry.js";
import type { Policy } from "../src/sandbox.js";

const CLEAN = { writesFiles: false, network: false, destructive: false, escapesWorkspace: false };

function tool(name: string, decision: "allow" | "ask" | "deny", reason = ""): ToolSpec {
	return {
		name,
		category: "shell",
		description: name,
		parameters: {},
		isReadOnly: decision === "allow",
		isConcurrencySafe: true,
		gate: () => ({ decision, reason, class: CLEAN }),
		execute: async () => "",
	};
}

const TOOLS = [
	tool("read_file", "allow"),
	tool("write_file", "ask", "writing needs approval"),
	tool("delete_everything", "deny", "a hard limit refuses this"),
];

const policy: Policy = {
	sandbox: "workspace-write",
	approval: "on-request",
	allow: [],
	deny: [],
	workspaceRoot: "/tmp",
};

describe("reading a plan out of what the model said", () => {
	it("reads a bare array", () => {
		const result = parsePlan('[{"tool":"read_file","args":{"path":"a.md"}}]');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.steps[0]).toMatchObject({ tool: "read_file" });
	});

	it("reads it out of a fence", () => {
		const result = parsePlan('```json\n[{"tool":"read_file","args":{}}]\n```');
		expect(result.ok).toBe(true);
	});

	it("reads it out of prose around it", () => {
		// A model asked for JSON returns JSON most of the time. Failing the run over the
		// remaining cases turns a formatting slip into a dead run.
		const result = parsePlan('Here is my plan:\n[{"tool":"read_file","args":{}}]\nLet me know.');
		expect(result.ok).toBe(true);
	});

	it("reads the `steps` wrapper some models produce", () => {
		const result = parsePlan('{"steps":[{"tool":"read_file","args":{}}]}');
		expect(result.ok).toBe(true);
	});

	it("treats an empty plan as an answer, not a parse failure", () => {
		// "Nothing to do" and "I could not read you" lead to opposite next moves.
		const result = parsePlan("[]");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.steps).toEqual([]);
	});

	it("refuses a step with no tool name rather than dropping it", () => {
		// Dropping it would produce a SHORTER plan that assesses clean, and the operator
		// would be told their agent planned something it did not.
		const result = parsePlan('[{"args":{"path":"a"}}]');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("step 1");
	});

	it("refuses args that are not an object", () => {
		const result = parsePlan('[{"tool":"read_file","args":"a.md"}]');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("args");
	});

	it("defaults missing args to empty rather than refusing", () => {
		// A tool with no required arguments is a legitimate step, and refusing it would
		// make the strictness above look arbitrary.
		const result = parsePlan('[{"tool":"read_file"}]');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.steps[0].args).toEqual({});
	});

	it("says what to send when it is not JSON at all", () => {
		const result = parsePlan("I will read the file and then decide.");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('"tool"');
	});

	it("does not throw on anything", () => {
		for (const junk of ["", "   ", "{", "[[[", "null", "true", '{"steps":"nope"}']) {
			expect(() => parsePlan(junk)).not.toThrow();
		}
	});
});

describe("deciding what to do with it", () => {
	it("proceeds on a plan whose steps are all allowed", () => {
		const outcome = decidePlan('[{"tool":"read_file","args":{}}]', TOOLS, policy);
		expect(outcome.kind).toBe("proceed");
	});

	it("proceeds on a plan with steps that will ASK, and marks them", () => {
		// `ask` means a person decides when the step runs. Refusing up front would make
		// every plan touching anything sensitive unrunnable, and people would stop planning.
		const outcome = decidePlan('[{"tool":"write_file","args":{}}]', TOOLS, policy);

		expect(outcome.kind).toBe("proceed");
		if (outcome.kind === "proceed") expect(outcome.anchor).toContain("will ask for approval");
	});

	it("rejects a plan containing a step that can never run", () => {
		const outcome = decidePlan('[{"tool":"delete_everything","args":{}}]', TOOLS, policy);
		expect(outcome.kind).toBe("rejected");
	});

	it("rejects a plan naming a tool that does not exist", () => {
		// Otherwise the run starts, gets to step three, and dies on a tool the model
		// invented, having already done the first two.
		const outcome = decidePlan('[{"tool":"summon_a_daemon","args":{}}]', TOOLS, policy);
		expect(outcome.kind).toBe("rejected");
	});

	it("tells the model which step, which tool and which rule", () => {
		// "Plan rejected" produces a second plan that differs at random. This produces one
		// that avoids the thing that was refused.
		const outcome = decidePlan(
			'[{"tool":"read_file","args":{}},{"tool":"delete_everything","args":{}}]',
			TOOLS,
			policy,
		);

		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected") {
			expect(outcome.feedback).toContain("step 2");
			expect(outcome.feedback).toContain("delete_everything");
			expect(outcome.feedback).toContain("a hard limit refuses this");
		}
	});

	it("tells the model not to work around a limit", () => {
		const outcome = decidePlan('[{"tool":"delete_everything","args":{}}]', TOOLS, policy);
		if (outcome.kind === "rejected") {
			expect(outcome.feedback).toContain("say so instead of working around them");
		}
	});

	it("says the plan was unreadable rather than blaming the limits", () => {
		// A model told its plan was refused when the real problem was formatting will
		// rewrite the plan instead of the JSON, forever.
		const outcome = decidePlan("no json here", TOOLS, policy);
		expect(outcome.kind).toBe("unreadable");
		if (outcome.kind === "unreadable") expect(outcome.feedback).toContain("could not be read");
	});

	it("anchors the plan as a decision already made", () => {
		const outcome = decidePlan(
			'[{"tool":"read_file","args":{},"note":"look at the config"}]',
			TOOLS,
			policy,
		);

		if (outcome.kind === "proceed") {
			expect(outcome.anchor).toContain("look at the config");
			expect(outcome.anchor).toContain("checked against the persona's limits");
			// And it permits deviation out loud, because a plan the model cannot leave is a
			// plan that gets followed off a cliff when the first step reveals something new.
			expect(outcome.anchor).toContain("Deviating from it is allowed");
		}
	});
});

describe("the rejection message on its own", () => {
	it("counts what it names", () => {
		const message = describeBlocked({
			ok: false,
			risks: [],
			blocked: [
				{ index: 0, tool: "a", decision: "deny", reason: "no" },
				{ index: 4, tool: "b", decision: "unknown", reason: "no such tool 'b'" },
			],
			needsConsent: [],
		});

		expect(message).toContain("2 step(s)");
		expect(message).toContain("step 1");
		expect(message).toContain("step 5");
	});
});
