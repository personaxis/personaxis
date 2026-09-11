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

	it("briefs every step of the sub-service with the parent's step and what came before it", async () => {
		// Found on 2026-09-11 preparing the first real run: the sub-service started with an empty
		// handover, so due diligence did not know which deal it was checking.
		const sub = line("due-diligence", { persona: "researcher" }, { persona: "summariser" });
		const main: ServiceDef = {
			address: "deal",
			name: "deal",
			steps: [
				{ position: 1, personaRef: "intake", instruction: "take the deal in" },
				{ position: 2, serviceRef: "due-diligence", instruction: "check the counterparty of this deal" },
			],
		};
		const { p, prompts } = ports([main, sub], { intake: { outcome: "completed", summary: "counterparty is Acme Ltd" } });
		await runService(main, p);
		for (const who of ["researcher", "summariser"]) {
			expect(prompts[who]).toContain("check the counterparty of this deal");
			expect(prompts[who]).toContain("counterparty is Acme Ltd");
		}
		// Its own instruction still comes first, as stepPrompt decides.
		expect(prompts.researcher?.startsWith("do part 1")).toBe(true);
	});

	it("carries the brief down more than one level", async () => {
		const leaf = line("background-check", { persona: "checker" });
		const mid = line("due-diligence", { service: "background-check" });
		const main = line("deal", { persona: "intake" }, { service: "due-diligence" });
		const { p, prompts } = ports([main, mid, leaf], { intake: { outcome: "completed", summary: "counterparty is Acme Ltd" } });
		await runService(main, p);
		expect(prompts.checker).toContain("counterparty is Acme Ltd");
	});

	// Each note is cut to 3 000 characters by handover.ts, so several notes are needed to pass the
	// cap; one long note never does. The first version of these two tests used one, and passed
	// nothing through the trimming at all.
	const noted = (address: string, prefix: string, count: number, then: { service: string }): { def: ServiceDef; script: Script } => ({
		def: line(address, ...Array.from({ length: count }, (_, i) => ({ persona: `${prefix}${i + 1}` })), then),
		script: Object.fromEntries(
			Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, { outcome: "completed" as const, summary: `${prefix.toUpperCase()}${i + 1} ${"x".repeat(3_500)}` }]),
		),
	});

	it("trims the outermost context first, and says so, when the brief would pass its cap", async () => {
		const leaf = line("leaf", { persona: "checker" });
		const mid = noted("mid", "near", 2, { service: "leaf" });
		const root = noted("root", "far", 3, { service: "mid" });
		const { p, prompts } = ports([root.def, mid.def, leaf], { ...root.script, ...mid.script });
		await runService(root.def, p);
		const prompt = prompts.checker ?? "";
		expect(prompt).toContain("NEAR1");
		expect(prompt).toContain("NEAR2");
		// The oldest note of the outermost service is what goes, and the cut is announced.
		expect(prompt).not.toContain("FAR1");
		expect(prompt).toContain("FAR3");
		expect(prompt).toContain("The start of the larger job is trimmed here");
	});

	it("drops the outer context entirely when the step right above fills the cap on its own", async () => {
		const leaf = line("leaf", { persona: "checker" });
		const mid = noted("mid", "near", 4, { service: "leaf" });
		const root = noted("root", "far", 1, { service: "mid" });
		const { p, prompts } = ports([root.def, mid.def, leaf], { ...root.script, ...mid.script });
		await runService(root.def, p);
		const prompt = prompts.checker ?? "";
		expect(prompt).toContain("NEAR4");
		expect(prompt).not.toContain("FAR1");
		// Instruction, the brief from the step above (its handover capped at 12 000) and nothing else.
		expect(prompt.length).toBeLessThan(13_000);
	});

	it("gives a service that is nobody's step no brief at all", async () => {
		const svc = line("alone", { persona: "only" });
		const { p, prompts } = ports([svc], {});
		await runService(svc, p);
		expect(prompts.only).toBe("do part 1");
	});

	it("holds each note once: a service step points at the step inside it that delivered", async () => {
		// The first real run stored the documentation twice, once in the sub-service's last step
		// and again in the parent's step, 4 068 characters each.
		const sub = line("docs", { persona: "drafter" }, { persona: "editor" });
		const main = line("release", { service: "docs" }, { persona: "notifier" });
		const { p, prompts } = ports([main, sub], { editor: { outcome: "completed", summary: "THE REFERENCE" } });
		const r = await runService(main, p);
		const serviceStep = r.steps.find((s) => "service" in s.who);
		expect(serviceStep?.summary).toBeNull();
		expect(serviceStep?.deliveredBy).toEqual({ path: ["release", "docs"], position: 2 });
		const delivered = r.steps.find((s) => s.path.join(">") === "release>docs" && s.position === 2);
		expect(delivered?.summary).toBe("THE REFERENCE");
		expect(r.steps.filter((s) => s.summary === "THE REFERENCE")).toHaveLength(1);
		// And the next step of the parent still receives it: the pointer is for the record only.
		expect(prompts.notifier).toContain("THE REFERENCE");
		expect(r.summaryFrom).toEqual({ path: ["release"], position: 2 });
	});

	it("keeps the text on a service step when no step inside it left a note to point at", async () => {
		// A sub-service that stopped without a note delivers its reason, and there is no step to
		// point at, so the text stays on the parent's step.
		const sub = line("quiet", { persona: "silent" }, { persona: "unused" });
		const main = line("outer", { service: "quiet" });
		const { p } = ports([main, sub], { silent: { outcome: "stopped", summary: null } });
		const r = await runService(main, p);
		const serviceStep = r.steps.find((s) => "service" in s.who);
		expect(serviceStep?.deliveredBy).toBeUndefined();
		expect(serviceStep?.summary).toBe("stopped at step 1");
	});

	it("leaves a service step without a note when nothing inside it left one", async () => {
		const sub = line("quiet", { persona: "silent" });
		const main = line("outer", { service: "quiet" }, { persona: "next" });
		const { p, prompts } = ports([main, sub], { silent: { outcome: "completed", summary: null } });
		const r = await runService(main, p);
		const serviceStep = r.steps.find((s) => "service" in s.who);
		expect(serviceStep?.summary).toBeNull();
		expect(serviceStep?.deliveredBy).toBeUndefined();
		// The next step is told plainly, in handover.ts's own words, that nothing was left.
		expect(prompts.next).toContain("Left no note");
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

describe("a step that declares the files it leaves (E60)", () => {
	/**
	 * A folder in memory: a persona "writes" by putting a file in it, stamped with the time it did.
	 * The check reads the same folder, so what it finds is what the step did and not what it said.
	 */
	function folder(existing: Record<string, number> = {}) {
		const files = new Map<string, { bytes: number; at: number }>(
			Object.entries(existing).map(([path, bytes]) => [path, { bytes, at: 0 }]),
		);
		const checked: Array<{ paths: readonly string[]; since: number }> = [];
		const check: NonNullable<ServicePorts["checkProduced"]> = async ({ paths, since }) => {
			checked.push({ paths, since });
			const produced = paths.flatMap((path) => {
				const file = files.get(path);
				return file && file.at >= since ? [{ path, bytes: file.bytes }] : [];
			});
			return { produced, missing: paths.filter((path) => !produced.some((f) => f.path === path)) };
		};
		const write = (path: string, bytes: number) => files.set(path, { bytes, at: Date.now() });
		return { check, write, checked };
	}

	const declaring = (address: string, persona: string, produces: string[], then?: string): ServiceDef => ({
		address,
		name: address,
		steps: [
			{ position: 1, personaRef: persona, instruction: "write the reference", produces },
			...(then ? [{ position: 2, personaRef: then, instruction: "build on it" }] : []),
		],
	});

	it("fails a step that said it wrote the file and did not, and stops the line there", async () => {
		const svc = declaring("docs", "scribe", ["docs/refunds.md"], "reviewer");
		const fs = folder();
		const { p, calls } = ports([svc], { scribe: { outcome: "completed", summary: "saved to docs/refunds.md" } });
		const r = await runService(svc, { ...p, checkProduced: fs.check });
		expect(r.status).toBe("failed");
		expect(r.steps[0]!.reason).toContain("step 1 was to write docs/refunds.md, and did not");
		expect(calls).not.toContain("reviewer");
		// What the agent claimed stays in the record, next to the reason that says it was not so.
		expect(r.steps[0]).toMatchObject({ outcome: "failed", summary: "saved to docs/refunds.md" });
	});

	it("completes a step that wrote it, and records what it left in the SaaS's shape", async () => {
		const svc = declaring("docs", "scribe", ["docs/refunds.md"], "reviewer");
		const fs = folder();
		const base = ports([svc], {});
		const r = await runService(svc, {
			...base.p,
			checkProduced: fs.check,
			async runPersonaStep(input) {
				if (input.personaRef === "scribe") fs.write("docs/refunds.md", 1200);
				return base.p.runPersonaStep(input);
			},
		});
		expect(r.status).toBe("completed");
		expect(r.steps[0]!.produced).toEqual([{ path: "docs/refunds.md", bytes: 1200 }]);
		expect(r.steps[1]!.produced).toBeUndefined();
	});

	it("does not count a file that was already there before the step began", async () => {
		const svc = declaring("docs", "scribe", ["docs/CHANGELOG.md"]);
		const fs = folder({ "docs/CHANGELOG.md": 800 });
		const { p } = ports([svc], {});
		const r = await runService(svc, { ...p, checkProduced: fs.check });
		expect(r.status).toBe("failed");
		expect(r.steps[0]!.reason).toContain("docs/CHANGELOG.md");
	});

	it("names only the files that are missing", async () => {
		const svc = declaring("docs", "scribe", ["docs/a.md", "docs/b.md"]);
		const fs = folder();
		const base = ports([svc], {});
		const r = await runService(svc, {
			...base.p,
			checkProduced: fs.check,
			async runPersonaStep(input) {
				fs.write("docs/a.md", 10);
				return base.p.runPersonaStep(input);
			},
		});
		expect(r.steps[0]!.reason).toContain("was to write docs/b.md,");
		expect(r.steps[0]!.reason).not.toContain("docs/a.md");
		expect(r.steps[0]!.produced).toEqual([{ path: "docs/a.md", bytes: 10 }]);
	});

	it("does not check a step that already failed, which has its own reason", async () => {
		const svc = declaring("docs", "scribe", ["docs/refunds.md"]);
		const fs = folder();
		const { p } = ports([svc], { scribe: { outcome: "failed", summary: null, reason: "the model timed out" } });
		const r = await runService(svc, { ...p, checkProduced: fs.check });
		expect(r.steps[0]!.reason).toBe("the model timed out");
		expect(fs.checked).toHaveLength(0);
	});

	it("fails the step when the runner cannot check files, instead of taking the agent's word", async () => {
		const svc = declaring("docs", "scribe", ["docs/refunds.md"]);
		const { p } = ports([svc], {});
		const r = await runService(svc, p);
		expect(r.status).toBe("failed");
		expect(r.steps[0]!.reason).toContain("this runner cannot check them");
	});

	it("fails the step when the check itself throws, and says so", async () => {
		const svc = declaring("docs", "scribe", ["docs/refunds.md"]);
		const { p } = ports([svc], {});
		const r = await runService(svc, {
			...p,
			async checkProduced() {
				throw new Error("EACCES");
			},
		});
		expect(r.status).toBe("failed");
		expect(r.steps[0]!.reason).toContain("the check itself failed: EACCES");
	});

	it("tells the agent what it will be checked on", async () => {
		const svc = declaring("docs", "scribe", ["docs/refunds.md"]);
		const fs = folder();
		const { p, prompts } = ports([svc], {});
		await runService(svc, { ...p, checkProduced: fs.check });
		expect(prompts.scribe).toContain("the run checks that it wrote docs/refunds.md");
	});

	it("checks a step done by a whole service once that service has finished", async () => {
		const sub = line("docs-update", { persona: "scribe" });
		const main: ServiceDef = {
			address: "release",
			name: "release",
			steps: [{ position: 1, serviceRef: "docs-update", instruction: "update the docs", produces: ["docs/refunds.md"] }],
		};
		const fs = folder();
		const base = ports([main, sub], {});
		const r = await runService(main, {
			...base.p,
			checkProduced: fs.check,
			async runPersonaStep(input) {
				fs.write("docs/refunds.md", 42);
				return base.p.runPersonaStep(input);
			},
		});
		expect(r.status).toBe("completed");
		expect(r.steps.at(-1)).toMatchObject({ who: { service: "docs-update" }, produced: [{ path: "docs/refunds.md", bytes: 42 }] });
		// And the sub-service's own steps were told what the parent expects of them.
		expect(base.prompts.scribe).toContain("the run checks that it wrote docs/refunds.md");
	});

	it("refuses, before running, a declared file outside the service's folder", () => {
		const svc: ServiceDef = {
			address: "bad",
			name: "bad",
			steps: [{ position: 1, personaRef: "scribe", instruction: "x", produces: ["/etc/passwd", "../other/x.md", "~/.ssh/config", "C:\\x.md", ""] }],
		};
		const problems = checkComposition(svc, () => undefined);
		expect(problems.filter((p) => p.includes("not relative"))).toHaveLength(3);
		expect(problems.some((p) => p.includes("climbs out"))).toBe(true);
		expect(problems.some((p) => p.includes("not a file path"))).toBe(true);
	});
});
