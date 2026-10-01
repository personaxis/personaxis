/**
 * Pax's own process, started once and spoken to over stdin and stdout, one JSON object per line.
 *
 * The judge (E157) and the output classifier (E159) used to import Pax's code into this process from a path named by
 * `PERSONAXIS_PAX_DIR`, which the `untrusted-boundary` gate refuses, rightly: a path read from the environment and
 * imported is the way to run somebody else's code with this process's files, network and credentials. So the models
 * run where a third-party MCP server runs, in a process of their own, started with this process's own Node and Pax's
 * `serve.mjs`. It also keeps the models, about 2.3 GB between them, out of the engine's memory.
 *
 * The child is unreferenced, so it never keeps the engine alive; it ends when its stdin closes, which happens when
 * this process ends.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** What Pax's process answers to a request, beyond the id that pairs it with the question. */
export type PaxReply = { readonly ok: true; readonly engine: string; readonly [key: string]: unknown } | { readonly ok: false; readonly error: string };

/** A running Pax process. */
export interface PaxProcess {
	request(message: Readonly<Record<string, unknown>>): Promise<PaxReply>;
}

function start(dir: string): PaxProcess {
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [join(dir, "serve.mjs")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const waiting = new Map<number, (reply: PaxReply) => void>();
	let next = 1;
	let gone: string | undefined;
	const fail = (why: string): void => {
		gone ??= why;
		for (const resolve of waiting.values()) resolve({ ok: false, error: gone });
		waiting.clear();
	};
	createInterface({ input: child.stdout }).on("line", (line) => {
		let reply: { id?: number } & PaxReply;
		try {
			reply = JSON.parse(line) as { id?: number } & PaxReply;
		} catch {
			return;
		}
		const resolve = reply.id === undefined ? undefined : waiting.get(reply.id);
		if (!resolve || reply.id === undefined) return;
		waiting.delete(reply.id);
		resolve(reply);
	});
	// What the models print while loading is theirs, not the persona's terminal's.
	child.stderr.resume();
	child.on("error", (error) => fail(`Pax's process could not start: ${error.message}`));
	child.on("exit", (code) => fail(`Pax's process ended (exit ${code ?? "signal"})`));
	// Held only while an answer is awaited. Unreferenced always, this process would end in the middle of waiting for
	// one, since nothing else keeps its event loop alive then (measured: exit 13, "unsettled top-level await");
	// referenced always, it would never end on its own.
	const streams = [child.stdin, child.stdout, child.stderr] as unknown as { ref?: () => void; unref?: () => void }[];
	const hold = (on: boolean): void => {
		if (on) child.ref();
		else child.unref();
		for (const stream of streams) (on ? stream.ref : stream.unref)?.call(stream);
	};
	hold(false);
	return {
		request(message) {
			if (gone !== undefined) return Promise.resolve({ ok: false, error: gone });
			const id = next++;
			return new Promise<PaxReply>((resolve) => {
				if (waiting.size === 0) hold(true);
				waiting.set(id, (reply) => {
					if (waiting.size === 0) hold(false);
					resolve(reply);
				});
				child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
			});
		},
	};
}

let running: { readonly dir: string; readonly process: PaxProcess } | undefined;

/**
 * Pax's process for `PERSONAXIS_PAX_DIR`, started on first use and shared by everything in this process that asks.
 * Undefined when the variable is not set or the directory has no `serve.mjs`.
 */
export function paxProcess(): PaxProcess | undefined {
	const dir = process.env.PERSONAXIS_PAX_DIR;
	if (!dir || !existsSync(join(dir, "serve.mjs"))) return undefined;
	if (running?.dir !== dir) running = { dir, process: start(dir) };
	return running.process;
}
