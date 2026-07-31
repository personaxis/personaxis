/**
 * Responder, the persona's conversational voice (what makes the REPL playable).
 *
 * The Living Loop governs *how the persona changes*; the Responder governs *what it
 * says back*. They are separate on purpose: the appraiser emits structured evolution
 * signals; the responder emits a natural-language reply, grounded in the compiled
 * identity (PERSONA.md), recent memory, and current mood, and bound by the spec
 * (never claims real feelings).
 *
 * `LlmResponder` talks to any OpenAI-compatible endpoint (Ollama/llama.cpp/hosted).
 * `ReflectiveResponder` is an offline fallback: it doesn't fake a conversation, it
 * gives an honest persona-flavored acknowledgement and points to enabling a model.
 */

export interface RespondInput {
  message: string;
  /** Compiled identity (PERSONA.md body), system-prompt slot #1. */
  personaBody: string;
  /** Recent episodic memory lines for grounding (most recent last). */
  memory: string[];
  /** Runtime context block (who/where/resources). Injected AFTER the identity cap so it
   *  is never truncated away with a long compiled doc (V5.P0.1). */
  awareness?: string;
  /** Current mood/affect values for tone. */
  state: Record<string, number>;
  /** Persona display name. */
  name: string;
  /** V2-F3.E23: when set, the LLM responder streams the reply and calls this with
   *  each text delta as it arrives (the full string is still returned). */
  onToken?: (chunk: string) => void;
}

export interface Responder {
  respond(input: RespondInput): Promise<string>;
}

const GUARD =
  "You are this persona. Speak in its voice, consistent with its identity, values, and current mood. " +
  "You are an AI: never claim real human feelings or consciousness; you may describe your modeled affect as state. " +
  "Be helpful and concise. Do not invent facts about the user.";

export interface LlmResponderConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export class LlmResponder implements Responder {
  constructor(private readonly cfg: LlmResponderConfig) {}

  async respond(input: RespondInput): Promise<string> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const system = [
      GUARD,
      "",
      "# Identity",
      input.personaBody.slice(0, 6000),
      "",
      input.awareness ? `${input.awareness}\n` : "",
      "# Current modeled state",
      Object.entries(input.state)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(", "),
      // The caller bounds `memory` (profile first, then the recall window); a second
      // slice here would drop the profile lines that lead the array.
      input.memory.length ? "\n# Memory (stable facts first)\n" + input.memory.join("\n") : "",
    ].join("\n");

    const res = await fetchImpl(`${this.cfg.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input.message },
        ],
        temperature: 0.7,
        max_tokens: this.cfg.maxTokens ?? 512,
        ...(input.onToken ? { stream: true } : {}),
      }),
    });
    if (!res.ok) throw new Error(`responder HTTP ${res.status}`);
    if (input.onToken && res.body) {
      return this.readStream(res.body as ReadableStream<Uint8Array>, input.onToken);
    }
    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      throw new Error("responder returned a non-JSON body");
    }
    const content = (json.choices?.[0]?.message?.content ?? "").trim();
    return content || "(the model returned an empty reply, try rephrasing, or check the model/endpoint)";
  }

  /** Parse an OpenAI-compatible SSE stream, emitting each delta via `onToken`. */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    onToken: (chunk: string) => void,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onToken(delta);
          }
        } catch {
          /* ignore a partial/non-JSON SSE line */
        }
      }
    }
    return full.trim() || "(the model returned an empty reply, try rephrasing, or check the model/endpoint)";
  }
}

/**
 * Offline fallback. It does NOT pretend to converse, it reflects the persona's
 * current modeled tone honestly and nudges the user to enable a model for real
 * dialogue. Deterministic, dependency-free.
 */
export class ReflectiveResponder implements Responder {
  async respond(input: RespondInput): Promise<string> {
    const tone = input.state["mood.tone"] ?? 0;
    const mood = tone > 0.12 ? "upbeat" : tone < -0.12 ? "subdued" : "even";
    // The known facts lead the memory lines (e.g. "interlocutor.name: X"). Even
    // offline, the persona addresses a KNOWN party by name, whatever the subject,
    // cross-session recall made visible (not limited to a "user").
    const known = input.memory.map((l) => /^[\w:.-]*\.?name:\s*(.+)$/.exec(l)?.[1]).find(Boolean);
    return (
      `(${input.name}, modeled tone: ${mood})${known ? ` Noted, ${known}.` : ""} I registered that and updated my state + memory. ` +
      `I can't hold a full conversation without a model, set PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL ` +
      `(Ollama/llama.cpp) or BYOK to talk with me for real.`
    );
  }
}
