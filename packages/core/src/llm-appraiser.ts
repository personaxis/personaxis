/**
 * LLM appraiser — small-model feasibility via constrained decoding (F2).
 *
 * The model NEVER emits a state mutation by hand. It emits a structured appraisal
 * signal under APPRAISAL_JSON_SCHEMA, enforced by the server's constrained
 * decoding (llama.cpp / Ollama `response_format: json_schema`, or a GBNF grammar).
 * The spec engine then clamps + governs. The model proposes signals; the code +
 * the spec impose safety — viable on <=4B and safe at the same time.
 *
 * Talks to any OpenAI-compatible /chat/completions endpoint (Ollama, llama.cpp
 * server, LM Studio, or a hosted model). Dependency-free (uses global fetch).
 */

import {
  APPRAISAL_JSON_SCHEMA,
  parseAppraisalSignal,
  type AppraiseInput,
  type AppraisalSignal,
  type Appraiser,
} from "./appraisal.js";

export interface LlmAppraiserConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama). */
  endpoint: string;
  model: string;
  /** Optional bearer token (hosted endpoints). Local servers need none. */
  apiKey?: string;
  /** Hard cap on the response; appraisal signals are tiny. */
  maxTokens?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const SYSTEM = `You are the appraisal module of a governed AI persona runtime.
Given the persona's identity and a new observation, output ONLY a JSON object that
matches the provided schema: a brief appraisal, optional small envelope nudges
(field + signed delta in [-1,1] + reason), optional memory notes (content + source),
and a confidence in [0,1]. Propose only minimal, well-justified changes. You are
NOT applying anything — the runtime clamps and governs your proposal.`;

export class LlmAppraiser implements Appraiser {
  constructor(private readonly cfg: LlmAppraiserConfig) {}

  async appraise(input: AppraiseInput): Promise<AppraisalSignal> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const userMsg = [
      `# Persona identity (slot #1)`,
      input.personaBody.slice(0, 4000),
      ``,
      `# Mutable envelope fields you may nudge`,
      input.mutableFields.join(", ") || "(none)",
      ``,
      `# Observation [source: ${input.source}]`,
      input.observation,
    ].join("\n");

    const body = {
      model: this.cfg.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
      // Constrained decoding: force schema-valid JSON. Supported by llama.cpp
      // server and Ollama; hosted OpenAI-compatible APIs accept json_schema too.
      response_format: {
        type: "json_schema",
        json_schema: { name: "appraisal_signal", strict: true, schema: APPRAISAL_JSON_SCHEMA },
      },
      temperature: 0.4,
      max_tokens: this.cfg.maxTokens ?? 512,
    };

    const res = await fetchImpl(`${this.cfg.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`LLM appraiser HTTP ${res.status}: ${await safeText(res)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Some servers wrap JSON in prose; extract the first {...} block.
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }
    return parseAppraisalSignal(parsed);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
