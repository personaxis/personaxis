/**
 * The binary an editor actually launches.
 *
 * Everything else about this direction is tested in memory: the framing, the agent's
 * answers, the translations. None of that says the process exists, starts, and speaks
 * on its stdio, and that is the only part an editor can see.
 *
 * So this one spawns it. No model is configured here and none is needed: `initialize`
 * is answered before any persona is opened, which is itself the thing being checked.
 * A build that made the handshake depend on a model would work on the machine of
 * whoever wrote it and fail on every editor that tried it.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "acp-bin.js");

/** How long a handshake may take. Generous: the point is that it answers at all. */
const HANDSHAKE_MS = 20_000;

/**
 * Sends one JSON-RPC request on stdin and reads the first reply off stdout.
 *
 * Newline-delimited JSON, written by hand rather than through the SDK, because what
 * is being checked is that the process speaks the wire an editor will speak to it and
 * not that our own client can talk to our own agent.
 */
function ask(request: unknown): Promise<{ reply: unknown; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let stderr = "";
		let settled = false;

		const finish = (reply: unknown) => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({ reply, stderr });
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
			const line = out.split("\n").find((candidate) => candidate.trim().length > 0);
			if (!line) return;
			try {
				finish(JSON.parse(line));
			} catch {
				// A partial line. Wait for the rest.
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", () => {
			if (!settled) {
				settled = true;
				resolve({ reply: null, stderr });
			}
		});

		child.stdin.write(`${JSON.stringify(request)}\n`);
	});
}

describe("an editor launching personaxis-acp", () => {
	it(
		"answers the handshake, on stdio, as a process",
		async () => {
			const { reply, stderr } = await ask({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: 1, clientCapabilities: {} },
			});

			expect(stderr, "the agent should not be complaining on stderr").not.toContain("Error");
			const message = reply as { id?: number; result?: Record<string, unknown> };
			expect(message?.id).toBe(1);
			expect(message?.result).toBeTruthy();
		},
		HANDSHAKE_MS,
	);

	it(
		"says what it is and what it cannot do, before any persona is opened",
		async () => {
			// A handshake that needed a model would work on the machine of whoever wrote
			// it and fail on every editor that tried it.
			const { reply } = await ask({
				jsonrpc: "2.0",
				id: 7,
				method: "initialize",
				params: { protocolVersion: 1, clientCapabilities: {} },
			});

			const result = (reply as { result: Record<string, unknown> }).result;
			expect((result["agentInfo"] as { name?: string })?.name).toBe("personaxis");
			expect((result["agentCapabilities"] as { loadSession?: boolean })?.loadSession).toBe(false);
			expect(typeof result["protocolVersion"]).toBe("number");
		},
		HANDSHAKE_MS,
	);
});
