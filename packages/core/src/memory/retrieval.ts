/**
 * On-demand memory retrieval (V2-F1.4): the "read on demand" that the resource
 * manifest used to promise but nothing implemented. Two agent tools are exposed,
 * `memory_search` (ranked lookup across every memory kind) and `memory_get`
 * (fetch one item in full), over a dependency-free lexical BM25 index built
 * in-memory per call (the stores are small files; no derived artifact on disk).
 *
 * The spec's `runtime.memory` knobs are consumed here: `max_items` bounds every
 * result set; `use_reranker` re-ranks the lexical top-k with the chat model when
 * one is configured; `use_embeddings` ranks by embeddings when the configured
 * endpoint actually serves /embeddings (probed once, cached), and otherwise falls
 * back to lexical with the reason stated in the tool observation, never silently.
 */

import { readLiveMemory, readSemanticMemory, type MemoryEntry } from "../memory.js";
import { readAutobiographical, readPreferences, readProcedural } from "../memory-kinds.js";
import type { MemoryKnobs } from "./knobs.js";
import type { ToolSpec } from "../tools/registry.js";

export interface MemoryDoc {
  kind: "episodic" | "semantic" | "procedural" | "autobiographical" | "preference";
  /** Stable id: episodic `#hash8`, others `<kind>:<index-or-key>`. */
  id: string;
  ts: string;
  text: string;
}

/**
 * Session-scope visibility (write_policy "session"): an entry tagged
 * `session:<id>` is recalled only inside ITS session, unless distillation marked
 * it durable (a `kind:*` or `distilled` tag). Audit surfaces still see everything.
 */
export function visibleForRecall(entries: MemoryEntry[], currentSessionId?: string): MemoryEntry[] {
  return entries.filter((e) => {
    const scope = e.tags.find((t) => t.startsWith("session:"));
    if (!scope) return true;
    if (currentSessionId && scope === `session:${currentSessionId}`) return true;
    return e.tags.some((t) => t.startsWith("kind:") || t === "distilled" || t === "anchor");
  });
}

/** The recent-memory window: today + yesterday first (OpenClaw's rule), capped by
 * `max_items`, falling back to the last 6 entries when the window is empty. */
export function recallWindow(personaPath: string, opts: { maxItems: number; sessionId?: string; now?: Date }): MemoryEntry[] {
  const live = visibleForRecall(readLiveMemory(personaPath), opts.sessionId);
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const recent = live.filter((e) => e.ts >= cutoff);
  const window = recent.length ? recent.slice(-opts.maxItems) : live.slice(-6);
  return window;
}

/** Every memory item as a searchable document. */
export function memoryDocs(personaPath: string, sessionId?: string): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  for (const e of visibleForRecall(readLiveMemory(personaPath), sessionId)) {
    docs.push({ kind: "episodic", id: `#${e.hash.slice(0, 8)}`, ts: e.ts, text: e.content });
  }
  readProcedural(personaPath).forEach((x, i) => docs.push({ kind: "procedural", id: `procedural:${i}`, ts: x.ts, text: `${x.task} -> ${x.procedure}` }));
  readAutobiographical(personaPath).forEach((x, i) => docs.push({ kind: "autobiographical", id: `autobiographical:${i}`, ts: x.ts, text: `${x.event}${x.detail ? `: ${x.detail}` : ""}` }));
  for (const [k, v] of Object.entries(readPreferences(personaPath))) {
    docs.push({ kind: "preference", id: `preference:${k}`, ts: v.ts, text: `${k}: ${v.value}` });
  }
  const semantic = readSemanticMemory(personaPath);
  if (semantic.trim()) {
    semantic.split(/\n{2,}/).forEach((para, i) => {
      if (para.trim().length > 20) docs.push({ kind: "semantic", id: `semantic:${i}`, ts: "", text: para.trim() });
    });
  }
  return docs;
}

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);

/** Lexical BM25 over the docs (k1=1.5, b=0.75). Deterministic, offline. */
export function rankLexical(docs: MemoryDoc[], query: string, limit: number): Array<{ doc: MemoryDoc; score: number }> {
  const q = tokenize(query);
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokenize(d.text));
  const avgLen = toks.reduce((a, t) => a + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const k1 = 1.5;
  const b = 0.75;
  const scored = docs.map((doc, i) => {
    const t = toks[i];
    const tf = new Map<string, number>();
    for (const term of t) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (t.length / avgLen))));
    }
    return { doc, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score).slice(0, limit);
}

export interface RetrievalLlm {
  endpoint: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Probe result cache: does this endpoint serve /embeddings for this model? */
const embedProbe = new Map<string, boolean>();

async function embed(llm: RetrievalLlm, inputs: string[]): Promise<number[][] | null> {
  const key = `${llm.endpoint}::${llm.model}`;
  if (embedProbe.get(key) === false) return null;
  const fetchImpl = llm.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${llm.endpoint.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}) },
      body: JSON.stringify({ model: llm.model, input: inputs }),
    });
    if (!res.ok) {
      embedProbe.set(key, false);
      return null;
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vecs = (json.data ?? []).map((d) => d.embedding ?? []);
    if (vecs.length !== inputs.length || vecs.some((v) => !v.length)) {
      embedProbe.set(key, false);
      return null;
    }
    embedProbe.set(key, true);
    return vecs;
  } catch {
    embedProbe.set(key, false);
    return null;
  }
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

export interface SearchResult {
  results: Array<{ doc: MemoryDoc; score: number }>;
  /** How the ranking was produced (surfaced in the tool observation, honesty over silence). */
  via: "lexical" | "embeddings" | "lexical+rerank";
  note?: string;
}

/** Ranked search across every memory kind, honoring the runtime.memory knobs. */
export async function searchMemory(
  personaPath: string,
  query: string,
  knobs: MemoryKnobs,
  opts: { sessionId?: string; llm?: RetrievalLlm } = {},
): Promise<SearchResult> {
  const docs = memoryDocs(personaPath, opts.sessionId);
  const limit = knobs.maxItems;

  if (knobs.useEmbeddings && opts.llm && docs.length) {
    const vecs = await embed(opts.llm, [query, ...docs.map((d) => d.text.slice(0, 512))]);
    if (vecs) {
      const [qv, ...dv] = vecs;
      const results = docs
        .map((doc, i) => ({ doc, score: cosine(qv, dv[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { results, via: "embeddings" };
    }
    const lex = rankLexical(docs, query, limit);
    return { results: lex, via: "lexical", note: "use_embeddings=true but the endpoint serves no /embeddings; fell back to lexical" };
  }

  const base = rankLexical(docs, query, knobs.useReranker && opts.llm ? limit * 2 : limit);
  if (knobs.useReranker && opts.llm && base.length > 1) {
    const reranked = await rerank(opts.llm, query, base.map((r) => r.doc));
    if (reranked) return { results: reranked.slice(0, limit), via: "lexical+rerank" };
    return { results: base.slice(0, limit), via: "lexical", note: "use_reranker=true but the rerank call failed; lexical order kept" };
  }
  return { results: base.slice(0, limit), via: "lexical" };
}

/** One chat call scoring each candidate 0-10 for relevance; null on any failure. */
async function rerank(llm: RetrievalLlm, query: string, docs: MemoryDoc[]): Promise<Array<{ doc: MemoryDoc; score: number }> | null> {
  const fetchImpl = llm.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${llm.endpoint.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}) },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: 'Score each memory item for relevance to the query, 0-10. Reply ONLY a JSON array of numbers, one per item, in order.' },
          { role: "user", content: `Query: ${query.slice(0, 300)}\n\nItems:\n${docs.map((d, i) => `${i + 1}. ${d.text.slice(0, 200)}`).join("\n")}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const m = (json.choices?.[0]?.message?.content ?? "").match(/\[[\s\S]*?\]/);
    if (!m) return null;
    const scores = JSON.parse(m[0]) as number[];
    if (!Array.isArray(scores) || scores.length !== docs.length) return null;
    return docs.map((doc, i) => ({ doc, score: Number(scores[i]) || 0 })).sort((a, b) => b.score - a.score);
  } catch {
    return null;
  }
}

/** Fetch one memory item in full by the id `memory_search` returned. */
export function getMemoryDoc(personaPath: string, id: string, sessionId?: string): MemoryDoc | undefined {
  return memoryDocs(personaPath, sessionId).find((d) => d.id === id);
}

const fmtResult = (r: { doc: MemoryDoc; score: number }): string =>
  `- [${r.doc.kind}] ${r.doc.id}${r.doc.ts ? ` (${r.doc.ts.slice(0, 10)})` : ""}: ${r.doc.text.replace(/\n+/g, " ").slice(0, 160)}`;

/**
 * The two read-only memory tools for the agent loop. Read-only, concurrency-safe,
 * always allowed (they only read the persona's own memory stores).
 */
export function memoryTools(personaPath: string, knobs: MemoryKnobs, opts: { sessionId?: string; llm?: RetrievalLlm } = {}): ToolSpec[] {
  const allow = { decision: "allow" as const, reason: "reads the persona's own memory", class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false } };
  return [
    {
      name: "memory_search",
      isReadOnly: true,
      isConcurrencySafe: true,
      description:
        "Search this persona's long-term memory (episodic, semantic, procedural, autobiographical, preferences) for anything not already in context: past sessions, user facts, decisions, how-tos. Returns ranked snippets with ids for memory_get.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", description: "What to look for (natural language or keywords)." } },
      },
      gate: () => allow,
      execute: async (args) => {
        const query = typeof args.query === "string" ? args.query : "";
        const r = await searchMemory(personaPath, query, knobs, opts);
        if (!r.results.length) return `no memory matched "${query}"${r.note ? ` (${r.note})` : ""}`;
        return [`${r.results.length} match(es) via ${r.via}${r.note ? ` (${r.note})` : ""}:`, ...r.results.map(fmtResult)].join("\n");
      },
    },
    {
      name: "memory_get",
      isReadOnly: true,
      isConcurrencySafe: true,
      description: "Fetch ONE memory item in full by the id memory_search returned (e.g. '#a1b2c3d4', 'procedural:2', 'preference:user.name').",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      gate: () => allow,
      execute: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        const doc = getMemoryDoc(personaPath, id, opts.sessionId);
        return doc ? `[${doc.kind}] ${doc.id}${doc.ts ? ` (${doc.ts})` : ""}\n${doc.text}` : `no memory item with id "${id}"`;
      },
    },
  ];
}
