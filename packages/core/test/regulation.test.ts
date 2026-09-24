/**
 * E126: the self-regulation a persona declares, applied at the gate when its own record says it has been failing.
 *
 * The first version of this told the model why it had been tightened, and one sentence took a bench task from
 * 6/6 to 0/6. So the checks that matter most here are two: the gate asks a person when the record calls for it,
 * and nothing the model is sent says so. Beside them the negative ones: nothing fires without evidence, nothing
 * fires that the persona did not enable, and nothing ever loosens a posture.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile, DEFAULT_POLICY, evaluate, PersonaAgent, policyFromPersona, run, type Policy } from "../src/index.js";
import type { RecordEntry } from "../src/record/entry.js";
import { recordPathFor } from "../src/record/store.js";

const verification = (passed: boolean): RecordEntry =>
	({ body: { type: "verification", turn: "t", checks: [{ what: "game.html", how: "ran it", passed, scope: "targeted" }], unverified: [] } }) as unknown as RecordEntry;
const call = (denied: boolean): RecordEntry =>
	({ body: { type: "call", turn: "t", callId: "c", tool: "write_file", verdict: denied ? "denied" : "allowed" } }) as unknown as RecordEntry;

/** What the bench persona declares, trimmed to what this reads, with the permissive posture the measure uses. */
const DECLARED = {
	permissions: { sandbox: "workspace-write", approval: "never" },
	metacognition: { thresholds: { abstain_if_confidence_below: 0.3, escalate_if_policy_risk_above: 0.65 } },
	self_regulation: {
		decisions: {
			interaction_decision: { enabled: ["silent", "ask_clarification", "escalate_to_human"] },
			governance_decision: { enabled: ["no_action", "propose_self_edit", "reduce_autonomy"] },
		},
	},
};

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A persona on disk whose record holds exactly these entries. Only the bodies matter to what is read. */
const personaWith = (entries: readonly RecordEntry[]): string => {
	const d = mkdtempSync(join(tmpdir(), "pxs-e126-"));
	tmpDirs.push(d);
	const personaPath = join(d, "personaxis.md");
	writeFileSync(personaPath, "---\nmetadata: { name: w, version: 1.0.0 }\nidentity: { canonical_id: w }\n---\nbody\n");
	if (entries.length > 0) writeFileSync(recordPathFor(personaPath), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return personaPath;
};
const regulationOf = (entries: readonly RecordEntry[], declared: Record<string, unknown> = DECLARED): run.Regulation =>
	run.regulationFor(personaWith(entries), declared);
const failing = (n: number): RecordEntry[] => Array.from({ length: n }, () => verification(false));

describe("regulation from what the record says and what the persona declared (E126)", () => {
	it("calls one failure evidence of nothing", () => {
		expect(regulationOf([verification(false)])).toEqual({ because: [] });
	});

	it("asks for a person when its deliveries keep failing and it enabled escalate_to_human", () => {
		// 1 of 4 is 0.25, below the 0.3 declared.
		const r = regulationOf([...failing(3), verification(true)]);
		expect(r.approval).toBe("untrusted");
		expect(r.because.join(" ")).toContain("1 of its last 4 checked deliveries passed");
	});

	it("stays out of it at the threshold's edge", () => {
		// 1 of 3 is 0.33, which is NOT below 0.3.
		expect(regulationOf([...failing(2), verification(true)])).toEqual({ because: [] });
	});

	it("does nothing the persona did not enable", () => {
		expect(regulationOf(failing(3), { ...DECLARED, self_regulation: { decisions: {} } })).toEqual({ because: [] });
	});

	it("does nothing when the persona declares no threshold", () => {
		expect(regulationOf(failing(3), { ...DECLARED, metacognition: {} })).toEqual({ because: [] });
	});

	it("relaxes when the window of five moves past the failures", () => {
		// Over the whole history this is 5 of 25, below the threshold; over the last five it is 5 of 5.
		expect(regulationOf([...failing(20), ...Array.from({ length: 5 }, () => verification(true))])).toEqual({ because: [] });
	});

	it("asks before writing when the gate keeps refusing and it enabled reduce_autonomy", () => {
		const r = regulationOf(Array.from({ length: 10 }, (_, i) => call(i < 8)));
		expect(r.approval).toBe("on-request");
		expect(r.because.join(" ")).toContain("refused 8 of its last 10 calls");
	});

	it("says nothing about a persona with no record at all", () => {
		expect(regulationOf([])).toEqual({ because: [] });
	});
});

describe("the floor on the compiled approval (E126)", () => {
	const at = new Date("2026-09-23T00:00:00Z");
	const compiled = (declared: string, floor?: { approval: "untrusted" | "on-request"; because: string }) =>
		policyFromPersona({ permissions: { approval: declared } }, { personaVersionId: "p", now: at, ...(floor ? { approvalAtLeast: floor } : {}) });

	it("tightens, and the hash says which policy judged", () => {
		const loose = compiled("never");
		const tight = compiled("never", { approval: "untrusted", because: "it has been failing" });
		expect(tight.approval).toBe("untrusted");
		expect(tight.approval_because).toBe("it has been failing");
		expect(tight.hash).not.toBe(loose.hash);
	});

	it("never loosens, and gives no reason for a change that did not happen", () => {
		const strict = compiled("untrusted", { approval: "on-request", because: "it has been refused" });
		expect(strict.approval).toBe("untrusted");
		expect(strict.approval_because).toBeUndefined();
		expect(strict.hash).toBe(compiled("untrusted").hash);
	});

	it("puts the reason in the verdict the person reads", () => {
		const policy = compiled("never", { approval: "untrusted", because: "0 of its last 4 checked deliveries passed" });
		const decision = evaluate(compile(policy), { tool: "write_file", args_text: "{}", action_classes: ["external_write"], within_workspace: true });
		expect(decision.verdict).toBe("gate");
		expect(decision.verdict === "gate" ? decision.reason : "").toContain("because 0 of its last 4 checked deliveries passed");
	});
});

describe("a regulated turn asks a person, and the model is told nothing (E126)", () => {
	const llmThat = (sent: string[]) => {
		const steps = [
			{ tool: "write_file", args: { path: "note.txt", content: "hello" } },
			{ tool: "finish", args: { summary: "done" } },
		];
		let i = 0;
		const fetchImpl = (async (url: string, init?: { body?: string }) => {
			if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
			if (init?.body) sent.push(init.body);
			const s = steps[Math.min(i, steps.length - 1)]!;
			i += 1;
			const message = { content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args) } }] };
			return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
		}) as unknown as typeof fetch;
		return { endpoint: "http://x/v1", model: "m", fetchImpl };
	};

	const turn = async (entries: readonly RecordEntry[]) => {
		const personaPath = personaWith(entries);
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pxs-e126w-"));
		tmpDirs.push(workspaceRoot);
		const sent: string[] = [];
		const asked: string[] = [];
		const policy: Policy = { ...DEFAULT_POLICY, workspaceRoot, sandbox: "workspace-write", approval: "never" };
		const options = run.agentOptionsFor(
			{ personaPath, frontmatter: DECLARED as Record<string, unknown>, llm: llmThat(sent) },
			{ policy, onApproval: async (c) => (asked.push(c.name), "approve") },
		);
		await new PersonaAgent(options).run("write a note");
		return { options, sent: sent.join("\n"), asked };
	};

	it("asks before the write when the record says it has been failing", async () => {
		const { asked, options } = await turn(failing(4));
		expect(asked).toEqual(["write_file"]);
		expect(options.capability?.policy.approval).toBe("untrusted");
		// The session's policy, the one the scope line prints, is the caller's and untouched.
		expect(options.policy?.approval).toBe("never");
	});

	it("does not ask a persona whose record is fine", async () => {
		const { asked, options } = await turn([verification(true), verification(true)]);
		expect(asked).toEqual([]);
		expect(options.capability?.policy.approval).toBe("never");
	});

	it("sends the model the same scope either way, with no word of why", async () => {
		const regulated = await turn(failing(4));
		expect(regulated.sent).toContain("approval: never");
		expect(regulated.sent).not.toContain("untrusted");
		expect(regulated.sent).not.toContain("checked deliveries");
	});
});
