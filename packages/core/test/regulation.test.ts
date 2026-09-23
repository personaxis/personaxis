/**
 * E126: the metacognition a persona declares, read against what its record says it did.
 *
 * Every persona Genesis writes declares thresholds and the self-regulation decisions it may take,
 * and until 2026-09-23 the runtime read none of it. The numbers are read against the record, not
 * against the model's own confidence, which is a poor instrument. The checks that matter most are
 * the negative ones: nothing fires without evidence, nothing fires that the persona did not enable,
 * and nothing ever loosens a posture.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile, DEFAULT_POLICY, PersonaAgent, run, type CompiledPolicy, type ExecutablePolicy, type Policy } from "../src/index.js";
import type { RecordEntry } from "../src/record/entry.js";
import { recordPathFor } from "../src/record/store.js";

const verification = (passed: boolean): RecordEntry =>
	({ body: { type: "verification", turn: "t", checks: [{ what: "game.html", how: "ran it", passed, scope: "targeted" }], unverified: [] } }) as unknown as RecordEntry;
const call = (denied: boolean): RecordEntry =>
	({ body: { type: "call", turn: "t", callId: "c", tool: "write_file", verdict: denied ? "denied" : "allowed" } }) as unknown as RecordEntry;

/** What the bench persona declares, trimmed to what this reads. */
const DECLARED = {
	metacognition: { thresholds: { abstain_if_confidence_below: 0.3, escalate_if_policy_risk_above: 0.65 } },
	self_regulation: {
		decisions: {
			cognition_decision: { enabled: ["no_extra", "request_more_evidence", "invoke_tool"] },
			interaction_decision: { enabled: ["silent", "ask_clarification", "escalate_to_human"] },
			governance_decision: { enabled: ["no_action", "propose_self_edit", "reduce_autonomy"] },
		},
	},
};

/** A persona on disk whose record holds exactly these entries. Only the bodies matter to what is read. */
const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const personaWith = (entries: readonly RecordEntry[]): string => {
	const d = mkdtempSync(join(tmpdir(), "pxs-e126-"));
	tmpDirs.push(d);
	const personaPath = join(d, "personaxis.md");
	writeFileSync(personaPath, "---\nmetadata: { name: w, version: 1.0.0 }\nidentity: { canonical_id: w }\n---\nbody\n");
	writeFileSync(recordPathFor(personaPath), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return personaPath;
};
const regulationOf = (entries: readonly RecordEntry[], declared: Record<string, unknown> = DECLARED): run.Regulation =>
	run.regulationFor(personaWith(entries), declared);

describe("regulation from what the record says and what the persona declared (E126)", () => {
	it("calls one failure evidence of nothing", () => {
		expect(regulationOf([verification(false)]).because).toEqual([]);
	});

	it("tightens what the persona enabled when its deliveries keep failing", () => {
		// 1 of 4 is 0.25, below the 0.3 declared.
		const r = regulationOf([verification(false), verification(false), verification(false), verification(true)]);
		expect(r.handBacks).toBe(2);
		expect(r.approval).toBe("untrusted");
		expect(r.because.join(" ")).toContain("1 of your last 4 checked deliveries passed");
	});

	it("stays out of it at the threshold's edge", () => {
		// 1 of 3 is 0.33, which is NOT below 0.3: the first version of this test used it and expected
		// the regulator to fire, and the regulator was right not to.
		expect(regulationOf([verification(false), verification(false), verification(true)]).because).toEqual([]);
	});

	it("does nothing the persona did not enable", () => {
		const r = regulationOf([verification(false), verification(false), verification(false)], { ...DECLARED, self_regulation: { decisions: {} } });
		expect(r).toEqual({ handBacks: 1, because: [] });
	});

	it("relaxes when the window of five moves past the failures", () => {
		// Chosen so the two readings disagree: over the whole history this is 5 of 25, below the
		// threshold; over the last five it is 5 of 5. The first version used 6 failures and 5 passes,
		// which is 0.45 either way, and the negative control showed it could not tell them apart.
		const r = regulationOf([...Array.from({ length: 20 }, () => verification(false)), ...Array.from({ length: 5 }, () => verification(true))]);
		expect(r.because).toEqual([]);
	});

	it("asks before writing when the gate keeps refusing", () => {
		const r = regulationOf(Array.from({ length: 10 }, (_, i) => call(i < 8)));
		expect(r.approval).toBe("on-request");
		expect(r.because.join(" ")).toContain("refused 8 of your last 10 calls");
	});

	it("says nothing about a persona with no record at all", () => {
		expect(run.regulationFor(join(tmpdir(), "pxs-e126-nowhere", "personaxis.md"), DECLARED)).toEqual({ handBacks: 1, because: [] });
	});
});

describe("the working turn is regulated from the persona's own record (E126)", () => {
	it("tightens the caller's posture and never loosens it", () => {
		const failing = personaWith([verification(false), verification(false)]);
		const facts = { personaPath: failing, frontmatter: DECLARED as Record<string, unknown>, llm: { endpoint: "http://x", model: "m" } };
		const loose = run.agentOptionsFor(facts, { policy: { ...DEFAULT_POLICY, approval: "never" } });
		expect(loose.policy?.approval).toBe("untrusted");
		expect(loose.regulation?.handBacks).toBe(2);

		const healthy = personaWith([verification(true), verification(true)]);
		const calm = run.agentOptionsFor({ ...facts, personaPath: healthy }, { policy: { ...DEFAULT_POLICY, approval: "never" } });
		expect(calm.policy?.approval).toBe("never");
		expect(calm.regulation).toBeUndefined();
	});

	it("never loosens a posture the caller already made stricter", () => {
		// Enough refusals to ask for `on-request`, from a caller already at `untrusted`, which is stricter.
		const refused = personaWith(Array.from({ length: 10 }, (_, i) => call(i < 8)));
		const facts = { personaPath: refused, frontmatter: DECLARED as Record<string, unknown>, llm: { endpoint: "http://x", model: "m" } };
		const strict = run.agentOptionsFor(facts, { policy: { ...DEFAULT_POLICY, approval: "untrusted" } });
		expect(strict.policy?.approval).toBe("untrusted");
		expect(strict.regulation?.because.join(" ")).toContain("refused 8 of your last 10 calls");
	});
});

describe("a regulated turn hands a broken delivery back twice (E126)", () => {
	const BROKEN = '<!doctype html>\n<script>\nconst a = {\n};\n  y: 1\n};\n</script>\n';
	let dir = "";
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const capability = (): ExecutablePolicy =>
		compile({
			persona_version_id: "pv", hash: "h", compiled_at: new Date().toISOString(), ttl_seconds: 3600, deny: [], allow: [], hard_limits: [],
			prohibited_behaviors: [], egress_allowlist: [], sandbox: "workspace-write", approval: "never", gate_rules: [],
		} as CompiledPolicy);

	it("comes back as many times as the regulation says, and no more", async () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-e126b-"));
		const sent: Array<Array<{ role: string; content: string }>> = [];
		const steps = [
			{ tool: "write_file", args: { path: "game.html", content: BROKEN } },
			{ tool: "finish", args: { summary: "done" } },
			{ tool: "finish", args: { summary: "still done" } },
			{ tool: "finish", args: { summary: "leaving it" } },
		];
		let i = 0;
		const fetchImpl = (async (url: string, init?: { body?: string }) => {
			if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
			if (init?.body) sent.push(JSON.parse(init.body).messages ?? []);
			const s = steps[Math.min(i, steps.length - 1)]!;
			i += 1;
			const message = { content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args) } }] };
			return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
		}) as unknown as typeof fetch;
		const policy: Policy = { ...DEFAULT_POLICY, workspaceRoot: dir, approval: "never", sandbox: "workspace-write" };

		await new PersonaAgent({ llm: { endpoint: "http://x/v1", model: "m", fetchImpl }, policy, capability: capability(), regulation: { handBacks: 2, because: ["test"] } }).run("make a game");

		const handed = (sent[sent.length - 1] ?? []).filter((m) => m.role === "user" && m.content.includes("does not work"));
		expect(handed).toHaveLength(2);
		expect(readFileSync(join(dir, "game.html"), "utf8")).toContain("y: 1");
	});

	/**
	 * Measured on 2026-09-23: with "0 of your last 4 checked deliveries passed" in the message of the
	 * moment, `fix-crash` went 6/6 to 0/6 on the same day and the same regulation that, without the
	 * text, stayed 6/6. The levers act; telling a small model it has been failing is what broke it.
	 */
	it("never tells the model it has been failing, and tells the person instead", async () => {
		dir = mkdtempSync(join(tmpdir(), "pxs-e126c-"));
		const sent: string[] = [];
		const fetchImpl = (async (url: string, init?: { body?: string }) => {
			if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
			if (init?.body) sent.push(init.body);
			return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: "{\"summary\":\"done\"}" } }] } }] }) };
		}) as unknown as typeof fetch;
		const heard: string[] = [];
		const { EventBus } = await import("../src/index.js");
		const bus = new EventBus();
		bus.on((e: { type: string; text?: string }) => {
			if (e.type === "agent-think" && e.text) heard.push(e.text);
		});
		const reason = "0 of your last 4 checked deliveries passed, below the 0.3 you declared";
		const policy: Policy = { ...DEFAULT_POLICY, workspaceRoot: dir, approval: "untrusted", sandbox: "workspace-write" };
		await new PersonaAgent({ llm: { endpoint: "http://x/v1", model: "m", fetchImpl }, policy, capability: capability(), bus, regulation: { handBacks: 2, because: [reason] } }).run("fix it");

		expect(sent.join("\n")).not.toContain("checked deliveries passed");
		expect(heard.join("\n")).toContain(reason);
	});
});
