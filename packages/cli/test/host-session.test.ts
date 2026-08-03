// Running the host agent for a job the workspace sent.
//
// No real process is spawned. What is being tested is the lifecycle around one, and the
// failures that matter are the ones where the process does something other than finish
// cleanly: it dies, it never starts, it is killed, or it stops talking mid-line.

import { EventEmitter } from "node:events";

import type { WireEmission } from "@personaxis/core";
import { describe, expect, it } from "vitest";

import { HostSession } from "../src/workspace/host-session.js";

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

function session(options: { onChild: (child: FakeChild) => void; timeoutMs?: number }) {
	const emitted: WireEmission[] = [];
	const child = new FakeChild();

	const run = new HostSession({
		command: "claude",
		args: ["-p", "--output-format", "stream-json"],
		prompt: "write the brief",
		cwd: "/work",
		emit: (body) => emitted.push(body),
		timeoutMs: options.timeoutMs,
		spawnFn: (() => {
			// Deferred so the session finishes wiring its listeners first, which is
			// what happens with a real process too.
			setImmediate(() => options.onChild(child));
			return child as never;
		}) as never,
	});

	return { run, emitted, child };
}

const assistantLine = JSON.stringify({
	type: "assistant",
	message: { content: [{ type: "text", text: "on it" }] },
});

describe("a run that finishes", () => {
	it("reports what the agent did", async () => {
		const { run, emitted } = session({
			onChild: (child) => {
				child.stdout.emit("data", `${assistantLine}\n`);
				child.emit("close", 0, null);
			},
		});

		await expect(run.run()).resolves.toBe("completed");
		expect(emitted.map((e) => e.kind)).toContain("agent.thought.streamed");
	});

	it("does not end the session twice when the agent ended it", async () => {
		// A clean run says it is done and THEN exits. Emitting an end on the exit as well
		// would leave the room with two endings and a record that disagrees with itself.
		const { run, emitted } = session({
			onChild: (child) => {
				child.stdout.emit(
					"data",
					`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
				);
				child.emit("close", 0, null);
			},
		});

		await run.run();
		expect(emitted.filter((e) => e.kind === "persona.session.ended")).toHaveLength(1);
	});
});

describe("a run that does not finish cleanly", () => {
	it("ends the session anyway when the agent exits without saying so", async () => {
		// The guarantee that matters. A job left open forever is worse than a failed one:
		// nobody can tell it apart from work still in progress, and the person watching keeps
		// waiting for something that already stopped.
		const { run, emitted } = session({
			onChild: (child) => child.emit("close", 1, null),
		});

		await expect(run.run()).resolves.toBe("failed");
		expect(emitted.at(-1)).toMatchObject({ kind: "persona.session.ended", status: "failed" });
	});

	it("uses what the agent wrote to stderr as the reason", async () => {
		// It is where a host says why it could not start. A failure whose reason went nowhere
		// is a failure nobody can act on.
		const { run, emitted } = session({
			onChild: (child) => {
				child.stderr.emit("data", "Invalid API key");
				child.emit("close", 1, null);
			},
		});

		await run.run();
		expect(emitted.at(-1)).toMatchObject({ reason: expect.stringContaining("Invalid API key") });
	});

	it("ends the session when the agent never starts", async () => {
		const { run, emitted } = session({
			onChild: (child) => child.emit("error", new Error("spawn claude ENOENT")),
		});

		await expect(run.run()).resolves.toBe("failed");
		expect(emitted.at(-1)).toMatchObject({ reason: expect.stringContaining("ENOENT") });
	});

	it("names the signal when the agent is killed from outside", async () => {
		const { run, emitted } = session({
			onChild: (child) => child.emit("close", null, "SIGKILL"),
		});

		await run.run();
		expect(emitted.at(-1)).toMatchObject({ reason: expect.stringContaining("SIGKILL") });
	});

	it("reports a stop as stopped rather than failed", async () => {
		// A person pressing stop did not experience a failure, and a record that says they did
		// misreports what happened to whoever reads it later.
		const { run, emitted, child } = session({
			onChild: (c) => {
				setImmediate(() => c.emit("close", null, "SIGTERM"));
			},
		});

		const promise = run.run();
		setImmediate(() => run.stop());
		await expect(promise).resolves.toBe("stopped");

		expect(child.killed).toBe(true);
		expect(emitted.at(-1)).toMatchObject({ status: "stopped" });
	});

	it("stops a run that overruns its time limit", async () => {
		// A run with no ceiling holds a machine and a budget open until somebody notices, and
		// nobody is noticing at night, which is when the triggers fire.
		const { run, emitted } = session({
			timeoutMs: 5,
			onChild: () => {
				// Never closes on its own.
			},
		});

		await expect(run.run()).resolves.toBe("stopped");
		expect(emitted.at(-1)).toMatchObject({ reason: expect.stringContaining("time limit") });
	});
});

describe("reading the stream", () => {
	it("reassembles a line split across chunks", async () => {
		// stdout arrives in chunks, not lines. Treating a chunk as a line drops every event
		// whose JSON happened to straddle a buffer boundary, which is load-dependent and
		// therefore invisible in testing and common in production.
		const { run, emitted } = session({
			onChild: (child) => {
				const half = Math.floor(assistantLine.length / 2);
				child.stdout.emit("data", assistantLine.slice(0, half));
				child.stdout.emit("data", `${assistantLine.slice(half)}\n`);
				child.emit("close", 0, null);
			},
		});

		await run.run();
		expect(emitted.map((e) => e.kind)).toContain("agent.thought.streamed");
	});

	it("reads a final line that never got its newline", async () => {
		const { run, emitted } = session({
			onChild: (child) => {
				child.stdout.emit("data", assistantLine);
				child.emit("close", 0, null);
			},
		});

		await run.run();
		expect(emitted.map((e) => e.kind)).toContain("agent.thought.streamed");
	});

	it("counts the turns it saw", async () => {
		const { run } = session({
			onChild: (child) => {
				child.stdout.emit("data", `${assistantLine}\n${assistantLine}\n`);
				child.emit("close", 0, null);
			},
		});

		await run.run();
		expect(run.turns).toBe(2);
	});
});

describe("the agent does not outlive the daemon", () => {
	it("leaves no exit listeners behind after a run", async () => {
		// A daemon runs many jobs. One listener per job accumulates until Node warns, and the
		// warning is the visible half of a real leak.
		const before = process.listenerCount("exit");

		for (let i = 0; i < 5; i++) {
			const { run } = session({ onChild: (child) => child.emit("close", 0, null) });
			await run.run();
		}

		expect(process.listenerCount("exit")).toBe(before);
	});
});
