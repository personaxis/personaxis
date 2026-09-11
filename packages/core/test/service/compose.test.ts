/**
 * Services that contain services, run with no model and no database.
 *
 * The persona turn is a fake that answers from a script, so every property below is about the
 * composition and not about what a model happened to say. See the ADR "servicios compuestos".
 */

import { describe, expect, it } from "vitest";

import {
	MAX_SERVICE_DEPTH,
	checkComposition,
	runService,
	type PersonaStepResult,
	type ServiceDef,
	type ServicePorts,
} from "../../src/service/compose.js";

type Script = Record<string, PersonaStepResult>;

/** Ports whose persona turns come from a script keyed by persona address. */
function ports(defs: ServiceDef[], script: Script, approve: "approved" | "rejected" | "unavailable" = "approved") {
	const byAddress = new Map(defs.map((d) => [d.address, d]));
	const prompts: Record<string, string> = {};
	const calls: string[] = [];
	const p: ServicePorts = {
		resolveService: (a) => byAddress.get(a),
		async runPersonaStep({ personaRef, prompt }) {
			calls.push(personaRef);
			prompts[personaRef] = prompt;
			return script[personaRef] ?? { outcome: "completed", summary: `${personaRef} done` };
		},
		async approve() {
			return approve;
		},
	};
	return { p, prompts, calls };
}

const line = (address: string, ...refs: Array<{ persona?: string; service?: string; approval?: boolean }>): ServiceDef => ({
	address,
	name: address,
	steps: refs.map((r, i) => ({
		position: i + 1,
		instruction: `do part ${i + 1}`,
		...(r.persona ? { personaRef: r.persona } : {}),
		...(r.service ? { serviceRef: r.service } : {}),
		...(r.approval ? { requiresApproval: true } : {}),
	})),
});

describe("a service of personas", () => {
	it("runs the steps in order and hands each one what the last left", async () => {
		const svc = line("contracts", { persona: "reader" }, { persona: "reviewer" });
		const { p, prompts, calls } = ports([svc], { reader: { outcome: "completed", summary: "found 3 risky clauses" } });
		const r = await runService(svc, p);
		expect(r.status).toBe("completed");
		expect(calls).toEqual(["reader", "reviewer"]);
		// The handover is the SaaS's own handoverText, so the second step reads the first's note.
		expect(prompts.reviewer).toContain("found 3 risky clauses");
	});

	it("ends the whole service when one of its own steps stops, which is what advance decides", async () => {
		const svc = line("watch", { persona: "watcher" }, { persona: "writer" });
		const { p, calls } = ports([svc], { watcher: { outcome: "stopped", summary: "nothing new" } });
		const r = await runService(svc, p);
		expect(r.status).toBe("completed");
		expect(calls).toEqual(["watcher"]);
	});
});

describe("a service that is a step of another", () => {
	it("runs the sub-service to the end and hands its result to the next step", async () => {
		const sub = line("due-diligence", { persona: "researcher" }, { persona: "summariser" });
		const main = line("deal", { persona: "intake" }, { service: "due-diligence" }, { persona: "partner" });
		const { p, prompts, calls } = ports([main, sub], { summariser: { outcome: "completed", summary: "no blockers found" } });
		const r = await runService(main, p);
		expect(r.status).toBe("completed");
		expect(calls).toEqual(["intake", "researcher", "summariser", "partner"]);
		expect(prompts.partner).toContain("no blockers found");
	});

	it("records the sub-service's steps under its own path", async () => {
		const sub = line("child", { persona: "a" });
		const main = line("parent", { service: "child" });
		const { p } = ports([main, sub], {});
		const r = await runService(main, p);
		const inner = r.steps.find((s) => "persona" in s.who && s.who.persona === "a");
		expect(inner?.path).toEqual(["parent", "child"]);
	});

	it("does NOT end the parent when a sub-service stops early: it delivered empty", async () => {
		// The trap from the ADR. A step that stops ends its own service; if that propagated up,
		// a sub-service's "nothing to do" would end a parent that still had work.
		const sub = line("scan", { persona: "scanner" }, { persona: "unused" });
		const main = line("report", { service: "scan" }, { persona: "writer" });
		const { p, calls } = ports([main, sub], { scanner: { outcome: "stopped", summary: "nothing to scan" } });
		const r = await runService(main, p);
		expect(r.status).toBe("completed");
		expect(calls).toContain("writer");
		expect(calls).not.toContain("unused");
	});

	it("fails the parent step when the sub-service fails, and the parent stops there", async () => {
		const sub = line("check", { persona: "checker" });
		const main = line("ship", { service: "check" }, { persona: "shipper" });
		const { p, calls } = ports([main, sub], { checker: { outcome: "failed", summary: null } });
		const r = await runService(main, p);
		expect(r.status).toBe("failed");
		expect(calls).not.toContain("shipper");
	});

	it("turns a persona port that throws into a failed step, and keeps the steps before it", async () => {
		const svc = line("ship", { persona: "writer" }, { persona: "broken" }, { persona: "shipper" });
		const { p, calls } = ports([svc], {});
		const inner = p.runPersonaStep.bind(p);
		p.runPersonaStep = async (input) => {
			if (input.personaRef === "broken") throw new Error("provider 503");
			return inner(input);
		};
		const r = await runService(svc, p);
		expect(r.status).toBe("failed");
		expect(r.steps.map((s) => s.outcome)).toEqual(["completed", "failed"]);
		expect(r.steps[1]?.reason).toBe("provider 503");
		expect(calls).not.toContain("shipper");
	});

	it("fails a step whose sub-service is not installed, instead of skipping it", async () => {
		const main = line("ship", { service: "missing" }, { persona: "shipper" });
		const { p, calls } = ports([main], {});
		const r = await runService(main, p);
		expect(r.status).toBe("failed");
		expect(calls).not.toContain("shipper");
	});
});

describe("what cannot be composed", () => {
	it("finds a cycle before running anything", () => {
		const a = line("a", { service: "b" });
		const b = line("b", { service: "a" });
		const map = new Map([a, b].map((d) => [d.address, d]));
		expect(checkComposition(a, (x) => map.get(x)).some((m) => m.startsWith("cycle: a -> b -> a"))).toBe(true);
	});

	it("refuses a cycle at run time too, because a definition can change after it was checked", async () => {
		const a = line("a", { service: "b" });
		const b = line("b", { service: "a" });
		const { p } = ports([a, b], {});
		const r = await runService(a, p);
		expect(r.status).toBe("failed");
	});

	it("refuses nesting deeper than the limit", async () => {
		const chain: ServiceDef[] = [];
		for (let i = 0; i <= MAX_SERVICE_DEPTH + 1; i += 1) {
			chain.push(line(`s${i}`, i <= MAX_SERVICE_DEPTH ? { service: `s${i + 1}` } : { persona: "leaf" }));
		}
		const { p, calls } = ports(chain, {});
		const r = await runService(chain[0]!, p);
		expect(r.status).toBe("failed");
		expect(calls).not.toContain("leaf");
	});

	it("reports a step with both references, or none", () => {
		const svc: ServiceDef = {
			address: "bad",
			name: "bad",
			steps: [
				{ position: 1, instruction: "x", personaRef: "p", serviceRef: "s" },
				{ position: 2, instruction: "y" },
			],
		};
		const problems = checkComposition(svc, () => undefined);
		expect(problems.filter((m) => m.includes("exactly one"))).toHaveLength(2);
	});

	it("reports positions with a gap", () => {
		const svc: ServiceDef = { address: "gap", name: "gap", steps: [{ position: 1, instruction: "x", personaRef: "p" }, { position: 3, instruction: "y", personaRef: "q" }] };
		expect(checkComposition(svc, () => undefined).some((m) => m.includes("no gaps"))).toBe(true);
	});
});

describe("approval never happens by itself", () => {
	it("continues when a person approves", async () => {
		const svc = line("sign", { persona: "drafter", approval: true }, { persona: "sender" });
		const { p, calls } = ports([svc], {}, "approved");
		expect((await runService(svc, p)).status).toBe("completed");
		expect(calls).toContain("sender");
	});

	it("ends without sending when a person rejects", async () => {
		const svc = line("sign", { persona: "drafter", approval: true }, { persona: "sender" });
		const { p, calls } = ports([svc], {}, "rejected");
		expect((await runService(svc, p)).status).toBe("completed");
		expect(calls).not.toContain("sender");
	});

	it("waits, and does not approve, when nobody can answer", async () => {
		const svc = line("sign", { persona: "drafter", approval: true }, { persona: "sender" });
		const { p, calls } = ports([svc], {}, "unavailable");
		const r = await runService(svc, p);
		expect(r.status).toBe("waiting");
		expect(calls).not.toContain("sender");
	});

	it("makes the parent wait when a sub-service is waiting", async () => {
		const sub = line("approve-me", { persona: "drafter", approval: true }, { persona: "after" });
		const main = line("outer", { service: "approve-me" }, { persona: "final" });
		const { p, calls } = ports([main, sub], {}, "unavailable");
		const r = await runService(main, p);
		expect(r.status).toBe("waiting");
		expect(calls).not.toContain("final");
	});
});

describe("the control of the control", () => {
	it("a naive propagation of a sub-service's stop WOULD have ended the parent", async () => {
		// Reproduces what the trap would do, so the suite proves the real implementation avoids it
		// rather than passing because the scenario never exercised the stop.
		const sub = line("scan", { persona: "scanner" });
		const { p } = ports([sub], { scanner: { outcome: "stopped", summary: "nothing" } });
		const r = await runService(sub, p);
		// The sub-service itself did end early...
		expect(r.status).toBe("completed");
		expect(r.reason).toMatch(/stopped at step 1/);
		// ...and a parent that read "stopped" as its own outcome would have ended, which is why the
		// mapping in runSubService turns it into "completed" instead.
	});
});
