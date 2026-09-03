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

import { repairToolArgs } from "./tool-repair.js";
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
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolCallResponse {
  /** Assistant free text accompanying the call (may be empty). */
  text: string;
  toolCalls: ToolCall[];
  usedFallback: boolean;
  /** Token accounting from the provider (for budget enforcement), when reported. */
  usage?: TokenUsage;
}

function extractUsage(json: { usage?: Partial<TokenUsage> }): TokenUsage | undefined {
  const u = json.usage;
  if (!u) return undefined;
  const total = u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
  return { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, total_tokens: total };
}

export interface ToolCallConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
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
      choices?: Array<{ message?: { content?: string; tool_calls?: RawToolCall[] } }>;
      usage?: Partial<TokenUsage>;
    };
    const msg = json.choices?.[0]?.message ?? {};
    return { content: msg.content ?? "", toolCalls: msg.tool_calls ?? [], usage: json.usage };
  }

  // Assembled by index, which is how the wire identifies which call a fragment
  // belongs to. Arguments arrive as a string in pieces and are concatenated, never
  // parsed until the end: half a JSON object is not a smaller JSON object.
  const parts = new Map<number, RawToolCall>();
  let content = "";
  let usage: Partial<TokenUsage> | undefined;
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
          choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
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
        if (frame.usage) usage = frame.usage;
        const delta = frame.choices?.[0]?.delta;
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
  };
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

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    // FR.10 (OpenClaw port): salvage almost-JSON before giving up, a repaired
    // call saves a full model round-trip on weaker tool-callers.
    const r = repairToolArgs(raw);
    return r.ok && r.value ? r.value : {};
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

  if (!preferFallback) {
    const body = {
      model: cfg.model,
      messages: cfg.cachePrefix ? markedForCache(messages) : messages,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: cfg.maxTokens ?? 1024,
      // Asked for only when somebody is listening. `stream_options` comes with it
      // because a streamed reply reports no usage without it, and this loop enforces
      // a token budget: streaming that quietly cost the budget its numbers would turn
      // a hard stop into a run that never stops.
      ...(cfg.onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    const res = await fetchImpl(url(cfg), { method: "POST", headers: headers(cfg), body: JSON.stringify(body) });
    if (res.ok) {
      const reply = await readReply(res, cfg.onDelta);
      const toolCalls = reply.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: parseArgs(tc.function.arguments),
      }));
      return {
        text: reply.content.trim(),
        toolCalls,
        usedFallback: false,
        usage: extractUsage({ usage: reply.usage }),
      };
    }
    // Auth/rate/server errors won't be fixed by the fallback, surface them.
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
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
      max_tokens: cfg.maxTokens ?? 1024,
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
      if (!parsed.tool) {
        return { text: parsed.thought ?? content.slice(0, 200), toolCalls: [], usedFallback: true, usage };
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
