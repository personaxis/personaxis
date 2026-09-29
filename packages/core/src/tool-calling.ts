/**
 * Tool-calling client (G1), provider-agnostic action proposals.
 *
 * Primary path: OpenAI-style native function-calling (`tools` + `tool_choice`),
 * which Cohere/OpenAI/together/etc. expose on /chat/completions. Fallback path
 * (when an endpoint rejects `tools` with a 400): a ReAct-style single-action JSON
 * (`{thought, tool, args}`) under the same constrained-decoding strategy chain the
 * appraiser uses (json_schema → json_object → plain). Either way the model only
 * *proposes* a tool call; the agent loop gates + executes.
 */

import { capabilitiesFor } from "./run/destinations.js";
import { forDestination, type Effort, type Scaffold } from "./run/model-seam.js";
import { repairToolArgs } from "./tool-repair.js";
import { readDialect } from "./tools/dialects.js";
import type { ToolSpec } from "./tools/registry.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For assistant turns that issued tool calls (echoed back to the model). */
  tool_calls?: RawToolCall[];
  /** For role:"tool" results. */
  tool_call_id?: string;
  name?: string;
}

interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * The arguments arrived CUT OFF and were closed to make them parse.
   *
   * Not the same as any other repair. A code fence, a single quote or a trailing comma are a
   * complete call written badly, and closing them recovers what the model meant. A truncation is
   * a call the model never finished, usually because the completion hit its token ceiling, and
   * closing it invents an ending: for a write, the tail of the file is simply gone.
   *
   * Measured on 2026-09-11: a model asked for a game as one HTML file emitted 2 525 bytes ending
   * mid-stylesheet, the repair closed the JSON, the write reported "ok, wrote 2525 bytes", and the
   * model, told it had succeeded, sent the same truncated file seven more times until the loop
   * breaker stopped the turn. Absent is false, so a caller that does not look behaves as before.
   */
  truncated?: boolean;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * E18: prompt tokens the provider served from ITS cache, and tokens it charged to
   * write that cache. Optional because most endpoints report neither, and absent has
   * to stay distinguishable from zero: "the provider said nothing" and "the cache
   * missed" are different facts, and reading the first as the second is how a prefix
   * that stopped being cacheable goes unnoticed for months.
   */
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ToolCallResponse {
  /** Assistant free text accompanying the call (may be empty). */
  text: string;
  toolCalls: ToolCall[];
  usedFallback: boolean;
  /**
   * E7: the model family whose syntax was read out of the text, when one was.
   *
   * Present means the endpoint did not parse a call the model made, which is a
   * deployment missing its tool parser rather than anything about this run. Worth
   * reporting because it is invisible otherwise: the reply looks like prose.
   */
  dialect?: string;
  /** Tools it named that were not offered this turn, dropped rather than run. */
  unknownTools?: readonly string[];
  /** Token accounting from the provider (for budget enforcement), when reported. */
  usage?: TokenUsage;
  /**
   * E94: why the provider says the reply ended (`stop`, `length`, `tool_calls`), when it says.
   *
   * What separates two empty replies that look identical: one that ended on `length` ran out of room,
   * usually spent thinking, and one that ended on `stop` said nothing.
   */
  finish?: string;
  /** E94: the reply carried reasoning (`reasoning_content` or `reasoning`), which the loop does not show. */
  reasoned?: boolean;
}

/**
 * E18: the two spellings of cache accounting, because this loop speaks one message
 * dialect and marks the cache in another.
 *
 * The request body is OpenAI-shaped while `markedForCache` writes Anthropic's
 * `cache_control` block, which is what a proxy in front of both accepts. So the reply
 * can come back either way: Anthropic reports `cache_read_input_tokens` and
 * `cache_creation_input_tokens` at the top of `usage`, OpenAI reports
 * `prompt_tokens_details.cached_tokens` and never bills a write at all.
 *
 * Neither is invented when missing. A number that is absent stays absent.
 */
function extractCache(u: Record<string, unknown>): { read?: number; write?: number } {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const details = u.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const read = num(u.cache_read_input_tokens) ?? num(u.cache_read_tokens) ?? num(details?.cached_tokens);
  const write = num(u.cache_creation_input_tokens) ?? num(u.cache_write_tokens);
  return { ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}) };
}

function extractUsage(json: { usage?: Partial<TokenUsage> }): TokenUsage | undefined {
  const u = json.usage;
  if (!u) return undefined;
  const total = u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
  const cache = extractCache(u as Record<string, unknown>);
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    total_tokens: total,
    ...(cache.read !== undefined ? { cache_read_tokens: cache.read } : {}),
    ...(cache.write !== undefined ? { cache_write_tokens: cache.write } : {}),
  };
}

/**
 * How long one reply may be when nothing says otherwise.
 *
 * It was 1 024, which is under four kilobytes of text, and this loop's whole job is writing files.
 * Measured on 2026-09-11: a model asked for a game as one HTML file was cut at 2 525 bytes, every
 * time, because the ceiling arrived before the closing tag. No file longer than about three
 * kilobytes could ever be written in one call, and nothing said so: the cut call was repaired,
 * executed, and reported as a success.
 *
 * 4 096 is enough for a real file and still a small share of a 32 000-token context, which is the
 * smallest this engine runs against. A model or a caller that wants a different number sets
 * `maxTokens`, and that has always won.
 */
const DEFAULT_MAX_TOKENS = 4096;

export interface ToolCallConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Ceiling on ONE reply. Defaults to `DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /**
   * E86: the context window, declared instead of discovered.
   *
   * Nothing in this file reads it: the request does not carry a window. It rides here because the loop is
   * handed the resolved model AS this config (`run/runner-for.ts:160` passes it through untouched), and the
   * loop is what needs to know how full the context is. Declared, it wins over the table and over the
   * background refresh; absent, the loop discovers it, which is right for real use.
   */
  contextWindow?: number;
  fetchImpl?: typeof fetch;
  /**
   * Called with assistant text as it arrives, when the endpoint streams (E4).
   *
   * Its presence is what asks for a stream, so a caller with nowhere to put the
   * text does not pay for one. A caller that supplies it may still get nothing:
   * plenty of endpoints ignore `stream` and answer with an ordinary body, and
   * `readReply` handles both rather than demanding one.
   */
  onDelta?: (text: string) => void;
  /**
   * Marks the stable prefix as cacheable, for providers whose cache is explicit.
   *
   * Off by default, and that is the careful direction rather than the lazy one. Two
   * families of provider exist and they disagree: one caches any repeated prefix on
   * its own and needs nothing, the other caches only what a request marks and
   * REJECTS the marking if it does not know it. Sending the mark everywhere would
   * turn a cost optimisation into a 400 on somebody's local runtime.
   *
   * What makes the mark worth anything is `stablePrefix` in the loop: a cache is a
   * prefix match, so marking a prefix that changes every turn buys nothing at all.
   */
  cachePrefix?: boolean;
  /**
   * How hard this destination is being asked to think (E8).
   *
   * Resolved against what the destination declares it accepts, never sent raw. A
   * level a destination does not know is a 400, and a level silently swapped for a
   * stronger one is a bill nobody can explain, so `resolveEffort` steps DOWN or drops
   * the field entirely.
   */
  effort?: Effort;
  /**
   * E147: `off` asks a hybrid model not to think, through the switch its destination declares (`thinkingOff`, the
   * same one E140 sends on the calls after a turn). For a question with one short structured answer, where thinking
   * buys nothing and can run to the ceiling. Absent, the request is unchanged.
   */
  thinking?: "off";
  /** Told when the asked-for effort had to be stepped down, so it can be recorded. */
  onEffortDowngrade?: (from: Effort, to: Effort | undefined, destination: string) => void;
  /**
   * E83: the scaffold this model gets, when its settings declare one. Wins over the destination table, and
   * absent in both means `standard`, the loop unchanged (`scaffoldFor`).
   */
  scaffold?: Scaffold;
}

/**
 * One assistant reply, however it arrived.
 *
 * The two paths converge here on purpose. A streamed reply and a whole one are the
 * same object once the last chunk lands, and keeping them as one type is what stops
 * the rest of the loop from having to know which it got.
 */
interface Reply {
  content: string;
  toolCalls: RawToolCall[];
  usage?: Partial<TokenUsage>;
  /** E94: see `ToolCallResponse.finish`. */
  finish?: string;
  /** E94: see `ToolCallResponse.reasoned`. */
  reasoned?: boolean;
  /** E144: the reasoning's text, read only for a call the provider left inside it (`callLeftInReasoning`). */
  reasoning?: string;
  /**
   * E136: how many frames a STREAMED reply carried, absent for one that was not streamed. Zero is not an empty
   * answer: a model that says nothing still sends the frame with its role and the one with its finish. Measured
   * 2026-09-24 with `Qwen/Qwen3.5-9B`: a request whose shape the template refused came back 200 with a stream of
   * nothing but `data: [DONE]`, which read as the model going silent, twice, and the turn ended as failed.
   */
  frames?: number;
  /**
   * E136: an error the provider sent INSIDE a stream that had already answered 200. Read on 2026-09-24 from the raw
   * body, headers included: `data: {"error":{"message":"System message must be at the beginning.","code":400}}` and
   * then `data: [DONE]`. Without reading it the loop took a refusal with its reason for the model going silent.
   */
  error?: string;
}

/**
 * Reads a reply, streamed or whole.
 *
 * The decision is made from the RESPONSE, never from what we asked for. An endpoint
 * that ignores `stream` and answers with a JSON body is ordinary: local runtimes do
 * it, proxies do it, and a client that insisted on parsing events would see a valid
 * answer as a protocol error. So the content type decides, and the request is only a
 * request.
 */
async function readReply(res: Response, onDelta?: (text: string) => void): Promise<Reply> {
  const kind = res.headers?.get?.("content-type") ?? "";
  if (!kind.includes("text/event-stream") || !res.body) {
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: RawToolCall[] };
      }>;
      usage?: Partial<TokenUsage>;
    };
    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const thought = msg.reasoning_content || msg.reasoning;
    return {
      content: msg.content ?? "",
      toolCalls: msg.tool_calls ?? [],
      usage: json.usage,
      ...(choice?.finish_reason ? { finish: choice.finish_reason } : {}),
      ...(thought ? { reasoned: true, reasoning: thought } : {}),
    };
  }

  // Assembled by index, which is how the wire identifies which call a fragment
  // belongs to. Arguments arrive as a string in pieces and are concatenated, never
  // parsed until the end: half a JSON object is not a smaller JSON object.
  const parts = new Map<number, RawToolCall>();
  let content = "";
  let usage: Partial<TokenUsage> | undefined;
  let finish: string | undefined;
  let reasoned = false;
  let reasoning = "";
  let frames = 0;
  let error: string | undefined;
  let pending = "";

  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    // Events are separated by a blank line, and a chunk can end mid-event. The tail
    // is kept rather than parsed, because a truncated event parsed optimistically is
    // a silently lost token.
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let frame: {
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: string;
              reasoning_content?: string;
              reasoning?: string;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }>;
          usage?: Partial<TokenUsage>;
        };
        try {
          frame = JSON.parse(data);
        } catch {
          // A frame we cannot read is skipped rather than fatal. The reply is still
          // arriving, and ending the turn over one malformed event would throw away
          // everything that came before it.
          continue;
        }
        const refused = (frame as { error?: { message?: unknown } }).error;
        if (refused) {
          error = typeof refused.message === "string" ? refused.message : JSON.stringify(refused);
          continue;
        }
        frames += 1;
        if (frame.usage) usage = frame.usage;
        const choice = frame.choices?.[0];
        // E94: kept, not shown. An empty reply means one thing after thinking to the ceiling and
        // another after saying nothing, and only these two say which.
        if (choice?.finish_reason) finish = choice.finish_reason;
        const delta = choice?.delta;
        const thought = delta?.reasoning_content || delta?.reasoning;
        if (thought) {
          reasoned = true;
          reasoning += thought;
        }
        if (delta?.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        for (const piece of delta?.tool_calls ?? []) {
          const index = piece.index ?? 0;
          const held = parts.get(index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (piece.id) held.id = piece.id;
          if (piece.function?.name) held.function.name = piece.function.name;
          if (piece.function?.arguments) held.function.arguments += piece.function.arguments;
          parts.set(index, held);
        }
      }
    }
  }

  return {
    content,
    // In index order, because the model asked for them in one, and a set of calls
    // reordered by a Map's insertion history is a different plan.
    toolCalls: [...parts.entries()].sort(([one], [other]) => one - other).map(([, call]) => call),
    ...(usage ? { usage } : {}),
    ...(finish ? { finish } : {}),
    ...(reasoned ? { reasoned, reasoning } : {}),
    frames,
    ...(error ? { error } : {}),
  };
}

/**
 * E144: the calls a reasoning ENDS with, and nothing when it ends with anything else.
 *
 * Only the tail, and only whole `<tool_call>...</tool_call>` blocks with nothing after them but whitespace. A call the
 * model considered halfway through its thinking and then moved past is not a call it made; the one it stopped on is.
 */
function callLeftInReasoning(reasoning: string | undefined): string | undefined {
  if (!reasoning) return undefined;
  // A block may not contain another opening tag, so a match cannot stretch from an early call across prose to a late
  // one: between the blocks at the end there is whitespace and nothing else.
  const tail = /((?:\s*<tool_call>(?:(?!<tool_call>)[\s\S])*?<\/tool_call>)+)\s*$/.exec(reasoning);
  return tail ? tail[1]!.trim() : undefined;
}

function url(cfg: ToolCallConfig): string {
  return `${cfg.endpoint.replace(/\/$/, "")}/chat/completions`;
}
function headers(cfg: ToolCallConfig): Record<string, string> {
  return { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function parseArgs(raw: string): { args: Record<string, unknown>; truncated: boolean } {
  try {
    const v = JSON.parse(raw || "{}");
    return { args: v && typeof v === "object" ? (v as Record<string, unknown>) : {}, truncated: false };
  } catch {
    // FR.10 (OpenClaw port): salvage almost-JSON before giving up, a repaired
    // call saves a full model round-trip on weaker tool-callers.
    const r = repairToolArgs(raw);
    // Whether the salvage had to INVENT an ending. See `ToolCall.truncated`.
    return { args: r.ok && r.value ? r.value : {}, truncated: r.applied.includes("close-truncated") };
  }
}

/**
 * The transcript with a cache breakpoint on its stable prefix.
 *
 * One breakpoint, on the LAST leading system message, and both halves of that are
 * deliberate. Last, because a provider caches everything up to the mark and a mark on
 * the first of three system messages would leave the other two paying full price
 * every turn. Leading, because the first user message is where per-turn text starts
 * and marking past it would mark something that differs on every request, which buys
 * a cache write and never a read.
 *
 * The content becomes an array of blocks, which is how the marking is expressed. A
 * provider that does not know the field would reject it, which is why this only runs
 * when the caller asked for it.
 */
/**
 * E136: the conversation with ONE system message, at the start, for a chat template that accepts no other shape.
 *
 * Measured 2026-09-24 with `Qwen/Qwen3.5-9B` on HuggingFace's router: every request answered 400 "Input validation
 * error", the loop fell back to prose, and no reply carried a native tool call. Not the context, no tool, no field:
 * the loop sends the identity, the turn's scope and the map as three system messages, and more mid-conversation
 * (the task list, the loop check), and that model's template takes one system message, first. The same request with
 * one answered 200. The leading system messages are joined into one; a later one becomes a user message, whose content
 * already names who put it there (`[runtime:...]`), so nothing reads as the person's words that were not.
 */
function withOneSystem(messages: readonly ChatMessage[]): ChatMessage[] {
	let lead = 0;
	while (lead < messages.length && messages[lead]!.role === "system") lead += 1;
	const head = messages.slice(0, lead).map((message) => message.content).join("\n\n");
	const rest = messages.slice(lead).map((message) => (message.role === "system" ? { ...message, role: "user" as const } : message));
	return lead === 0 ? rest : [{ role: "system", content: head }, ...rest];
}

/**
 * E136: the endpoints and models that have refused several system messages, so their next requests are shaped once
 * instead of refused once per call. Per process, like the context window the loop discovers: nothing is written down,
 * because a provider can change its template tomorrow and a stale note would reshape requests that no longer need it.
 */
const oneSystemOnly = new Set<string>();
const shapeKey = (cfg: { endpoint: string; model: string }): string => `${cfg.endpoint}|${cfg.model}`;

function markedForCache(messages: ChatMessage[]): unknown[] {
	let last = -1;
	for (let index = 0; index < messages.length; index += 1) {
		if (messages[index]!.role !== "system") break;
		last = index;
	}
	if (last < 0) return messages;

	return messages.map((message, index) =>
		index === last
			? {
					...message,
					content: [
						{ type: "text", text: message.content, cache_control: { type: "ephemeral" } },
					],
				}
			: message,
	);
}

/**
 * Request the next action. `preferFallback` lets the caller skip the native
 * attempt once it has learned the endpoint doesn't support `tools`.
 */
export async function requestToolCall(
  cfg: ToolCallConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  preferFallback = false,
): Promise<ToolCallResponse> {
  const fetchImpl = cfg.fetchImpl ?? fetch;

  // E8: the seam, asked before the request is built rather than after it fails.
  //
  // `forDestination` copies as well as resolving, which is the other half of the rule
  // it carries: anything done per destination happens on a copy, because a sanitiser
  // that trimmed a shared tool registry in place left it permanently trimmed for every
  // other provider. Nothing here mutates `messages` or `tools`.
  const destination = capabilitiesFor(cfg.endpoint, cfg.model);
  const shaped = cfg.effort
    ? forDestination(
        { destination: destination.id, effort: cfg.effort, messages: [], tools: [] },
        destination,
      )
    : undefined;
  const effort = shaped?.effort;
  if (cfg.effort && effort !== cfg.effort) {
    // A downgrade nobody can see is a downgrade somebody argues about later.
    cfg.onEffortDowngrade?.(cfg.effort, effort, destination.id);
  }

  if (!preferFallback) {
    // E136: shaped for a template that takes one system message, when this endpoint and model already refused several.
    const oneSystem = oneSystemOnly.has(shapeKey(cfg));
    const sent = oneSystem ? withOneSystem(messages) : messages;
    const body = {
      model: cfg.model,
      messages: cfg.cachePrefix ? markedForCache(sent) : sent,
      // E83: a call that offers no tools (the decision step, the planning call) sends no `tools` and no
      // `tool_choice`. Measured 2026-09-15: HuggingFace's router answers HTTP 400 to an empty list with a
      // choice, and a 400 here is read as "this endpoint has no tool calling", which sent both calls into the
      // ReAct fallback below. The same request without the two fields answers 200.
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto",
          }
        : {}),
      temperature: 0.3,
      max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Asked for only when somebody is listening. `stream_options` comes with it
      // because a streamed reply reports no usage without it, and this loop enforces
      // a token budget: streaming that quietly cost the budget its numbers would turn
      // a hard stop into a run that never stops.
      ...(cfg.onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
      // E147: a call that asked not to think sends the switch this destination declared, and nothing where none is.
      ...(cfg.thinking === "off" ? (capabilitiesFor(cfg.endpoint, cfg.model).thinkingOff ?? {}) : {}),
      // E8: the effort this destination declared it accepts, or nothing at all.
      //
      // Absent is the ordinary case and the safe one. Only a destination in the table
      // declares an effort vocabulary, so a local runtime somebody started this
      // morning never receives a field it would reject.
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    let res = await fetchImpl(url(cfg), { method: "POST", headers: headers(cfg), body: JSON.stringify(body) });
    // E136: a request refused over several system messages is retried ONCE with one, and remembered when that is
    // what it was. Refused means a 400, or, when streamed, a 200 whose stream carried no frame at all (see
    // `Reply.frames`). Only when reshaping changes something: otherwise the retry would be the same request twice.
    const reshaped = !oneSystem ? withOneSystem(messages) : undefined;
    const canReshape = reshaped !== undefined && (reshaped.length !== messages.length || reshaped.some((message, index) => message.role !== messages[index]?.role));
    const retryReshaped = async (): Promise<Response> => {
      const again = await fetchImpl(url(cfg), {
        method: "POST",
        headers: headers(cfg),
        body: JSON.stringify({ ...body, messages: cfg.cachePrefix ? markedForCache(reshaped!) : reshaped }),
      });
      return again;
    };
    if (res.status === 400 && canReshape) {
      res = await retryReshaped();
      if (res.ok) oneSystemOnly.add(shapeKey(cfg));
    }
    if (res.ok) {
      let reply = await readReply(res, cfg.onDelta);
      const refusedInStream = (r: Reply): boolean => r.error !== undefined || r.frames === 0;
      if (refusedInStream(reply) && canReshape) {
        const again = await retryReshaped();
        if (again.ok) {
          reply = await readReply(again, cfg.onDelta);
          if (!refusedInStream(reply)) oneSystemOnly.add(shapeKey(cfg));
        }
      }
      // A refusal that stays one is the provider's, with its reason, never the model going silent.
      if (reply.error !== undefined) throw new Error(`tool-calling stream error: ${reply.error}`);
      // E137: a reply that used its whole ceiling was cut, whatever the provider says. Read raw on 2026-09-24 with
      // Qwen3.5-9B on HuggingFace's router, a write_file cut at the cap came back as VALID JSON with `finish:
      // tool_calls` from both providers: together dropped the cut argument (`{"path": "game.html"}`) and deepinfra
      // closed the string itself, half a stylesheet in `content`. Neither fails to parse, so `parseArgs` never saw a
      // cut, and the model heard "missing content" seventeen times or would have been told half a file was written.
      // Only the last call can be the one cut: the ones before it were finished before the ceiling arrived.
      const completion = extractUsage({ usage: reply.usage })?.completion_tokens;
      const cutAtCap = reply.finish === "length" || (completion !== undefined && completion >= body.max_tokens);
      const toolCalls = reply.toolCalls.map((tc, index) => {
        const parsed = parseArgs(tc.function.arguments);
        const cut = parsed.truncated || (cutAtCap && index === reply.toolCalls.length - 1);
        return {
          id: tc.id,
          name: tc.function.name,
          args: parsed.args,
          ...(cut ? { truncated: true } : {}),
        };
      });
      // E7: a call the endpoint did not parse, still written in the model's own
      // syntax. Only when the native path found none, so a well-formed reply is never
      // re-read, and only for tools offered this turn.
      if (toolCalls.length === 0) {
        const reading = readDialect(
          reply.content,
          tools.map((tool) => tool.name),
        );
        if (reading && reading.calls.length > 0) {
          return {
            text: reading.text,
            toolCalls: [...reading.calls],
            usedFallback: false,
            usage: extractUsage({ usage: reply.usage }),
            dialect: reading.dialect,
          };
        }
        if (reading) {
          // Recognised the shape and none of the names. Reported so a deployment
          // missing its parser is visible, rather than a run that quietly did nothing.
          return {
            text: reply.content.trim(),
            toolCalls: [],
            usedFallback: false,
            usage: extractUsage({ usage: reply.usage }),
            dialect: reading.dialect,
            unknownTools: reading.unknown,
          };
        }
        // E144: a reply with no text and no calls whose reasoning ENDS in a complete call. Read raw on 2026-09-28:
        // Qwen 3.5 through the provider `together` wrote its call inside the reasoning and got back `finish: stop`
        // with nothing, on every request that followed a tool result in a real turn; the same request to `deepinfra`
        // came back with the call. The loop then nudged (E94) and paid one more request per step, a third of them.
        // Only the calls at the very end count, only when nothing else came back, and only tools offered this turn,
        // through the same gate: the model did make the call, and the provider lost it on the way.
        const left = reply.content.trim() === "" ? callLeftInReasoning(reply.reasoning) : undefined;
        if (left) {
          const found = readDialect(left, tools.map((tool) => tool.name));
          if (found && found.calls.length > 0) {
            return {
              text: "",
              toolCalls: [...found.calls],
              usedFallback: false,
              usage: extractUsage({ usage: reply.usage }),
              dialect: `${found.dialect} (in reasoning)`,
              ...(found.unknown.length > 0 ? { unknownTools: found.unknown } : {}),
              ...(reply.finish ? { finish: reply.finish } : {}),
              reasoned: true,
            };
          }
        }
      }

      return {
        text: reply.content.trim(),
        toolCalls,
        usedFallback: false,
        usage: extractUsage({ usage: reply.usage }),
        ...(reply.finish ? { finish: reply.finish } : {}),
        ...(reply.reasoned ? { reasoned: true } : {}),
      };
    }
    // Auth/rate/server errors won't be fixed by the fallback, surface them.
    //
    // E83: and neither is anything wrong with a request that offered no tools. The fallback below exists for
    // an endpoint that cannot take `tools`, and a request without them cannot be refused for that. Measured
    // 2026-09-15: `command-a-reasoning` answered the planning call 422 "No valid response generated", the
    // fallback turned it into a ReAct prompt that failed again, and the whole turn ended failed with 0 steps.
    if (tools.length === 0 || res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new Error(`tool-calling HTTP ${res.status}: ${await safeText(res)}`);
    }
    // 400/422 → endpoint likely doesn't support `tools`; degrade to ReAct.
  }

  return reactFallback(cfg, messages, tools);
}

const REACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tool", "args"],
  properties: {
    thought: { type: "string" },
    tool: { type: "string" },
    args: { type: "object" },
  },
} as const;

/** ReAct fallback: render the transcript to text, ask for ONE JSON action. */
async function reactFallback(
  cfg: ToolCallConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
): Promise<ToolCallResponse> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const toolDocs = tools
    .map((t) => `- ${t.name}(${Object.keys((t.parameters as { properties?: object }).properties ?? {}).join(", ")}): ${t.description}`)
    .join("\n");
  const transcript = messages
    .map((m) => {
      if (m.role === "tool") return `TOOL_RESULT[${m.name ?? ""}]: ${m.content}`;
      if (m.role === "assistant" && m.tool_calls?.length)
        return `ASSISTANT called: ${m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join(", ")}`;
      return `${m.role.toUpperCase()}: ${m.content}`;
    })
    .join("\n");

  const system = [
    messages.find((m) => m.role === "system")?.content ?? "",
    "",
    "You are an agent that acts ONLY by emitting a single JSON action.",
    "Available tools:",
    toolDocs,
    "",
    'Respond with exactly one JSON object: {"thought": string, "tool": string, "args": object}.',
    'When the task is complete, use {"tool":"finish","args":{"summary":"..."}}.',
  ].join("\n");

  const strategies: Array<Record<string, unknown> | undefined> = [
    { type: "json_schema", json_schema: { name: "agent_action", strict: true, schema: REACT_SCHEMA } },
    { type: "json_object" },
    undefined,
  ];

  let lastErr = "no response";
  for (const responseFormat of strategies) {
    const body = {
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Transcript so far:\n${transcript}\n\nEmit the next action as JSON.` },
      ],
      ...(responseFormat ? { response_format: responseFormat } : {}),
      temperature: 0.3,
      max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    const res = await fetchImpl(url(cfg), { method: "POST", headers: headers(cfg), body: JSON.stringify(body) });
    if (res.ok) {
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: Partial<TokenUsage> };
      const usage = extractUsage(json);
      const content = json.choices?.[0]?.message?.content ?? "{}";
      let parsed: { thought?: string; tool?: string; args?: Record<string, unknown> };
      try {
        parsed = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        try {
          parsed = m ? JSON.parse(m[0]) : {};
        } catch {
          const r = repairToolArgs(m ? m[0] : content); // FR.10 repair pass
          parsed = r.ok && r.value ? (r.value as typeof parsed) : {};
        }
      }
      // E36: the envelope is never the answer. Measured 2026-09-22 against a hosted model that refuses the
      // `tools` parameter, which is what drives a run down here: asked for advice, the persona replied with
      // `{ "args": { "acceleration": 0.8, "friction": 0.12, ... } }`, because a JSON object with no `tool`
      // field was handed to the reader as prose. Whoever runs a local server that cannot take `tools` sees
      // that as the persona's answer. The `thought` is the only part of this shape meant for a person.
      if (!parsed.tool) {
        return { text: parsed.thought ?? "", toolCalls: [], usedFallback: true, usage };
      }
      // E36: and the name has to be one that was offered, which is the rule `readDialect` enforces in the
      // other half of this file and this half did not. Not a hole, and that was checked before saying it:
      // `agent.ts` refuses a name that is not in the catalogue and tells the model so. What was lost is the
      // diagnosis, because a refusal read as the model calling badly and `unknownTools` was never reported
      // here, and that field exists so a deployment missing its parser is visible.
      if (!tools.some((tool) => tool.name === parsed.tool)) {
        return {
          text: parsed.thought ?? "",
          toolCalls: [],
          usedFallback: true,
          usage,
          unknownTools: [parsed.tool],
        };
      }
      return {
        text: parsed.thought ?? "",
        toolCalls: [{ id: `react_${Date.now()}`, name: parsed.tool, args: parsed.args ?? {} }],
        usedFallback: true,
        usage,
      };
    }
    lastErr = `HTTP ${res.status}: ${await safeText(res)}`;
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) break;
  }
  throw new Error(`tool-calling fallback ${lastErr}`);
}
