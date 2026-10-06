/**
 * What the room sees while an ACP agent works.
 *
 * `host-stream.ts` does this job for an agent whose output we parse off stdout. This
 * does it for one we hold a session with, and the two produce the same wire
 * vocabulary on purpose: the workspace already renders those events, and a bridge
 * that invented its own would mean every screen learning a second way to say the
 * same thing.
 *
 * It is a pure translator with no socket in it, like the one it stands beside, and
 * for the same reason. What crosses this desk is what a person watching a run
 * believes happened, so it is worth being able to test every path of it without a
 * process anywhere.
 *
 * ## The agent's private reasoning does not go on the wire
 *
 * `host-stream.ts` publishes text blocks and skips `thinking` ones as `withheld`,
 * and that is a decision rather than an omission: a shared room shows what a persona
 * did and said, not what it considered and discarded. ACP separates the two on the
 * wire, `agent_message_chunk` against `agent_thought_chunk`, so keeping the same line
 * here is easier than it was there and matters exactly as much.
 *
 * The event that carries the answer is called `agent.thought.streamed`, which reads
 * backwards next to that paragraph. The name is the workspace's and predates this
 * file; renaming it is a change to every consumer of the wire and belongs with the
 * vocabulary work, not here.
 */

import { preview } from "@personaxis/core";
import type { WireEventBody } from "@personaxis/protocol/workspace";

import type { SkipReason } from "./host-stream.js";

/** An ACP `session/update` payload, read defensively: it arrives from another vendor. */
export type AcpUpdate = Record<string, unknown>;

export interface AcpWireOptions {
	/** Told about updates that produced nothing, with the reason. */
	onSkip?: (reason: SkipReason, detail: string) => void;
}

/** A tool call's four states in ACP. The last two are endings. */
const FINISHED = new Set(["completed", "failed"]);

/**
 * Turns a live ACP session into the events a room shows.
 *
 * Stateful in two small ways, and both are about not lying twice. It counts turns,
 * because `agent.turn.started` and `agent.turn.ended` have to agree on a number. And
 * it remembers which tool calls it has already announced, because ACP reports one
 * call several times as it changes state, and a room that showed a request per update
 * would show one action as four.
 */
export class AcpWireTranslator {
	#turn = 0;
	#announced = new Set<string>();
	#finished = new Set<string>();
	#lastText = "";
	readonly #onSkip: ((reason: SkipReason, detail: string) => void) | undefined;

	constructor(options: AcpWireOptions = {}) {
		this.#onSkip = options.onSkip;
	}

	/** What the turn amounted to, for the summary on its ending. */
	get lastText(): string {
		return this.#lastText;
	}

	/** Opens a turn. The number is this translator's, and the ending reuses it. */
	started(): WireEventBody[] {
		this.#turn += 1;
		this.#lastText = "";
		return [{ kind: "agent.turn.started", turn: this.#turn }];
	}

	/**
	 * Closes the turn that `started` opened.
	 *
	 * The summary is what the agent last said, and it is absent rather than empty when
	 * it said nothing: an empty summary renders as a turn that produced a blank, and
	 * no summary renders as a turn with nothing to summarise, which is the true one.
	 */
	ended(): WireEventBody[] {
		const summary = preview(this.#lastText);
		return [{ kind: "agent.turn.ended", turn: this.#turn, ...(summary ? { summary } : {}) }];
	}

	/** One `session/update`, translated. */
	update(update: AcpUpdate): WireEventBody[] {
		const kind = update["sessionUpdate"];

		switch (kind) {
			case "agent_message_chunk": {
				const text = preview(textOf(update["content"]));
				if (!text) {
					this.#onSkip?.("no-events", "agent_message_chunk with no text");
					return [];
				}
				this.#lastText = text;
				return [{ kind: "agent.thought.streamed", text }];
			}

			case "agent_thought_chunk":
				// Deliberately not published. See the header.
				this.#onSkip?.("withheld", "agent_thought_chunk");
				return [];

			case "user_message_chunk":
				// Our own prompt, echoed back so a client can render the transcript it
				// already has. Publishing it would put the question in the room twice.
				this.#onSkip?.("no-events", "user_message_chunk");
				return [];

			case "tool_call":
			case "tool_call_update":
				return this.#toolCall(update, kind === "tool_call");

			case "plan":
			case "plan_update":
			case "plan_removed":
			case "current_mode_update":
			case "available_commands_update":
			case "config_option_update":
			case "session_info_update":
			case "usage_update":
			case "compaction_update":
			case "compaction_summary_chunk":
				// Known, and carrying nothing this room shows. Named one by one rather
				// than swept into the default so that a genuinely unknown word still
				// reports as unknown: a default that absorbs everything is a translator
				// that cannot tell a new protocol feature from a typo.
				this.#onSkip?.("no-events", String(kind));
				return [];

			default:
				this.#onSkip?.("unknown-type", String(kind ?? "(absent)"));
				return [];
		}
	}

	#toolCall(update: AcpUpdate, isFirst: boolean): WireEventBody[] {
		const id = typeof update["toolCallId"] === "string" ? update["toolCallId"] : "";
		if (!id) {
			// A call with no id cannot be gated, correlated or completed. Reporting it
			// would put a row in the room that no verdict and no result can refer to.
			this.#onSkip?.("unknown-type", "tool call without toolCallId");
			return [];
		}

		const events: WireEventBody[] = [];
		const status = update["status"];

		// Announced once, on whichever update first mentions it. `tool_call` normally
		// comes first, but an agent is allowed to send only updates, and a room that
		// waited for the opening it never gets would show a completion for a call it
		// never showed being asked for.
		if (!this.#announced.has(id)) {
			this.#announced.add(id);
			events.push({
				kind: "tool.call.requested",
				call_id: id,
				tool: nameOf(update) ?? "(unnamed)",
				args_preview: preview(update["rawInput"] ?? ""),
			});
			if (!isFirst) this.#onSkip?.("no-events", `tool call ${id} first seen as an update`);
		}

		if (typeof status === "string" && FINISHED.has(status)) {
			// Once. An agent may repeat a terminal update, and a second completion for
			// one call is a second row in the room for one action.
			if (this.#finished.has(id)) {
				this.#onSkip?.("no-events", `tool call ${id} finished twice`);
				return events;
			}
			this.#finished.add(id);
			events.push({
				kind: "tool.call.completed",
				call_id: id,
				ok: status === "completed",
				output_preview: preview(update["rawOutput"] ?? contentOf(update["content"])),
			});
		}

		if (events.length === 0) this.#onSkip?.("no-events", `tool call ${id} still ${String(status)}`);
		return events;
	}
}

/**
 * How a session ended, for the room.
 *
 * Takes our stop reason rather than ACP's, because by the time this is called the
 * translation has already happened and re-deciding it here would be a second opinion
 * about one fact. `budget` and `stopped` count as completed: a turn that ran out of
 * room still ran, and calling it a failure would report a ceiling working as a
 * breakage.
 */
export function sessionEnded(
	stopReason: string,
	failure?: { code: string; message: string },
): WireEventBody {
	const completed = stopReason === "answered" || stopReason === "budget" || stopReason === "stopped";
	if (completed) return { kind: "persona.session.ended", status: "completed" };

	// `interrupted` is somebody's decision, not a fault, and the room says so with a
	// reason rather than by calling it failed with no explanation.
	const status = stopReason === "interrupted" ? "stopped" : "failed";
	const reason = failure ? `${failure.code}: ${failure.message}` : stopReason;
	return { kind: "persona.session.ended", status, reason: preview(reason) };
}

/** A content block carries text under `text`; anything else contributes nothing. */
function textOf(content: unknown): string {
	if (content === null || typeof content !== "object") return "";
	const block = content as { type?: unknown; text?: unknown };
	if (block.type !== "text") return "";
	return typeof block.text === "string" ? block.text : "";
}

/** A tool call's output arrives as blocks; the wire carries a preview of them. */
function contentOf(content: unknown): string {
	if (!Array.isArray(content)) return textOf(content);
	return content
		.map((entry) => {
			if (entry === null || typeof entry !== "object") return "";
			const wrapper = entry as { content?: unknown };
			return textOf(wrapper.content ?? entry);
		})
		.filter((text) => text.length > 0)
		.join(" ");
}

/** What to call the tool in the room: its name, or the title a person would read. */
function nameOf(update: AcpUpdate): string | undefined {
	if (typeof update["name"] === "string" && update["name"]) return update["name"];
	if (typeof update["title"] === "string" && update["title"]) return update["title"];
	return undefined;
}
