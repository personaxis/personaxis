/**
 * Hold, and let go.
 *
 * A browser has been able to send `pause` and `resume` since the protocol was
 * written. Neither had a road past the room: the gateway wrote an event saying
 * somebody asked, and the agent carried on. So the record showed a person pausing a
 * run that never paused, which is worse than a missing button, because a missing
 * button is visible.
 *
 * What a pause can honestly mean is the subject of most of these. It is not freezing
 * a process somebody else is running.
 */

import { describe, expect, it } from "vitest";

import { AcpSession } from "../src/workspace/acp-session.js";
import type { ChildProcess } from "../src/workspace/agent-process.js";

function fakeChild(): ChildProcess {
	return { exitCode: null, signalCode: null, stdin: {}, stdout: {}, kill: () => true } as never;
}

/** A session whose agent answers every turn, recording what it was asked and when. */
function session(options: { onTurn?: (turn: number, acp: AcpSession) => void } = {}) {
	const prompts: string[] = [];
	let turn = 0;

	const acp: AcpSession = new AcpSession({
		command: "claude-agent-acp",
		args: [],
		prompt: "write the brief",
		cwd: "C:/work",
		agentName: "claude-code",
		emit: () => {},
		decide: () => ({ allow: true }),
		spawnFn: (() => fakeChild()) as never,
		connectFn: (_child, client) =>
			({
				initialize: async () => ({}),
				newSession: async () => ({ sessionId: "s1" }),
				cancel: async () => {},
				prompt: async (params: { prompt: { text: string }[] }) => {
					prompts.push(params.prompt[0]!.text);
					client.sessionUpdate({
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
					});
					turn += 1;
					options.onTurn?.(turn, acp);
					return { stopReason: "end_turn" };
				},
			}) as never,
	});

	return { acp, prompts };
}

/** Lets the microtask queue drain, so a held run has had every chance to proceed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a pause holds before the next turn, and not during one", () => {
	it("lets the turn in flight finish", async () => {
		// The honest limit. The agent is another process, mid-work, and nothing we can
		// send makes it stop between two thoughts. A person who wants the work to stop
		// now is asking for stop, which is a different verb.
		const { acp, prompts } = session({
			onTurn: (turn, live) => {
				if (turn === 1) live.pause();
			},
		});

		const running = acp.run();
		await settle();

		// The first turn ran to the end even though the pause landed inside it.
		expect(prompts).toEqual(["write the brief"]);
		acp.resume();
		await running;
	});

	it("does not begin the next one until somebody says", async () => {
		const { acp, prompts } = session({
			onTurn: (turn, live) => {
				if (turn === 1) {
					live.intervene({ id: "i1", userId: "u", body: "use the other tone" });
					live.pause();
				}
			},
		});

		const running = acp.run();
		await settle();

		// The intervention is queued and the session is holding: one prompt, not two.
		expect(prompts).toEqual(["write the brief"]);
		expect(acp.paused).toBe(true);

		acp.resume();
		await running;
		expect(prompts).toEqual(["write the brief", "use the other tone"]);
	});

	it("says whether it is holding", async () => {
		const { acp } = session({});
		expect(acp.paused).toBe(false);
		acp.pause();
		expect(acp.paused).toBe(true);
		acp.resume();
		expect(acp.paused).toBe(false);
	});
});

describe("pressing a button twice", () => {
	it("is not an error, and the second pause does not make the first unreleasable", async () => {
		const { acp, prompts } = session({
			onTurn: (turn, live) => {
				if (turn === 1) {
					live.intervene({ id: "i1", userId: "u", body: "steer" });
					live.pause();
					live.pause();
				}
			},
		});

		const running = acp.run();
		await settle();
		acp.resume();
		await running;

		expect(prompts).toEqual(["write the brief", "steer"]);
	});

	it("resuming when nobody was holding does nothing", async () => {
		const { acp, prompts } = session({});
		acp.resume();
		await acp.run();
		expect(prompts).toEqual(["write the brief"]);
	});
});

describe("while it is actually holding", () => {
	/**
	 * Runs until the session is inside the hold, and hands it back still held.
	 *
	 * The distinction matters and cost a negative control to find: a test that
	 * pauses and stops in the same breath never reaches the hold at all, because
	 * stopping empties the queue and the loop it would have waited in is not
	 * entered. It passed whether or not the hold could be released, which is a test
	 * that asserts its own setup.
	 */
	async function held() {
		const { acp, prompts } = session({
			onTurn: (turn, live) => {
				if (turn === 1) {
					live.intervene({ id: "i1", userId: "u", body: "steer" });
					live.pause();
				}
			},
		});
		const running = acp.run();
		await settle();
		// One turn done, the second waiting on the hold rather than on the agent.
		expect(prompts).toEqual(["write the brief"]);
		return { acp, prompts, running };
	}

	it("a stop releases it, rather than leaving the run waiting forever", async () => {
		// Stopping means nobody is going to send a resume. A run that kept waiting for
		// one would hold a machine open until somebody noticed, which is the failure
		// the timeout exists for and a worse way to reach it.
		const { acp, prompts, running } = await held();

		acp.stop();

		// Resolves rather than hanging, which is the whole assertion.
		await running;
		// And nothing queued was delivered after the stop.
		expect(prompts).toEqual(["write the brief"]);
	});

	it("a second pause does not strand the hold that is already waiting", async () => {
		// A person pressing the button twice must not produce a run that no resume can
		// release. The release is held in one field, and a pause that cleared it would
		// lose the only handle on a promise nothing else can settle.
		const { acp, prompts, running } = await held();

		acp.pause();
		acp.resume();

		await running;
		expect(prompts).toEqual(["write the brief", "steer"]);
	});
});
