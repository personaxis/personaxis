/**
 * LLM appraiser, small-model feasibility via constrained decoding (F2).
 *
 * The model NEVER emits a state mutation by hand. It emits a structured appraisal
 * signal under APPRAISAL_JSON_SCHEMA, enforced by the server's constrained
 * decoding (llama.cpp / Ollama `response_format: json_schema`, or a GBNF grammar).
 * The spec engine then clamps + governs. The model proposes signals; the code +
 * the spec impose safety, viable on <=4B and safe at the same time.
 *
 * Talks to any OpenAI-compatible /chat/completions endpoint (Ollama, llama.cpp
 * server, LM Studio, or a hosted model). Dependency-free (uses global fetch).
 */

import {
  APPRAISAL_JSON_SCHEMA,
  parseAppraisalSignal,
  portableJsonSchema,
  type AppraiseInput,
  type AppraisalSignal,
  type Appraiser,
} from "./appraisal.js";
import { renderEvolutionView } from "./evolution-view.js";

export interface LlmAppraiserConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama). */
  endpoint: string;
  model: string;
  /** Optional bearer token (hosted endpoints). Local servers need none. */
  apiKey?: string;
  /** Hard cap on the response; appraisal signals are tiny. */
  maxTokens?: number;
  /** Abort the request after this many ms so a hung endpoint never blocks a turn (default 30s). */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const SYSTEM = `You are the appraisal module of a governed AI persona runtime.
Given the persona's identity and a new observation, output ONLY a JSON object that
matches the provided schema:
- "appraisal": a brief read of the situation;
- "mutations": optional small envelope nudges (field + signed delta in [-1,1] + reason);
- "memories": optional notes to remember (content + source);
- "selfEdits": optional durable edits to the persona SPEC, by dot-path. Each item is
  { "targetPath": "<dot.path>", "toValue": <the full new value>, "rationale": "<why>" }.
  You may ONLY target the editable sections listed below; identity/character/hard_limits/safety
  are protected and rejected. Propose these RARELY, only when the observation clearly warrants a
  lasting change. But when the user EXPLICITLY authorizes a durable change to an editable section,
  you MUST express it as a selfEdit (the structured field), never only in the "appraisal" prose.
  The "toValue" is the replacement value, not a delta: for a scalar give the new number/string;
  for an object give the whole new object. Worked example, user says "permanently lower your
  uncertainty disclosure threshold to 0.10":
    "selfEdits": [{ "targetPath": "cognition.uncertainty_policy.disclose_when_above",
      "toValue": 0.10, "rationale": "user authorized a durable lower disclosure threshold" }]
- "preferences": optional STABLE facts/preferences you inferred (key + value). A fact is about an
  ENTITY, not just "the user": use a dotted "<subject>.<attribute>" key where subject is the party
  you are talking to ("interlocutor.name", "interlocutor.role"), a NAMED person/agent/app
  ("person:david.timezone", "agent:reviewer.owner", "app:frontend.stack"), or the project
  ("project.deadline"). Plain (dot-free) keys are loose preferences ("format.tone" has a dot so it
  is a fact about "format"; use "tone" alone for a pure preference). Record a self-introduction
  EVERY time so recall addresses the party by name across sessions;
- "confidence" in [0,1] (self-edits/preferences are only considered at confidence >= 0.6).
Propose only minimal, well-justified changes. You are NOT applying anything, the runtime
clamps, governs (mode + consensus + protected paths), and may queue your proposal.`;

export class LlmAppraiser implements Appraiser {
  constructor(private readonly cfg: LlmAppraiserConfig) {}

  async appraise(input: AppraiseInput): Promise<AppraisalSignal> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    // F3.8: prefer the grounded evolution view (current values + envelopes + mode)
    // over the bare field names, so the model proposes deltas against reality.
    const evolutionBlock = input.evolutionView
      ? renderEvolutionView(input.evolutionView)
      : [
          `# Mutable envelope fields you may nudge`,
          input.mutableFields.join(", ") || "(none)",
          ``,
          `# Editable spec sections you may propose self-edits to`,
          (input.editableSections ?? []).join(", ") || "(none, do not propose selfEdits)",
        ].join("\n");

    const userMsg = [
      `# Persona identity (slot #1)`,
      input.personaBody.slice(0, 4000),
      ``,
      evolutionBlock,
      ``,
      `# Observation [source: ${input.source}]`,
      input.observation,
    ].join("\n");

    const base = {
      model: this.cfg.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
      temperature: 0.4,
      // 2048 and not 512, and the number is measured rather than chosen. On the HuggingFace
      // router (2026-09-10) Qwen3.5-9B answers a one-paragraph prompt in 758 completion
      // tokens of which most are thinking, and at 512 it returns an empty string. The old
      // 512 predates models that think before they answer, and it is now a budget that a
      // whole family of open models cannot finish inside.
      max_tokens: this.cfg.maxTokens ?? 2048,
    };

    // Constrained decoding, most-constrained first. Endpoints accept different
    // subsets: llama.cpp/Ollama and OpenAI take full `json_schema`; Cohere/Groq
    // reject value-constraint keywords (so we send the portable schema) and some
    // accept only `json_object`; the rest just need a JSON-shaped prompt. We degrade
    // gracefully so a strict backend never kills the loop. Safety is downstream
    // (clamp + parseAppraisalSignal), never the model's to enforce.
    const strategies: Array<Record<string, unknown> | undefined> = [
      {
        type: "json_schema",
        json_schema: {
          name: "appraisal_signal",
          strict: true,
          schema: portableJsonSchema(APPRAISAL_JSON_SCHEMA),
        },
      },
      { type: "json_object" },
      undefined,
    ];

    let lastErr = "no response";
    for (const responseFormat of strategies) {
      const body = responseFormat ? { ...base, response_format: responseFormat } : base;
      // Hard timeout so a slow/hung hosted endpoint never blocks the turn forever.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await fetchImpl(`${this.cfg.endpoint.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const json = (await res.json()) as {
          choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning?: string; reasoning_content?: string } }>;
        };
        const choice = json.choices?.[0];
        const content = choice?.message?.content ?? "";

        // A BLANK answer is not an empty appraisal, and the difference is the whole bug.
        //
        // Measured 2026-09-10 on the HuggingFace router with Qwen3.5-9B: at max_tokens 512
        // the model spends the entire budget thinking and returns HTTP 200 with content "".
        // An empty string is not nullish, so `?? "{}"` never fired; JSON.parse("") threw; the
        // prose-extraction catch found no {...}; and `parseAppraisalSignal({})` handed back a
        // NEUTRAL signal as though the model had answered and had nothing to report.
        //
        // The persona then never evolves, on every tick, with no error anywhere. That is the
        // silent local failure this file must not have: a model that could not answer has to
        // look different from a model that answered "no change".
        if (content.trim() === "") {
          const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
          lastErr =
            choice?.finish_reason === "length"
              ? "the model hit its token limit before writing an answer" +
                (reasoning ? ", having spent the budget thinking" : "") +
                "; raise maxTokens for a reasoning model"
              : reasoning
                ? "the model returned only its reasoning and no answer; raise maxTokens"
                : "the model returned an empty answer";
          // Relaxing response_format cannot conjure an answer out of an exhausted budget.
          break;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          // Some servers wrap JSON in prose; extract the first {...} block.
          const m = content.match(/\{[\s\S]*\}/);
          parsed = m ? JSON.parse(m[0]) : {};
        }
        const signal = parseAppraisalSignal(parsed);
        // E95: the portable schema sends a property that takes any value as a string holding JSON, so under that
        // strategy a self-edit's value comes back written as JSON. The other strategies send no schema, and a
        // string there is the value itself.
        return responseFormat?.type === "json_schema" ? { ...signal, selfEdits: signal.selfEdits?.map((edit) => ({ ...edit, toValue: fromJsonText(edit.toValue) })) } : signal;
      }

      lastErr = `HTTP ${res.status}: ${await safeText(res)}`;
      // Auth, rate-limit and server errors won't be fixed by relaxing the
      // response_format, surface them immediately. Only 400/422 (unsupported
      // response_format/schema) are worth retrying with a looser strategy.
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
        break;
      }
    }
    throw new Error(`LLM appraiser ${lastErr}`);
  }
}

/** A value sent as JSON text, read back. Text that is not JSON is taken as the string it is. */
function fromJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
