/**
 * Saying something to a persona that is already working.
 *
 * The product requirement that was not unbuilt but impossible. The daemon launched
 * the vendor binary with `stdio: ["ignore", ...]`, so the prompt went in as an
 * argument and the channel back in was closed before the process started. Above that
 * pipe, three layers each carried an intervention as far as the next one: the
 * protocol defined `intervention.deliver`, the socket carried it, and `handle`
 * matched three message types of which it was not one. The frame arrived and nothing
 * happened.
 *
 * These tests are about the two layers this repository owns. The third, the gateway
 * bringing it down to the hub, is written and not deployed: it is `C1` of the v5
 * checklist, a free-tier Worker needing `wrangler login`. Not `W3`, which is the
 * Cloudflare Sandbox and needs a paid plan. They are different blocks and saying
 * so matters, because one of them costs money and this one does not.
 */

import type { WireEvent } from "@personaxis/protocol/workspace";
import { describe, expect, it } from "vitest";

import { AcpSession } from "../src/workspace/acp-session.js";
import type { ChildProcess } from "../src/workspace/agent-process.js";
import { JobReporter } from "../src/workspace/job-reporter.js";

function fakeChild(): ChildProcess {
	return { exitCode: null, signalCode: null, stdin: {}, stdout: {}, kill: () => true } as never;
}

/**
 * A session whose agent answers every turn, recording what it was asked.
 *
 * `onTurn` runs after each prompt lands, which is how a test says "somebody wrote
 * this while the agent was working".
 */
function session(
	options: {
		stopReasons?: string[];
		onTurn?: (turn: number, acp: AcpSession) => void;
		emit?: (body: unknown, author: unknown) => void;
		/** Told who each turn was asked for by. */
		onAsker?: (asker: unknown) => void;
	} = {},
) {
	const emitted: Record<string, unknown>[] = [];
	const skips: string[] = [];
	const prompts: string[] = [];
	const askers: unknown[] = [];
	let turn = 0;

	const acp: AcpSession = new AcpSession({
		command: "claude-agent-acp",
		args: [],
		prompt: "write the brief",
		cwd: "C:/work",
		agentName: "claude-code",
		emit: (body, author) => {
			emitted.push(body as Record<string, unknown>);
			options.emit?.(body, author);
		},
		onSkip: (_reason, detail) => skips.push(detail),
		decide: () => ({ allow: true }),
		// The runner's own observer, which is where the record is written from when
		// the two converge. Mounted here so a test can read who asked for a turn.
		observer: { opened: (request) => options.onAsker?.(request.asker) },
		spawnFn: (() => fakeChild()) as never,
		connectFn: (_child, client) =>
			({
				initialize: async () => ({}),
				newSession: async () => ({ sessionId: "s1" }),
				cancel: async () => {},
				prompt: async (params: { prompt: { text: string }[] }) => {
					prompts.push(params.prompt[0]!.text);
					client.sessionUpdate({
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: `did: ${params.prompt[0]!.text}` },
						},
					});
					turn += 1;
					options.onTurn?.(turn, acp);
					return { stopReason: options.stopReasons?.[turn - 1] ?? "end_turn" };
				},
			}) as never,
	});

	// The asker of each turn, which is the fact that says whether a turn was the job
	// or somebody steering it. Read off the runner through the provider's context.
	return { acp, emitted, skips, prompts, askers };
}

const kinds = (events: Record<string, unknown>[]) => events.map((event) => event["kind"]);

describe("something written while the agent works", () => {
	it("reaches it in the next turn", async () => {
		const { acp, prompts } = session({
			onTurn: (turn, live) => {
				if (turn === 1) live.intervene({ id: "i1", userId: "u_david", body: "use the other tone" });
			},
		});

		await acp.run();

		expect(prompts).toEqual(["write the brief", "use the other tone"]);
	});

	it("is reported applied AFTER the turn it landed in, never when it was queued", async () => {
		// `applied` has to mean the agent saw it. Reported on the queue, a person
		// watching would believe their words landed while they sat in a list.
		const { acp, emitted } = session({
			onTurn: (turn, live) => {
				if (turn === 1) live.intervene({ id: "i1", userId: "u_david", body: "steer" });
			},
		});

		await acp.run();

		const order = kinds(emitted);
		const applied = order.indexOf("intervention.applied");
		expect(applied).toBeGreaterThan(-1);
		// Two turns opened and closed before it was called applied.
		expect(order.slice(0, applied).filter((kind) => kind === "agent.turn.ended")).toHaveLength(2);
		expect(emitted[applied]).toMatchObject({ intervention_id: "i1" });
	});

	it("is signed by the runtime, because delivering is the daemon's act", async () => {
		// Through the real reporter, because the author lives on the envelope and a
		// test reading the body would assert nothing.
		const events: WireEvent[] = [];
		const reporter = new JobReporter({
			jobId: "job_1",
			sink: { emit: (event) => events.push(event), finishJob: () => {} },
		});
		const { acp } = session({
			emit: (body, author) => reporter.reportWire(body as never, author),
			onTurn: (turn, live) => {
				if (turn === 1) live.intervene({ id: "i1", userId: "u_david", body: "steer" });
			},
		});

		await acp.run();

		const applied = events.find((event) => event.kind === "intervention.applied");
		expect(applied?.author).toMatchObject({ kind: "runtime", mechanism: "daemon" });
	});

	it("asks the next turn as the PERSON who wrote it, not as the workspace", async () => {
		// The one fact that makes an intervention an intervention rather than more of
		// the job. A turn that could not say who asked would have to claim the
		// workspace did.
		const askers: unknown[] = [];
		const { acp } = session({
			onAsker: (asker) => askers.push(asker),
			onTurn: (turn, live) => {
				if (turn === 1) live.intervene({ id: "i1", userId: "u_david", body: "steer" });
			},
		});

		await acp.run();
		expect(askers).toEqual([
			{ kind: "component", name: "workspace" },
			{ kind: "human", id: "u_david" },
		]);
	});

	it("takes several, in the order they were written", async () => {
		const { acp, prompts } = session({
			onTurn: (turn, live) => {
				if (turn === 1) {
					live.intervene({ id: "i1", userId: "u", body: "first" });
					live.intervene({ id: "i2", userId: "u", body: "second" });
				}
			},
		});

		await acp.run();
		expect(prompts).toEqual(["write the brief", "first", "second"]);
	});

	it("still ends the session once, after the last one", async () => {
		const { acp, emitted } = session({
			onTurn: (turn, live) => {
				if (turn === 1) live.intervene({ id: "i1", userId: "u", body: "steer" });
			},
		});

		await acp.run();
		expect(kinds(emitted).filter((kind) => kind === "persona.session.ended")).toHaveLength(1);
		expect(kinds(emitted).at(-1)).toBe("persona.session.ended");
	});
});

describe("an agent that has stopped listening", () => {
	it("is not spoken to, and the words are reported as never delivered", async () => {
		// Talking into a failed session would be talking to nothing, and reporting it
		// applied would be worse: somebody would believe it landed.
		const { acp, prompts, emitted, skips } = session({
			stopReasons: ["refusal"],
			onTurn: (turn, live) => {
				if (turn === 1) live.intervene({ id: "i1", userId: "u", body: "please continue" });
			},
		});

		await acp.run();

		expect(prompts).toEqual(["write the brief"]);
		expect(kinds(emitted)).not.toContain("intervention.applied");
		expect(skips.some((detail) => detail.includes("i1") && detail.includes("never delivered"))).toBe(
			true,
		);
	});

	it("keeps going after a turn that merely hit a ceiling", async () => {
		// A budget is a turn that ran and closed. The agent has not gone anywhere.
		const { acp, prompts } = session({
			stopReasons: ["max_tokens"],
			onTurn: (turn, live) => {
				if (turn === 1) live.intervene({ id: "i1", userId: "u", body: "carry on" });
			},
		});

		await acp.run();
		expect(prompts).toEqual(["write the brief", "carry on"]);
	});
});

describe("a session that was stopped", () => {
	it("delivers nothing that was waiting", async () => {
		// Carrying out an instruction after being told to stop.
		const { acp, prompts } = session({
			onTurn: (turn, live) => {
				if (turn === 1) {
					live.intervene({ id: "i1", userId: "u", body: "steer" });
					live.stop();
				}
			},
		});

		await acp.run();
		expect(prompts).toEqual(["write the brief"]);
	});

	it("refuses one that arrives after it ended", async () => {
		const { acp, prompts } = session({});
		await acp.run();
		acp.intervene({ id: "late", userId: "u", body: "too late" });
		expect(prompts).toEqual(["write the brief"]);
	});
});
