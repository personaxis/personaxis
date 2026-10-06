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
import type { WireAuthor, WireEventBody } from "@personaxis/protocol/workspace";

import { type ChildProcess, type SpawnFn, startAgent } from "./agent-process.js";
import { AcpWireTranslator, sessionEnded } from "./acp-wire.js";
import type { SkipReason } from "./host-stream.js";

/** How the run ended, for the caller. The room learns it through the wire. */
export type SessionOutcome = "completed" | "failed" | "stopped";

/** What the agent is asking to do, reduced to what a decision needs. */
export interface PermissionAsk {
	/**
	 * The tool's NAME, never the title.
	 *
	 * A title is written for a person ("Reading a.ts") and a policy is written about a
	 * tool ("Read"). Handing a gate the title gives it a string no rule can match, so
	 * it refuses everything while appearing to work, which is the worst shape a
	 * security check can have: correct-looking and inert.
	 */
	readonly toolName: string;
	readonly rawInput: unknown;
	/** So a verdict can be joined to the call it judged. */
	readonly callId?: string;
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
	/**
	 * Where translated events go, with who produced each one.
	 *
	 * Two authors come out of this file and the difference is the whole of `A4`.
	 * What the agent said, reasoned and called is the COMPONENT's: it is another
	 * vendor's program, and the persona governs it rather than speaks through it.
	 * What the daemon decided, which is that a session began and how it ended, is
	 * the RUNTIME's. **Neither is ever the persona**, and a record that said so
	 * would be quoting somebody else's program as the thing your persona wrote.
	 */
	emit: (body: WireEventBody, author: WireAuthor) => void;
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
	/** Names the agent in the record: `claude-code`, `gemini-cli`, and so on. */
	agentName?: string;
	/**
	 * Protocol metadata for every turn of this session.
	 *
	 * Where the step travels as data. It rides on the request rather than being
	 * said in the prompt, so an agent built against us can read which step it is
	 * on without parsing English, and the sentence in the prompt is generated
	 * from the same object rather than written beside it.
	 */
	meta?: Record<string, unknown>;
	/**
	 * Told when each turn opens and closes.
	 *
	 * The runner's own seam, and the place the record will be written from when
	 * the two records converge in `L1`. It is here now rather than later because
	 * the turn already carries the fact that matters and nothing was reading it:
	 * `asker` says whether a turn was the job or a person steering it, and until
	 * something is handed the request, that distinction exists and reaches nobody.
	 */
	observer?: run.TurnObserver;
	/** Injected for tests. */
	spawnFn?: SpawnFn;
	/** Injected for tests: skips the process and talks to a stream directly. */
	connectFn?: (child: ChildProcess, client: AcpClient) => AcpConnection;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The endings after which the agent is still there to be spoken to.
 *
 * `answered` obviously. `budget` and `stopped` too: both are turns that ran and
 * closed, and a session whose last turn hit a ceiling has not gone anywhere. The
 * ones missing are the ones where talking would be talking to nothing: a failure,
 * a refusal, an interruption somebody asked for, and an empty turn.
 *
 * Getting this wrong in the generous direction is the expensive way: the room
 * would report an intervention applied to an agent that had already stopped
 * listening, and a person would believe their words landed.
 */
const KEEPS_LISTENING = new Set(["answered", "budget", "stopped"]);

export class AcpSession {
	#child: ChildProcess | null = null;
	#provider: AcpProvider | null = null;
	#timer: NodeJS.Timeout | null = null;
	#ended = false;
	readonly #translator: AcpWireTranslator;
	readonly #collector = new AcpTurnCollector();
	/**
	 * What people said while the agent was working, waiting for a turn to say it in.
	 *
	 * Not delivered mid-turn, and that is the protocol rather than a shortcut: ACP
	 * runs one prompt turn at a time and a second prompt sent into a live one is
	 * not something an agent is required to understand.
	 */
	readonly #waiting: { id: string; userId: string; body: string }[] = [];
	/**
	 * Held, and what releases it.
	 *
	 * A pause cannot freeze a turn. The agent is another process, mid-work, and
	 * nothing we can send makes it stop between two thoughts; ACP's own answer to
	 * that is `session/cancel`, which ends the turn rather than suspending it.
	 *
	 * So what a pause honestly means here is: **finish this turn, and do not begin
	 * the next one until somebody says.** That is a real thing to want, and with
	 * the intervention queue beside it it is the whole steering loop: hold, say
	 * what you meant, let go.
	 *
	 * A person who wants the work to stop NOW is asking for stop, which is a
	 * different verb with a different answer, and conflating them would give
	 * somebody a pause that quietly killed their run.
	 */
	#paused = false;
	#released: (() => void) | null = null;
	/** Who the agent is, in the record. Never `persona:self`. */
	readonly #agent: WireAuthor;

	constructor(private readonly options: AcpSessionOptions) {
		this.#agent = { kind: "component", name: options.agentName ?? "agent" };
		this.#translator = new AcpWireTranslator({
			...(options.onSkip ? { onSkip: options.onSkip } : {}),
		});
	}

	/**
	 * Run the job, and then whatever anybody said to it while it was running.
	 *
	 * Resolves rather than rejects on a failed run: a failure is an outcome the room
	 * needs reported, not an exception for the caller to translate a second time.
	 *
	 * More than one turn, because that is what an intervention needs to exist. ACP
	 * runs one prompt turn at a time, so something written mid-turn cannot interrupt
	 * the current one; what it can do is be the next one, on a session that stayed
	 * open. That is the difference between steering a persona and watching it, and it
	 * is the thing the old path made impossible rather than left unbuilt.
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
				agentName: this.options.agentName ?? "agent",
				...(this.options.meta === undefined ? {} : { meta: this.options.meta }),
			});
			this.#provider = provider;

			this.#arm();

			// The runner closes every turn on every path, which is why this file does
			// not. A provider that helped would be a second place a turn could end.
			const runner = new run.TurnRunner({
				provider,
				...(this.options.observer ? { observer: this.options.observer } : {}),
			});

			// The job's own turn, and then one for each thing somebody wrote while it
			// was running.
			let outcome = await this.#turn(runner, session.sessionId, this.options.prompt, {
				kind: "component",
				name: "workspace",
			});

			while (this.#waiting.length > 0 && KEEPS_LISTENING.has(outcome.stopReason)) {
				// Between turns, which is the only place a pause can be honoured.
				await this.#hold();
				// A stop while held empties the queue, so there may be nothing left.
				const next = this.#waiting.shift();
				if (!next) break;
				// A person asked, so the turn says a person asked. Attributing an
				// intervention to the workspace would lose the only fact that makes it
				// an intervention rather than more of the job.
				outcome = await this.#turn(runner, session.sessionId, next.body, {
					kind: "human",
					id: next.userId,
				});
				// Reported after the turn it was delivered in, never when it was queued.
				// `applied` has to mean the agent saw it, or a person watching believes
				// something landed that is still sitting in a list.
				this.options.emit(
					{ kind: "intervention.applied", intervention_id: next.id },
					{
						kind: "runtime",
						mechanism: "daemon",
						reason: "the daemon delivered what somebody wrote",
					},
				);
			}

			// Anything still queued when the agent stopped listening is said so, rather
			// than dropped. A person who steered into a run that had already failed
			// needs to know their words went nowhere.
			for (const abandoned of this.#waiting) {
				this.options.onSkip?.(
					"no-events",
					`intervention ${abandoned.id} never delivered: the session ended ${outcome.stopReason}`,
				);
			}
			this.#waiting.length = 0;

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

	/** Waits while paused. Returns at once when nobody is holding. */
	async #hold(): Promise<void> {
		if (!this.#paused) return;
		await new Promise<void>((release) => {
			this.#released = release;
		});
	}

	/** One turn, opened and closed on the wire, with who asked for it. */
	async #turn(
		runner: run.TurnRunner,
		sessionId: string,
		prompt: string,
		asker: { kind: "component"; name: string } | { kind: "human"; id: string },
	): Promise<run.TurnOutcome> {
		for (const event of this.#translator.started()) this.options.emit(event, this.#agent);
		const outcome = await runner.run({ turn: sessionId, prompt, asker });
		for (const event of this.#translator.ended()) this.options.emit(event, this.#agent);
		return outcome;
	}

	/**
	 * Ends the turn in progress, saying which of our reasons it was.
	 *
	 * The single stop route `A6` asks for, as far as this file can provide it: one
	 * call, one cancel on the wire, and a reason that survives into the record.
	 */
	stop(cause: "interrupted" | "stopped" = "interrupted"): void {
		this.#provider?.stop(cause);
		// Nothing queued survives a stop. Delivering somebody's words into a session
		// that was deliberately ended would be the daemon carrying out an instruction
		// after being told to stop.
		this.#waiting.length = 0;
		// And a stop releases a hold, or the run would sit forever waiting for a
		// resume that stopping means nobody is going to send.
		this.resume();
	}

	/**
	 * Somebody said something to a persona that is already working.
	 *
	 * The thing that was impossible. The old path launches the agent with its input
	 * closed, so no amount of screen above it could have delivered this: every layer
	 * that would have carried it ended at a pipe that was never opened.
	 *
	 * Queued rather than delivered, even between turns, so a caller does not have to
	 * know whether the agent happens to be mid-turn to know what becomes of what it
	 * just said. It lands in the next turn, and the room hears when it did.
	 */
	/**
	 * Finish the turn in flight, then hold.
	 *
	 * Idempotent, because a person pressing a button twice is not an error and a
	 * second pause that reset the wait would make the first one unreleasable.
	 */
	pause(): void {
		this.#paused = true;
	}

	/** Let go. Does nothing if nobody was holding, which is not an error either. */
	resume(): void {
		this.#paused = false;
		const release = this.#released;
		this.#released = null;
		release?.();
	}

	/** Whether it is holding, for a caller that wants to say so. */
	get paused(): boolean {
		return this.#paused;
	}

	intervene(intervention: { id: string; userId: string; body: string }): void {
		if (this.#ended) return;
		this.#waiting.push(intervention);
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
				const call = (params["toolCall"] ?? {}) as {
					name?: unknown;
					title?: unknown;
					rawInput?: unknown;
					toolCallId?: unknown;
				};
				// `name` first. The title is the human sentence and falling back to it is
				// better than refusing for want of a name, but a gate judging a title is
				// a gate that matches no rule.
				const name =
					typeof call.name === "string" && call.name
						? call.name
						: typeof call.title === "string" && call.title
							? call.title
							: "(unnamed)";
				const answer = await this.options.decide({
					toolName: name,
					rawInput: call.rawInput,
					...(typeof call.toolCallId === "string" ? { callId: call.toolCallId } : {}),
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
				for (const event of this.#translator.update(params.update))
					this.options.emit(event, this.#agent);
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
		// The runtime's, not the agent's. How a session ended is the daemon's report
		// ABOUT the agent, and attributing it to the agent would put our own verdict
		// in its mouth.
		this.options.emit(event, {
			kind: "runtime",
			mechanism: "daemon",
			reason: `the session ended ${stopReason}`,
		});
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
