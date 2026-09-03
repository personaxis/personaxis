/**
 * A session with an agent, instead of a shot at one.
 *
 * `host-session.ts` hands a vendor binary a prompt as an argument, reads its stdout
 * and waits. This holds a JSON-RPC session open in both directions, so the turn is a
 * request, an interruption is a notification, and the agent's permission questions
 * come back to us as questions rather than as things that already happened.
 *
 * The two share `agent-process.ts`, and the difference between them is one parameter
 * there: `input: "ignore"` against `input: "pipe"`.
 *
 * ## Nothing is permitted by default, and that is a measurement rather than caution
 *
 * Today the daemon's enforcement is the hook. It is written into the PROJECT's
 * `.claude/settings.json`, which is what `host-adapter.ts` says and what
 * `hookHealth` reads.
 *
 * Measured on 2026-09-03, inside `@agentclientprotocol/claude-agent-acp@0.73.0`: it
 * drives Claude Code through the Agent SDK with `settingSources: ["user"]` in one
 * path and `settingSources: []` in another. **Neither loads project settings.** So an
 * agent driven over ACP does not run our hook, and a bridge that assumed it did would
 * have moved every job onto a road with the enforcement quietly missing, while every
 * screen kept reporting a policy was in force.
 *
 * Which is why `decide` has no default. A caller must say what happens on every
 * permission request, and until `A3` compiles the persona's policy into that answer
 * the daemon says no and names the reason. An inert bridge is a fact somebody can
 * see; a permissive one is a hole nobody can.
 *
 * ## What it guarantees, both about the end
 *
 * **The room always finds out.** If the agent exits without answering, never starts,
 * or the transport dies, the session still ends on the wire. A job that hangs open
 * forever is worse than a failed one: nobody can tell it from work still in progress.
 *
 * **The agent does not outlive the daemon.** An orphan still holds the consented
 * directories and still calls tools, with the thing that refuses calls no longer
 * running. The child is killed on every exit path.
 */

import { run } from "@personaxis/core";
import {
	ACP_PROTOCOL_VERSION,
	AcpTurnCollector,
	acpLoop,
	acpOverStdio,
	type AcpClient,
	type AcpConnection,
	type AcpProvider,
} from "@personaxis/protocol";
import type { WireEventBody } from "@personaxis/protocol/workspace";

import { type ChildProcess, type SpawnFn, startAgent } from "./agent-process.js";
import { AcpWireTranslator, sessionEnded } from "./acp-wire.js";
import type { SkipReason } from "./host-stream.js";

/** How the run ended, for the caller. The room learns it through the wire. */
export type SessionOutcome = "completed" | "failed" | "stopped";

/** What the agent is asking to do, reduced to what a decision needs. */
export interface PermissionAsk {
	readonly toolName: string;
	readonly rawInput: unknown;
}

/** The answer. `deny` carries the reason so the room can say why. */
export type PermissionAnswer = { allow: true } | { allow: false; reason: string };

export interface AcpSessionOptions {
	/** The ACP adapter binary. Named by `host-adapter.ts`, never guessed at here. */
	command: string;
	args: readonly string[];
	prompt: string;
	/** The directory the agent runs in. One of the consented ones. */
	cwd: string;
	/** Where translated events go. Normally `JobReporter.reportWire`. */
	emit: (body: WireEventBody) => void;
	/**
	 * Answers every permission request. **No default, deliberately.**
	 *
	 * See the header: the hook does not reach an agent driven this way, so an omitted
	 * decider would be an agent with nothing deciding for it, and the omission would
	 * look exactly like every other line that was left out because it was fine.
	 */
	decide: (ask: PermissionAsk) => PermissionAnswer | Promise<PermissionAnswer>;
	/** Told about updates that produced nothing, with the reason. */
	onSkip?: (reason: SkipReason, detail: string) => void;
	/** How long the agent may run before it is stopped. */
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	/** Injected for tests. */
	spawnFn?: SpawnFn;
	/** Injected for tests: skips the process and talks to a stream directly. */
	connectFn?: (child: ChildProcess, client: AcpClient) => AcpConnection;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class AcpSession {
	#child: ChildProcess | null = null;
	#provider: AcpProvider | null = null;
	#timer: NodeJS.Timeout | null = null;
	#ended = false;
	readonly #translator: AcpWireTranslator;
	readonly #collector = new AcpTurnCollector();

	constructor(private readonly options: AcpSessionOptions) {
		this.#translator = new AcpWireTranslator({
			...(options.onSkip ? { onSkip: options.onSkip } : {}),
		});
	}

	/**
	 * Run one turn to completion.
	 *
	 * Resolves rather than rejects on a failed run: a failure is an outcome the room
	 * needs reported, not an exception for the caller to translate a second time.
	 */
	async run(): Promise<SessionOutcome> {
		try {
			const connection = this.#connect();
			await connection.initialize({
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
			});
			const session = await connection.newSession({ cwd: this.options.cwd, mcpServers: [] });

			const provider = acpLoop({
				connection,
				sessionId: session.sessionId,
				collector: this.#collector,
				agentName: "claude-code",
			});
			this.#provider = provider;

			this.#arm();

			// The runner closes every turn on every path, which is why this file does
			// not. A provider that helped would be a second place a turn could end.
			const runner = new run.TurnRunner({ provider });

			for (const event of this.#translator.started()) this.options.emit(event);
			const outcome = await runner.run({
				turn: session.sessionId,
				prompt: this.options.prompt,
				// A program drove this turn, and neither `human` nor `persona` is true
				// of a job a workspace sent. `component` is the third kind, and it
				// exists because the other two were both lies in the one field the
				// record rests on being honest.
				asker: { kind: "component", name: "workspace" },
			});
			for (const event of this.#translator.ended()) this.options.emit(event);

			return this.#finish(outcome.stopReason, outcome.failure);
		} catch (error) {
			// Starting failed: the binary is not there, the working directory is
			// invalid, or the handshake never completed. All of them still have to end
			// the session or the room waits forever.
			const message = error instanceof Error ? error.message : String(error);
			return this.#finish("failed", { code: "acp_start", message });
		} finally {
			this.#stopChild();
		}
	}

	/**
	 * Ends the turn in progress, saying which of our reasons it was.
	 *
	 * The single stop route `A6` asks for, as far as this file can provide it: one
	 * call, one cancel on the wire, and a reason that survives into the record.
	 */
	stop(cause: "interrupted" | "stopped" = "interrupted"): void {
		this.#provider?.stop(cause);
	}

	#connect(): AcpConnection {
		const child = startAgent({
			command: this.options.command,
			args: this.options.args,
			cwd: this.options.cwd,
			// The pipe. See `agent-process.ts`: this word is the whole of phase 11.
			input: "pipe",
			...(this.options.env ? { env: this.options.env } : {}),
			...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {}),
		});
		this.#child = child;

		if (this.options.connectFn) return this.options.connectFn(child, this.#client());
		if (!child.stdin || !child.stdout) {
			throw new Error("the agent started without the pipes an ACP session needs");
		}

		return acpOverStdio({ stdin: child.stdin, stdout: child.stdout, client: this.#client() });
	}

	/**
	 * The two methods ACP requires of a client, and no more.
	 *
	 * Every optional one is left off on purpose. `readTextFile` and `writeTextFile`
	 * would let the agent reach the filesystem THROUGH US, which would route around
	 * the consented directory this session was so careful to establish. An agent that
	 * wants a file can open it itself, where the daemon's boundary already applies.
	 */
	#client(): AcpClient {
		return {
			requestPermission: async (params) => {
				const call = (params["toolCall"] ?? {}) as { title?: unknown; rawInput?: unknown };
				const answer = await this.options.decide({
					toolName: typeof call.title === "string" ? call.title : "(unnamed)",
					rawInput: call.rawInput,
				});

				if (answer.allow) {
					const options = Array.isArray(params["options"]) ? params["options"] : [];
					const chosen = options.find(
						(option: { kind?: unknown; optionId?: unknown }) =>
							option.kind === "allow_once" || option.kind === "allow_always",
					) as { optionId?: unknown } | undefined;
					// An allow with nothing to select is a refusal in practice, and saying
					// so is better than sending an option id the agent never offered.
					if (typeof chosen?.optionId === "string") {
						return { outcome: { outcome: "selected", optionId: chosen.optionId } };
					}
				}

				// `cancelled` is ACP's word for a permission request that was not granted.
				// The reason goes to the room rather than on the wire, because the
				// protocol has nowhere to put it and the person watching needs it.
				this.options.onSkip?.("withheld", answer.allow ? "no allow option offered" : answer.reason);
				return { outcome: { outcome: "cancelled" } };
			},
			sessionUpdate: (params) => {
				// Both, and in this order. The collector builds the turn's answer; the
				// translator builds what the room sees. They read the same notification
				// and answer different questions about it.
				this.#collector.sessionUpdate(params);
				for (const event of this.#translator.update(params.update)) this.options.emit(event);
			},
		};
	}

	#arm(): void {
		const ms = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#timer = setTimeout(() => {
			// A run with no ceiling can hold a machine and a budget open until somebody
			// notices, and noticing is what nobody does at night, which is when the
			// triggers fire.
			this.stop("stopped");
		}, ms);
		this.#timer.unref?.();
	}

	#finish(stopReason: string, failure?: { code: string; message: string }): SessionOutcome {
		if (this.#ended) return "failed";
		this.#ended = true;
		const event = sessionEnded(stopReason, failure);
		this.options.emit(event);
		// Read from the reason rather than from the event just built: one function
		// decides what an ending is called, and asking it twice is how two answers
		// to one question start to disagree.
		if (stopReason === "answered" || stopReason === "budget" || stopReason === "stopped") {
			return "completed";
		}
		return stopReason === "interrupted" ? "stopped" : "failed";
	}

	#stopChild(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		const child = this.#child;
		this.#child = null;
		if (child && child.exitCode === null && child.signalCode === null) child.kill();
	}
}
