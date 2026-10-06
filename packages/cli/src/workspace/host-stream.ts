/**
 * Turning a host agent's stream into the vocabulary the workspace speaks.
 *
 * The daemon runs the agent the vendor ships. That agent emits its own stream in
 * its own shape, and a room full of people watching a job needs the normalised
 * events instead. This translates one to the other, and nothing else: it opens
 * no process, holds no socket and writes nothing, so the decisions it makes can
 * be tested against a transcript.
 *
 * ## The contract it reads
 *
 * Claude Code with `--output-format stream-json` emits one JSON object per line:
 *
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use"|"thinking",...}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":...}]}}
 *   {"type":"result","subtype":"success","is_error":false,...}
 *
 * That shape is written down here on purpose, in one place, because it belongs
 * to somebody else and will change without asking us. When it does, this file is
 * where it changes and the tests below are what notice.
 *
 * ## The call id is the host's, not ours
 *
 * `tool.call.requested` carries `call_id`, and a gate freezes one specific call
 * by it. The host already names each call (`tool_use_id`), and the hook that
 * refuses a call before it runs is handed that same name by the host. So the
 * wire uses the host's id verbatim.
 *
 * Minting our own would produce two names for one call, and the gate a person
 * approves in the browser would be a different call from the one the hook is
 * holding open on the laptop. That failure is invisible until the day two calls
 * are in flight, and then it approves the wrong one.
 *
 * ## What it deliberately does not emit
 *
 * **Thinking blocks.** They are the model's private reasoning, and a job room is
 * watched by the whole team. Publishing them is a privacy decision nobody made,
 * and it is not this file's to make. They are counted as skipped, not dropped.
 *
 * **Verdicts.** `tool.call.allowed` and `tool.call.blocked` say what the policy
 * decided, and the policy is decided by the hook, before the call runs. Inferring
 * a verdict from a stream that only shows what happened would report an allow for
 * a call nobody checked.
 */

import { preview } from "@personaxis/core";
import type { WireEventBody } from "@personaxis/protocol/workspace";

/** Why a line produced nothing, for the caller that keeps count. */
export type SkipReason =
	/** Not JSON. A partial write, or the host printed something else entirely. */
	| "unparseable"
	/** A message type this translator does not know. */
	| "unknown-type"
	/** A content block deliberately not published. */
	| "withheld"
	/** Known and carries nothing for the wire. */
	| "no-events";

export interface HostStreamOptions {
	/**
	 * Told about every line that produced no events, and why.
	 *
	 * Not optional in spirit: a stream that silently discards what it does not
	 * recognise looks identical to a stream where the agent did nothing, and the
	 * day the vendor renames a message type is the day a job room goes quiet
	 * with nothing in the logs.
	 */
	onSkip?: (reason: SkipReason, detail: string) => void;
}

interface ContentBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
}

interface HostMessage {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: unknown;
	message?: { content?: ContentBlock[] | string };
}

export class HostStreamTranslator {
	private turn = 0;
	private readonly onSkip: HostStreamOptions["onSkip"];

	constructor(options: HostStreamOptions = {}) {
		this.onSkip = options.onSkip;
	}

	/** How many turns the agent has taken. For the session's closing summary. */
	get turns(): number {
		return this.turn;
	}

	/**
	 * Translate one line of the host's stream.
	 *
	 * Returns the events in the order they must reach the room. An empty array is
	 * a normal outcome and always reported through `onSkip`.
	 */
	translate(line: string): WireEventBody[] {
		const trimmed = line.trim();
		if (!trimmed) return [];

		let message: HostMessage;
		try {
			message = JSON.parse(trimmed) as HostMessage;
		} catch {
			// Never guessed at. A half-written line reassembled by hand would put
			// invented content into a record that is hash chained and cannot be
			// corrected afterwards.
			this.onSkip?.("unparseable", trimmed.slice(0, 120));
			return [];
		}

		switch (message.type) {
			case "assistant":
				return this.fromAssistant(message);
			case "user":
				return this.fromUser(message);
			case "result":
				return this.fromResult(message);
			case "system":
				// The session is opened by whoever started the job: it knows the
				// persona, the version and the machine, and this stream knows none
				// of them. Reporting a second start here would give the room two.
				this.onSkip?.("no-events", `system/${message.subtype ?? "?"}`);
				return [];
			default:
				this.onSkip?.("unknown-type", String(message.type ?? "(absent)"));
				return [];
		}
	}

	private fromAssistant(message: HostMessage): WireEventBody[] {
		const blocks = normaliseContent(message.message?.content);
		const events: WireEventBody[] = [];
		this.turn += 1;
		events.push({ kind: "agent.turn.started", turn: this.turn });

		let summary: string | undefined;

		for (const block of blocks) {
			switch (block.type) {
				case "text": {
					const text = preview(block.text ?? "");
					if (!text) break;
					events.push({ kind: "agent.thought.streamed", text });
					// The last text block of a turn is what the turn amounted to.
					summary = text;
					break;
				}
				case "tool_use": {
					if (!block.id) {
						// A call with no id cannot be gated, correlated or completed.
						// Reporting it as a request would put a row in the room that
						// no verdict and no result can ever refer to.
						this.onSkip?.("unknown-type", "tool_use without id");
						break;
					}
					events.push({
						kind: "tool.call.requested",
						call_id: block.id,
						tool: block.name ?? "(unnamed)",
						args_preview: preview(block.input),
					});
					break;
				}
				case "thinking":
					this.onSkip?.("withheld", "thinking");
					break;
				default:
					this.onSkip?.("unknown-type", `content/${block.type ?? "(absent)"}`);
			}
		}

		events.push({ kind: "agent.turn.ended", turn: this.turn, ...(summary ? { summary } : {}) });
		return events;
	}

	private fromUser(message: HostMessage): WireEventBody[] {
		const blocks = normaliseContent(message.message?.content);
		const events: WireEventBody[] = [];

		for (const block of blocks) {
			if (block.type !== "tool_result") {
				this.onSkip?.("unknown-type", `user/${block.type ?? "(absent)"}`);
				continue;
			}
			if (!block.tool_use_id) {
				this.onSkip?.("unknown-type", "tool_result without tool_use_id");
				continue;
			}
			events.push({
				kind: "tool.call.completed",
				call_id: block.tool_use_id,
				// Absent means it worked: the host sets the flag when it did not.
				ok: block.is_error !== true,
				output_preview: preview(block.content),
			});
		}

		if (events.length === 0) this.onSkip?.("no-events", "user message with no tool results");
		return events;
	}

	private fromResult(message: HostMessage): WireEventBody[] {
		// `is_error` is the host's own verdict on its run. A `subtype` of anything
		// other than success is also a failure, and the two are checked separately
		// because the host sets them independently.
		const failed = message.is_error === true || (message.subtype ?? "success") !== "success";
		return [
			{
				kind: "persona.session.ended",
				status: failed ? "failed" : "completed",
				...(failed ? { reason: preview(message.result ?? message.subtype ?? "the agent reported a failure") } : {}),
			},
		];
	}
}

/**
 * The host sends content as an array of blocks, or as a bare string when the
 * message is only text. Both are normal and both have to arrive here as blocks.
 */
function normaliseContent(content: ContentBlock[] | string | undefined): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}
