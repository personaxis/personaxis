/**
 * Reading a tool call that arrived as prose.
 *
 * The native path asks for `tools` and reads `message.tool_calls`, and against a
 * hosted endpoint that is the end of it. Against an open model it is not, and the
 * failure is silent, which is what makes it worth a file.
 *
 * A model trained to emit `<tool_call>{"name": "read_file", ...}</tool_call>` will emit
 * exactly that, as CONTENT, whenever the server in front of it is not configured with
 * the matching parser. vLLM ships around two dozen of these parsers for precisely this
 * reason, and a deployment that forgot one produces a reply where `tool_calls` is empty
 * and the text is a tool call. The loop then believes the model spoke instead of
 * acting: no tool runs, no gate fires, no error appears, and the run wanders until the
 * step budget stops it. That is the real risk of an open model, and it is not the
 * endpoint.
 *
 * ## What this is allowed to do, and what it must not
 *
 * It reads. It never repairs semantics: a call whose name is not in the catalogue is
 * not renamed to the nearest one, because guessing which tool a model meant is how you
 * run the wrong one. `repairToolArgs` already salvages almost-JSON and stays where it
 * is; this is a layer above, about the envelope rather than the arguments.
 *
 * It runs ONLY when the native path came back with no calls. A model that answered
 * properly is never re-read, so nothing here can turn a well-formed reply into a
 * different one.
 *
 * ## The injection question, asked before somebody else asks it
 *
 * Recognising a call in prose does widen the surface: a file containing
 * `<tool_call>{"name":"run_command",...}</tool_call>`, read by the persona and echoed
 * back, would be read here as a call. That is indirect prompt injection, and the
 * answer is the same as for a native call: it is a PROPOSAL, and it goes through the
 * same gate as everything else, with the persona's policy and its envelope. Since E2
 * that gate runs on this loop too.
 *
 * What this file adds on top is refusing to invent. An extracted call whose name is
 * not offered in this turn's catalogue is dropped rather than passed on, because the
 * only calls worth reading out of prose are the ones the model was actually offered.
 */

import type { ToolCall } from "../tool-calling.js";
import { repairToolArgs } from "../tool-repair.js";

/** A model family's way of writing a call, and how to read it. */
export interface Dialect {
	/** The family, as the ecosystem names it. Reported so a deployment can be fixed. */
	readonly name: string;
	/** Cheap test: is this dialect worth trying on this text at all. */
	readonly looksLike: RegExp;
	/** Pulls out whatever calls it can find. Returns nothing when it finds none. */
	read(text: string): ReadCall[];
}

/** One call as a dialect read it, before anything has been validated. */
export interface ReadCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
	/** The exact span in the text, so it can be removed from what a person reads. */
	readonly span: string;
}

/** Parses arguments however they arrived, reusing the repair layer. */
function argsOf(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw !== "string") return {};
	const repaired = repairToolArgs(raw);
	return repaired.ok && repaired.value ? repaired.value : {};
}

/**
 * The name and arguments out of one JSON object, whatever the family called them.
 *
 * `arguments` and `parameters` both appear in the wild, and a reader that knew only
 * one would silently produce a call with no arguments: the tool runs, with defaults,
 * on a request that specified something else.
 */
function fromObject(value: unknown, span: string): ReadCall[] {
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name : undefined;
	if (!name) return [];
	return [{ name, args: argsOf(record.arguments ?? record.parameters ?? {}), span }];
}

/** Every JSON object inside these delimiters, read as a call. */
function delimited(text: string, pattern: RegExp): ReadCall[] {
	const found: ReadCall[] = [];
	for (const match of text.matchAll(pattern)) {
		const body = (match[1] ?? "").trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			const repaired = repairToolArgs(body);
			if (!repaired.ok) continue;
			parsed = repaired.value;
		}
		const items = Array.isArray(parsed) ? parsed : [parsed];
		for (const item of items) found.push(...fromObject(item, match[0]));
	}
	return found;
}

/**
 * The dialects, in the order they are tried.
 *
 * Ordered by how distinctive the marker is rather than by popularity, because a weak
 * marker matching first would claim text that belongs to a stronger one. Every entry
 * exists because a real family emits it, and the conformance test carries one real
 * sample per entry: a parser written from a description rather than from output is a
 * parser that handles the description.
 */
export const DIALECTS: readonly Dialect[] = [
	{
		// Hermes, Qwen, NousResearch, and the default of several vLLM deployments.
		name: "hermes",
		looksLike: /<tool_call>/i,
		read: (text) => delimited(text, /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi),
	},
	{
		// Mistral. The list is one JSON array after the marker, to the end of the line
		// or the text, whichever comes first.
		name: "mistral",
		looksLike: /\[TOOL_CALLS\]/,
		read: (text) => delimited(text, /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/g),
	},
	{
		// Llama 3.1 and 3.2. The tag is followed by a bare object, and `parameters`
		// rather than `arguments` is the usual spelling here.
		name: "llama",
		looksLike: /<\|python_tag\|>/,
		read: (text) => delimited(text, /<\|python_tag\|>\s*(\{[\s\S]*?\})\s*(?:<\|eom_id\|>|$)/g),
	},
	{
		// DeepSeek. The separators are full-width characters, which is exactly the kind
		// of detail a parser written from memory gets wrong: these are U+FF5C and
		// U+2581, not the ASCII pipe and underscore they resemble.
		name: "deepseek",
		looksLike: /<｜tool▁calls▁begin｜>/,
		read: (text) => {
			const found: ReadCall[] = [];
			const pattern =
				/<｜tool▁call▁begin｜>(?:function)?<｜tool▁sep｜>([^\n]+)\n+```json\s*([\s\S]*?)\s*```/g;
			for (const match of text.matchAll(pattern)) {
				const name = (match[1] ?? "").trim();
				if (!name) continue;
				found.push({ name, args: argsOf(match[2] ?? "{}"), span: match[0] });
			}
			return found;
		},
	},
	{
		// The XML shape several models were trained on, Anthropic's among them. Read
		// last because its marker is the least distinctive.
		name: "xml",
		looksLike: /<invoke\b/i,
		read: (text) => {
			const found: ReadCall[] = [];
			for (const call of text.matchAll(/<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi)) {
				const args: Record<string, unknown> = {};
				for (const param of (call[2] ?? "").matchAll(
					/<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi,
				)) {
					// Values arrive as text. A number written as text is still a number to
					// the schema validator downstream, so nothing is coerced here: guessing
					// a type is how a path called "42" becomes the integer 42.
					args[param[1]!] = param[2] ?? "";
				}
				found.push({ name: call[1]!, args, span: call[0] });
			}
			return found;
		},
	},
];

/** What a dialect read out of one reply. */
export interface DialectReading {
	/** The family that matched, for a deployment that needs its parser configured. */
	readonly dialect: string;
	readonly calls: readonly ToolCall[];
	/** The reply with the call syntax removed, which is what a person should read. */
	readonly text: string;
	/** Names that were read but are not on offer this turn, dropped rather than run. */
	readonly unknown: readonly string[];
}

/**
 * Reads tool calls out of an assistant's prose, when there are any.
 *
 * `offered` is not optional and not advisory. A name that was not offered this turn is
 * dropped: the model cannot have been asked for it, so reading it out of text means
 * either a hallucination or something that arrived in the context from outside, and
 * neither is a call worth making. The dropped names are reported rather than swallowed,
 * because a persona whose catalogue is missing a tool it keeps reaching for is a fact
 * somebody wants.
 */
export function readDialect(
	text: string,
	offered: readonly string[],
	mintId: (index: number) => string = (index) => `dialect_${index}`,
): DialectReading | undefined {
	if (!text) return undefined;

	for (const dialect of DIALECTS) {
		if (!dialect.looksLike.test(text)) continue;
		const read = dialect.read(text);
		if (read.length === 0) continue;

		const known = read.filter((call) => offered.includes(call.name));
		const unknown = read.filter((call) => !offered.includes(call.name)).map((call) => call.name);
		if (known.length === 0) {
			// Matched the shape and named nothing we offered. Reported, not acted on: the
			// deployment is probably missing a parser AND the model is naming tools it
			// does not have, and both are worth knowing.
			return { dialect: dialect.name, calls: [], text, unknown };
		}

		// The syntax comes out of the visible text. Leaving it in shows a person the raw
		// markup of a call that is about to run, which reads as the persona having lost
		// its footing rather than as the runtime doing its job.
		let visible = text;
		for (const call of read) visible = visible.replace(call.span, "");

		return {
			dialect: dialect.name,
			calls: known.map((call, index) => ({ id: mintId(index), name: call.name, args: call.args })),
			text: visible.trim(),
			unknown,
		};
	}

	return undefined;
}
