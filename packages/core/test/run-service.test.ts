/**
 * E73: a persona runs a service it delivers from a turn. The person is asked before every run, whatever the
 * posture; a service it does not deliver is refused; and neither a persona without services, nor a turn whose
 * host cannot run one, nor a read-only persona, nor a delegated sub-task is ever given the tool.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalAnswer } from "../src/agent.js";
import { Kernel } from "../src/kernel/index.js";
import { localExecution } from "../src/ports/execution.js";
import { delegate } from "../src/run/delegation.js";
import { runnerFor, subTaskSession } from "../src/run/runner-for.js";
import { renderWorkMap, workMapFor } from "../src/run/work-map.js";
import type { Policy } from "../src/sandbox.js";
import { TOOL_POINT } from "../src/tools/mounted.js";
import { RUN_SERVICE_TOOL, runServiceTool, type RunServiceInput } from "../src/tools/run-service.js";

let workspace: string;
let personaPath: string;

function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

const GAME_BUILD = {
	name: "Game build",
	description: "A small game built to order.",
	leadPersonaRef: "gamewright",
	steps: [
		{ position: 1, personaRef: "gamewright", instruction: "Design it.", produces: ["GAME.md"] },
		{ position: 2, personaRef: "gamewright", instruction: "Build it.", produces: ["game.html"] },
	],
};

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pxs-run-service-"));
	personaPath = join(workspace, ".personaxis", "personas", "gamewright", "personaxis.md");
	write(personaPath, "---\npermissions:\n  sandbox: workspace-write\n---\n");
	write(join(workspace, ".personaxis", "services", "game-build.json"), JSON.stringify(GAME_BUILD));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const policy = (over: Partial<Policy> = {}): Policy => ({
	sandbox: "workspace-write",
	approval: "on-failure",
	allow: [],
	deny: [],
	workspaceRoot: workspace,
	...over,
});

const delivered = () => workMapFor(personaPath, { workspaceRoot: workspace }).services;
const REQUEST = { service: "game-build", brief: "A small arcade game about a cat crossing a busy road." };
const WRITER = { permissions: { sandbox: "workspace-write" } };

/** The names a turn would be shown, read off the kernel the runner mounts into, with no model. */
function offered(session: Parameters<typeof runnerFor>[1] = {}, frontmatter: Record<string, unknown> = WRITER): string[] {
	const kernel = new Kernel();
	runnerFor({ personaPath, frontmatter, llm: { endpoint: "http://127.0.0.1:9/v1", model: "m" } }, { policy: policy(), kernel, ...session });
	return kernel.extensions.of(TOOL_POINT).map((tool) => tool.name);
}

describe("run_service asks every time (E73)", () => {
	it("asks whatever the posture, and says which service would run on which request", () => {
		const tool = runServiceTool({ services: delivered, run: async () => "" });
		for (const over of [{}, { approval: "never" }, { sandbox: "danger-full-access" }] as Partial<Policy>[]) {
			const verdict = tool.gate(REQUEST, policy(over));
			expect(verdict.decision).toBe("ask");
			expect(verdict.reason).toContain('"Game build" (2 steps, leaves GAME.md, game.html)');
			expect(verdict.reason).toContain("a cat crossing a busy road");
		}
	});

	it("refuses a service the persona does not deliver, and runs nothing", async () => {
		const runs: RunServiceInput[] = [];
		const tool = runServiceTool({
			services: delivered,
			run: async (input) => {
				runs.push(input);
				return "ran";
			},
		});
		const verdict = tool.gate({ ...REQUEST, service: "contract-review" }, policy());
		expect(verdict.decision).toBe("deny");
		expect(verdict.reason).toContain("Your services: game-build");
		expect(await tool.execute({ ...REQUEST, service: "contract-review" }, policy(), localExecution())).toMatch(/^error: you deliver no service called "contract-review"/);
		expect(runs).toEqual([]);
	});

	it("refuses a run with no request, because a service runs on one", async () => {
		const tool = runServiceTool({ services: delivered, run: async () => "ran" });
		expect(tool.gate({ ...REQUEST, brief: "  " }, policy()).decision).toBe("deny");
		expect(await tool.execute({ ...REQUEST, brief: "" }, policy(), localExecution())).toMatch(/^error: say what the client asked for/);
	});

	it("hands the host the service and the request, and passes on what the host said", async () => {
		const runs: RunServiceInput[] = [];
		const tool = runServiceTool({
			services: delivered,
			run: async (input) => {
				runs.push(input);
				return "game-build completed: wrote GAME.md, game.html";
			},
		});
		expect(await tool.execute(REQUEST, policy(), localExecution())).toBe("game-build completed: wrote GAME.md, game.html");
		expect(runs).toEqual([REQUEST]);
	});

	it("says so when the host fails, instead of throwing out of the turn", async () => {
		const tool = runServiceTool({
			services: delivered,
			run: async () => {
				throw new Error("no model configured");
			},
		});
		expect(await tool.execute(REQUEST, policy(), localExecution())).toBe("error: the service could not run: no model configured");
	});
});

describe("who is shown run_service (E73)", () => {
	const lent = { runService: async () => "ran" };

	it("a persona that delivers a service, in a turn whose host can run one", () => {
		expect(offered(lent)).toContain(RUN_SERVICE_TOOL);
	});

	it("not a persona that delivers none", () => {
		rmSync(join(workspace, ".personaxis", "services"), { recursive: true, force: true });
		expect(offered(lent)).not.toContain(RUN_SERVICE_TOOL);
	});

	it("not a turn whose host cannot run one", () => {
		expect(offered({})).not.toContain(RUN_SERVICE_TOOL);
	});

	it("not a read-only persona, which could only be refused", () => {
		expect(offered(lent, { permissions: { sandbox: "read-only" } })).not.toContain(RUN_SERVICE_TOOL);
	});

	it("not a delegated sub-task, which never reaches the person who approves", () => {
		const result = delegate({ parentDepth: 0, parentScope: { sandbox: "workspace-write" } });
		if (!result.ok) throw new Error("the fixture must photograph");
		const child = subTaskSession({ ...lent }, result.scope, "a sub-task");
		expect("runService" in child).toBe(false);
	});
});

describe("the index names run_service only where it is offered (E73)", () => {
	it("tells a turn that can run a service how to, and a service step nothing it cannot do", () => {
		const map = workMapFor(personaPath, { workspaceRoot: workspace });
		expect(renderWorkMap(map, { canRunServices: true })).toContain(`run it with ${RUN_SERVICE_TOOL}`);
		expect(renderWorkMap(map)).not.toContain(RUN_SERVICE_TOOL);
		expect(renderWorkMap(map)).toContain('- game-build ("Game build")');
	});
});

describe("inside a turn (E73)", () => {
	type Call = { name: string; args: Record<string, unknown> };

	/** A model that answers each request with its next batch of calls, then finishes. */
	function scripted(batches: readonly (readonly Call[])[]) {
		let requests = 0;
		return (async (url: string) => {
			if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
			requests += 1;
			const batch = batches[requests - 1] ?? [{ name: "finish", args: { summary: "done" } }];
			const tool_calls = batch.map((call, index) => ({ id: `c${requests}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls }, finish_reason: "tool_calls" }] }) };
		}) as unknown as typeof fetch;
	}

	it("asks the person, and runs the service only after a yes", async () => {
		for (const answer of ["approve", { decision: "deny", reason: "not now" }] as ApprovalAnswer[]) {
			const runs: RunServiceInput[] = [];
			const asked: string[] = [];
			await runnerFor(
				{ personaPath, frontmatter: WRITER, llm: { endpoint: "http://x/v1", model: "m", fetchImpl: scripted([[{ name: RUN_SERVICE_TOOL, args: REQUEST }]]) } },
				{
					policy: policy(),
					runService: async (input) => {
						runs.push(input);
						return "game-build completed";
					},
					onApproval: async (call, verdict) => {
						asked.push(`${call.name}:${verdict.decision}`);
						return answer;
					},
				},
			).run({ turn: "t1", prompt: "Make me a small arcade game about a cat crossing a busy road.", asker: { kind: "human", id: "david" } });
			expect(asked).toEqual([`${RUN_SERVICE_TOOL}:ask`]);
			expect(runs).toHaveLength(answer === "approve" ? 1 : 0);
		}
	});
});
