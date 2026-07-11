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
  /** Current mood/affect values for tone. */
  state: Record<string, number>;
  /** Persona display name. */
  name: string;
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
      "# Current modeled state",
      Object.entries(input.state)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(", "),
      input.memory.length ? "\n# Recent memory\n" + input.memory.slice(-6).join("\n") : "",
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
      }),
    });
    if (!res.ok) throw new Error(`responder HTTP ${res.status}`);
    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      throw new Error("responder returned a non-JSON body");
    }
    const content = (json.choices?.[0]?.message?.content ?? "").trim();
    return content || "(the model returned an empty reply, try rephrasing, or check the model/endpoint)";
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
    return (
      `(${input.name}, modeled tone: ${mood}) I registered that and updated my state + memory. ` +
      `I can't hold a full conversation without a model, set PERSONAXIS_ENDPOINT + PERSONAXIS_MODEL ` +
      `(Ollama/llama.cpp) or BYOK to talk with me for real.`
    );
  }
}
