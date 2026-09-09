/**
 * C6: work handed down, as something the model can actually reach.
 *
 * The rule was written at the study and called by nothing for weeks, which is the
 * state this repository keeps finding: a module that is finished, correct and
 * unreachable reads as done from inside its own file. So what these pin is not the
 * rule, which `delegation.test.ts` already covers, but that the rule now has a caller
 * and that the caller obeys it.
 */

import { describe, expect, it, vi } from "vitest";

import { Kernel } from "../src/kernel/index.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";
import { delegateTool, MAX_DELEGATION_DEPTH } from "../src/tools/delegate.js";
import { TOOL_POINT } from "../src/tools/mounted.js";
import { recordTurns } from "../src/run/recording.js";
import { runnerFor, subTaskSession } from "../src/run/runner-for.js";
import { delegate } from "../src/run/delegation.js";
import type { TurnRequest } from "../src/run/vocabulary.js";

const llm = { endpoint: "http://model.invalid", model: "m", apiKey: "k" } as never;

const persona = (frontmatter: Record<string, unknown> = {}) => ({
	personaPath: "/work/repo/.personaxis/personaxis.md",
	frontmatter,
	llm,
});

/** A sub-task runner that records what it was handed and answers. */
function spy(answer = "done", stopReason = "finished") {
	const calls: { instruction: string; statement: string; depth: number }[] = [];
	return {
		calls,
		run: vi.fn(async ({ instruction, statement, scope }: Parameters<Parameters<typeof delegateTool>[0]["run"]>[0]) => {
			calls.push({ instruction, statement, depth: scope.depth });
			return { answer, stopReason, steps: 2 };
		}),
	};
}

const toolFor = (depth: number, run: ReturnType<typeof spy>["run"], maxDepth?: number) =>
	delegateTool({
		run,
		depth: () => depth,
		scope: () => ({ sandbox: "workspace-write" }),
		...(maxDepth === undefined ? {} : { maxDepth }),
	});

describe("the delegate tool", () => {
	it("hands the instruction down and gives the answer back", async () => {
		const sub = spy("the summary");
		const said = await toolFor(0, sub.run).execute({ task: "summarise the log" }, DEFAULT_POLICY, {} as never);

		expect(sub.calls[0]?.instruction).toBe("summarise the log");
		expect(said).toContain("the summary");
	});

	it("refuses past the depth limit instead of throwing", async () => {
		// A throw would end the PARENT's turn over a sub-task it could have worked
		// around. The reference's measured mistake was the mirror of this: a child
		// blocked in a way nothing could see.
		const sub = spy();
		const said = await toolFor(MAX_DELEGATION_DEPTH, sub.run).execute({ task: "go deeper" }, DEFAULT_POLICY, {} as never);

		expect(said).toContain("refused");
		expect(said).toContain("Do this part yourself");
		expect(sub.run).not.toHaveBeenCalled();
	});

	it("refuses an empty instruction rather than starting an agent with one", async () => {
		const sub = spy();
		const said = await toolFor(0, sub.run).execute({ task: "   " }, DEFAULT_POLICY, {} as never);

		expect(said).toContain("refused");
		expect(sub.run).not.toHaveBeenCalled();
	});

	it("takes no scope argument, so a model cannot name its own limits", () => {
		// The whole point of the photograph is that the scope comes from what was
		// declared before the model was asked anything.
		const properties = (toolFor(0, spy().run).parameters as { properties: Record<string, unknown> })
			.properties;

		expect(Object.keys(properties)).toEqual(["task"]);
	});

	it("tells the sub-task its limits, in the words the study kept", () => {
		const statement = spyStatement();

		expect(statement).toContain("cannot be widened from here");
		expect(statement).toContain("refused automatically rather than queued");
	});

	it("declares that it spends, which is the one thing it adds", () => {
		// K6. Every other class a sub-task reaches, it reaches through its own gated
		// tools; a delegation adds no authority and does add a second agent's tokens.
		expect(toolFor(0, spy().run).envelope).toEqual(["spend"]);
	});

	it("names how a sub-task ended when it did not simply finish", async () => {
		const sub = spy("half of it", "budget");
		const said = await toolFor(0, sub.run).execute({ task: "a long one" }, DEFAULT_POLICY, {} as never);

		expect(said).toContain("half of it");
		expect(said).toContain("budget");
	});

	it("says a sub-task produced nothing, rather than handing back silence", async () => {
		const sub = spy("", "abandoned");
		const said = await toolFor(0, sub.run).execute({ task: "a quiet one" }, DEFAULT_POLICY, {} as never);

		expect(said).toContain("no answer");
		expect(said).toContain("abandoned");
	});
});

function spyStatement(): string {
	const sub = spy();
	const tool = toolFor(0, sub.run);
	// Executed for its side effect on the spy: the statement is what the tool hands the
	// runner, and asserting it through the tool is asserting what a sub-task is told.
	return (
		tool.execute({ task: "anything" }, DEFAULT_POLICY, {} as never),
		sub.calls[0]?.statement ?? ""
	);
}

describe("the catalogue a persona is offered", () => {
	it("includes delegation for a persona that may write", () => {
		const kernel = new Kernel();
		runnerFor(persona(), { kernel });

		expect(kernel.extensions.of(TOOL_POINT).map((tool) => tool.name)).toContain("delegate");
	});

	it("withholds it from a read-only persona", () => {
		// Not about authority: a sub-task cannot exceed its parent. It is about SPEND.
		// A persona somebody limited to looking should not be able to start another run
		// to look harder.
		const kernel = new Kernel();
		// `permissions.sandbox` is where a persona declares its posture, read by
		// `policyFromPersona`. The first version of this test guessed a different key
		// and the persona compiled to the default, which handed it every tool: a
		// fixture that guesses tests the default and calls it the case it names.
		runnerFor(persona({ permissions: { sandbox: "read-only" } }), { kernel });

		expect(kernel.extensions.of(TOOL_POINT).map((tool) => tool.name)).not.toContain("delegate");
	});
});

describe("the session a sub-task runs under", () => {
	const scope = (() => {
		const result = delegate({ parentDepth: 0, parentScope: { sandbox: "workspace-write" } });
		if (!result.ok) throw new Error("the fixture must photograph");
		return result.scope;
	})();

	it("refuses every approval, deterministically", async () => {
		const child = subTaskSession({}, scope, "you are confined");

		expect(await child.onApproval?.({} as never, {} as never)).toBe("deny");
	});

	it("carries the scope as a runtime note, not as a system prompt", () => {
		expect(subTaskSession({}, scope, "you are confined").envNote).toBe("you are confined");
	});

	it("does not lend the parent's transcript", () => {
		const parentTranscript = { read: () => [] } as never;
		const child = subTaskSession({ conversation: parentTranscript }, scope, "s");

		expect(child.conversation).toBeUndefined();
	});

	it("does not lend the parent's kernel", () => {
		// A withdrawal inside a sub-task must not reach into the catalogue its parent
		// is still using.
		const child = subTaskSession({ kernel: new Kernel() }, scope, "s");

		expect(child.kernel).toBeUndefined();
	});

	it("shares the parent's ledger rather than opening a second one", () => {
		// The reference gives each child its own and says plainly that a delegation
		// tree then exceeds its parent's ceiling. A ceiling a delegation steps over is
		// not a ceiling.
		const forChild = vi.fn(() => "the same ledger");
		const child = subTaskSession({ ledger: { forChild } as never }, scope, "s");

		expect(forChild).toHaveBeenCalled();
		expect(child.ledger).toBe("the same ledger");
	});

	it("carries the photographed depth, so a grandchild counts from here", () => {
		expect(subTaskSession({}, scope, "s").delegationDepth).toBe(1);
	});

	it("keeps everything else the parent had", () => {
		const child = subTaskSession({ sessionId: "s1", maxSteps: 4 }, scope, "s");

		expect(child.sessionId).toBe("s1");
		expect(child.maxSteps).toBe(4);
	});
});

describe("what a delegated turn writes into the record", () => {
	const scope = (() => {
		const result = delegate({ parentDepth: 1, parentScope: { sandbox: "read-only" } });
		if (!result.ok) throw new Error("the fixture must photograph");
		return result.scope;
	})();

	function written(request: TurnRequest) {
		const entries: { author: unknown; body: { type: string } }[] = [];
		const journal = { append: (author: unknown, body: { type: string }) => entries.push({ author, body }) };
		// `opened` is optional on the observer type and always present on this one.
		// Asserted rather than asserted-away with a cast, so a day when `recordTurns`
		// stops writing openings fails here instead of passing quietly.
		const observer = recordTurns({ journal: journal as never });
		if (!observer.opened) throw new Error("this observer must write openings");
		observer.opened(request);
		return entries;
	}

	it("writes the photograph before the turn it was taken for", () => {
		const entries = written({
			turn: "t1",
			prompt: "read the log",
			asker: { kind: "persona", id: "/p.md" },
			delegation: scope,
		});

		expect(entries.map((entry) => entry.body.type)).toEqual(["delegation", "turn-open"]);
	});

	it("says what was photographed, and from whom", () => {
		const [photograph] = written({
			turn: "t1",
			prompt: "read the log",
			asker: { kind: "persona", id: "/p.md" },
			delegation: scope,
		});

		expect(photograph?.body).toMatchObject({
			type: "delegation",
			depth: 2,
			sandbox: "read-only",
			directories: [],
			task: "read the log",
		});
		// The runtime's entry naming who it came from, never the parent's own author:
		// the parent did not write this sentence, the delegation did.
		expect(photograph?.author).toMatchObject({ kind: "runtime", mechanism: "delegation" });
	});

	it("writes nothing extra for a turn a person asked for", () => {
		const entries = written({ turn: "t1", prompt: "hello", asker: { kind: "human", id: "dq" } });

		expect(entries.map((entry) => entry.body.type)).toEqual(["turn-open"]);
	});
});
