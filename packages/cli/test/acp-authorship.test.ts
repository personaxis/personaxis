/**
 * Nothing a driven agent does is signed as the persona.
 *
 * The ninth gap the reference study named, and the reason it is a gap rather than a
 * bug is that nothing was wrong at any single line. The wire carried no author, so
 * anything rendering a transcript had exactly one default available and used it: the
 * persona. Every event another vendor's program produced arrived looking like
 * something your persona said, and it looked that way in the record, which is the one
 * artifact a customer is asked to trust.
 *
 * These tests run the real session against a scripted agent, through the real
 * reporter, so what is asserted is what would actually reach a room.
 */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import type { WireEvent } from "@personaxis/protocol/workspace";
import { wireAuthorId } from "@personaxis/protocol/workspace";

import { AcpSession } from "../src/workspace/acp-session.js";
import type { ChildProcess } from "../src/workspace/agent-process.js";
import { HostSession } from "../src/workspace/host-session.js";
import { JobReporter } from "../src/workspace/job-reporter.js";

function fakeChild(): ChildProcess {
	return {
		exitCode: null,
		signalCode: null,
		stdin: {},
		stdout: {},
		kill: () => true,
	} as unknown as ChildProcess;
}

/** A real reporter into a real envelope, so the author is asserted where it ships. */
function reporter() {
	const events: WireEvent[] = [];
	return {
		events,
		instance: new JobReporter({
			jobId: "job_1",
			sink: { emit: (event) => events.push(event), finishJob: () => {} },
		}),
	};
}

/** A full ACP turn: some talk, a tool call, and an ending. */
async function acpRun(agentName = "claude-code") {
	const { events, instance } = reporter();

	const session = new AcpSession({
		command: "claude-agent-acp",
		args: [],
		prompt: "do the thing",
		cwd: "C:/work",
		agentName,
		emit: (body, author) => instance.reportWire(body, author),
		decide: () => ({ allow: true }),
		spawnFn: (() => fakeChild()) as never,
		connectFn: (_child, client) =>
			({
				initialize: async () => ({}),
				newSession: async () => ({ sessionId: "s1" }),
				cancel: async () => {},
				prompt: async () => {
					client.sessionUpdate({
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "I rewrote your config" },
						},
					});
					client.sessionUpdate({
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "c1",
							name: "Write",
							status: "completed",
							rawOutput: "written",
						},
					});
					return { stopReason: "end_turn" };
				},
			}) as never,
	});

	await session.run();
	return events;
}

describe("every event says who produced it", () => {
	it("leaves nothing unsigned", async () => {
		const events = await acpRun();

		expect(events.length).toBeGreaterThan(0);
		const unsigned = events.filter((event) => event.author === undefined).map((e) => e.kind);
		expect(unsigned).toEqual([]);
	});

	it("signs what the agent said and did as the COMPONENT, by the name of the agent", async () => {
		const events = await acpRun("claude-code");
		const byKind = new Map(events.map((event) => [event.kind, event.author]));

		for (const kind of [
			"agent.turn.started",
			"agent.thought.streamed",
			"tool.call.requested",
			"tool.call.completed",
			"agent.turn.ended",
		]) {
			expect(byKind.get(kind), kind).toEqual({ kind: "component", name: "claude-code" });
		}
	});

	it("signs the ending as the RUNTIME, because it is our report about the agent", async () => {
		// Attributing it to the agent would put our verdict in its mouth.
		const events = await acpRun();
		const ending = events.find((event) => event.kind === "persona.session.ended");

		expect(ending?.author).toMatchObject({ kind: "runtime", mechanism: "daemon" });
		// `runtime` requires a reason, because it is the case a reader six months later
		// most needs explained and the one most likely to be used as a shrug.
		expect(String((ending?.author as { reason: string }).reason).length).toBeGreaterThan(0);
	});

	it("NEVER signs anything as the persona", async () => {
		// The invariant, and the whole point. A driven agent's text is another
		// program's text. The persona governs it; it did not write it.
		const events = await acpRun();
		const asPersona = events.filter((event) => event.author?.kind === "persona");

		expect(asPersona.map((event) => event.kind)).toEqual([]);
	});

	it("names the agent it actually drove, not a fixed word", async () => {
		const events = await acpRun("gemini-cli");
		const authored = events
			.map((event) => (event.author ? wireAuthorId(event.author) : "(unsigned)"))
			.filter((id) => id.startsWith("component:"));

		expect(new Set(authored)).toEqual(new Set(["component:gemini-cli"]));
	});
});

describe("the old path signs its events too", () => {
	/**
	 * The stdout-parsing session, driven by a scripted stream.
	 *
	 * Built the way `host-session.test.ts` builds one, because a fake process that
	 * does not behave like the real one produces a test about the fake.
	 */
	class FakeChild extends EventEmitter {
		stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
		stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
		killed = false;

		constructor() {
			super();
			this.stdout.setEncoding = () => {};
			this.stderr.setEncoding = () => {};
		}

		kill(): boolean {
			this.killed = true;
			return true;
		}
	}

	async function hostRun() {
		const { events, instance } = reporter();
		const child = new FakeChild();

		const session = new HostSession({
			command: "claude",
			args: ["-p"],
			prompt: "do it",
			cwd: "C:/work",
			agentName: "claude-code",
			emit: (body, author) => instance.reportWire(body, author),
			spawnFn: (() => {
				// Deferred so the session finishes wiring its listeners first, which is
				// what happens with a real process too.
				setImmediate(() => {
					child.stdout.emit(
						"data",
						`${JSON.stringify({
							type: "assistant",
							message: { content: [{ type: "text", text: "I rewrote your config" }] },
						})}
`,
					);
					child.emit("close", 0, null);
				});
				return child as never;
			}) as never,
		});

		await session.run();
		return events;
	}

	it("signs the vendor's output as the component, never as the persona", async () => {
		const events = await hostRun();

		expect(events.length).toBeGreaterThan(0);
		expect(events.filter((event) => event.author === undefined)).toEqual([]);
		expect(events.filter((event) => event.author?.kind === "persona")).toEqual([]);
		expect(
			events.some(
				(event) =>
					event.kind === "agent.thought.streamed" &&
					wireAuthorId(event.author!) === "component:claude-code",
			),
		).toBe(true);
	});

	it("signs an ending the agent never gave as the runtime", async () => {
		// The daemon reporting about a process that said nothing. Signing it as the
		// agent would be putting our verdict in its mouth.
		const events = await hostRun();
		const ending = events.find((event) => event.kind === "persona.session.ended");
		expect(ending?.author).toMatchObject({ kind: "runtime", mechanism: "daemon" });
	});
});

describe("an unsigned event", () => {
	it("is left unsigned rather than guessed", async () => {
		// Absent has to mean unknown. A reporter that filled the gap would reintroduce
		// exactly the attribution this exists to end, and silently.
		const { events, instance } = reporter();
		instance.reportWire({ kind: "agent.thought.streamed", text: "who said this" });

		expect(events[0]!.author).toBeUndefined();
		expect(Object.keys(events[0]!)).not.toContain("author");
	});
});
