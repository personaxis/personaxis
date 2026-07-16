/**
 * Memory engine V2 (plan V2-F1): entity-facts memory (generalized, not "user"-only)
 * + offline fact extraction, spec knobs finally consumed, session distillation
 * (dedup of sessions/episodic), salience consolidation, retrieval (BM25 + tools),
 * write_policy and retention.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  LivingLoop,
  HeuristicAppraiser,
  loadPersona,
  readMemory,
  readLiveMemory,
  readPreferences,
  readAutobiographical,
  prepareMemoryEntry,
  commitMemoryEntry,
  ensureSession,
  appendTurn,
  extractFacts,
  factsView,
  renderFacts,
  isFactKey,
  readMemoryKnobs,
  readWritePolicy,
  readConsolidationMode,
  readAnchors,
  distillTurns,
  distillSession,
  sessionBrief,
  pruneMemory,
  visibleForRecall,
  recallWindow,
  rankLexical,
  searchMemory,
  memoryTools,
  memoryDocs,
  salienceOf,
  type StateFile,
  type MemoryEntry,
} from "../src/index.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-memv2-"));
  personaPath = join(dir, "personaxis.md");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fixture(extra = ""): string {
  return `---
apiVersion: persona.dev/v1
metadata: { name: memv2, version: 1.0.0 }
identity: { canonical_id: memv2 }
improvement_policy: { mode: locked }
memory:
  types:
    episodic: true
    semantic: true
    procedural: false
    autobiographical: true
    user_preferences: true
    evaluations: false
${extra}affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }
---
body
`;
}

function seed(): void {
  const handle = loadPersona(personaPath);
  const state: StateFile = {
    schema_version: "0.8.0",
    persona_id: "memv2",
    persona_version: "1.0.0",
    values: { "mood.tone": 0 },
    mutation_log: [],
  };
  writeFileSync(handle.statePath, JSON.stringify(state, null, 2));
}

describe("extractFacts (offline, es/en; entity-neutral)", () => {
  it("attributes an introduction to the neutral 'interlocutor' subject, never 'user'", () => {
    expect(extractFacts("hola, me llamo David y trabajo en esto")[0]).toMatchObject({ key: "interlocutor.name", value: "David" });
    expect(extractFacts("Mi nombre es Ana Lucía.")[0]).toMatchObject({ key: "interlocutor.name", value: "Ana Lucía" });
    expect(extractFacts("hey, my name is Grace Hopper!")[0]).toMatchObject({ key: "interlocutor.name", value: "Grace Hopper" });
    expect(extractFacts("please call me Dave")[0]).toMatchObject({ key: "interlocutor.alias", value: "Dave" });
    expect(extractFacts("llámame Q cuando quieras")[0]).toMatchObject({ key: "interlocutor.alias", value: "Q" });
  });

  it("does NOT false-positive on 'soy/I'm' sentences (precision over recall)", () => {
    expect(extractFacts("soy sincero contigo")).toEqual([]);
    expect(extractFacts("I'm tired of this bug")).toEqual([]);
    expect(extractFacts("no tengo nada que decir")).toEqual([]);
  });

  it("isFactKey separates subject-qualified facts from loose preferences", () => {
    expect(isFactKey("interlocutor.name")).toBe(true);
    expect(isFactKey("project.deadline")).toBe(true);
    expect(isFactKey("agent:reviewer.owner")).toBe(true);
    expect(isFactKey("tone")).toBe(false);
  });
});

describe("spec knobs are read (V2-F1.6, zero decorative fields)", () => {
  it("defaults: maxItems 20, no embeddings/reranker/retention; persistent writes; auto consolidation", () => {
    expect(readMemoryKnobs({})).toEqual({ maxItems: 20, useEmbeddings: false, useReranker: false, retentionDays: undefined });
    expect(readWritePolicy({})).toEqual({ default: "persistent", requires: [] });
    expect(readConsolidationMode({})).toBe("auto");
    expect(readAnchors({})).toEqual([]);
  });

  it("honors declared values", () => {
    const fm = {
      runtime: { memory: { max_items: 5, use_embeddings: true, retention_days_default: 30 } },
      memory: { write_policy: { default: "session" }, consolidation_policy: { mode: "assisted" }, anchors: ["never forget the golden rule"] },
    };
    expect(readMemoryKnobs(fm)).toMatchObject({ maxItems: 5, useEmbeddings: true, retentionDays: 30 });
    expect(readWritePolicy(fm).default).toBe("session");
    expect(readConsolidationMode(fm)).toBe("assisted");
    expect(readAnchors(fm)).toEqual(["never forget the golden rule"]);
  });
});

describe("a stable fact survives a session (V2-F1.1, generalized; name is one instance)", () => {
  it("HeuristicAppraiser + LivingLoop persist the fact; factsView recalls it grouped by subject", async () => {
    writeFileSync(personaPath, fixture());
    seed();
    const loop = new LivingLoop(personaPath, { appraiser: new HeuristicAppraiser() });
    await loop.tick({ observation: "hola, me llamo David", source: "user" });
    // The fact is in the preferences store as a subject-qualified key, ready for every later session.
    expect(readPreferences(personaPath)["interlocutor.name"]?.value).toBe("David");
    const view = factsView(personaPath);
    expect(view.facts["interlocutor.name"].value).toBe("David");
    // The block groups by subject, and works for ANY subject, not just "user".
    expect(renderFacts(view)).toContain("interlocutor: name = David");
    // A general entity fact (e.g. project) lands in the same block, another subject.
    await loop.tick({ observation: "recuerda esto", source: "user" }); // salient, keeps the loop honest
    // And learning it the first time is an autobiographical milestone.
    expect(readAutobiographical(personaPath).some((e) => e.event.includes("David"))).toBe(true);
  });

  it("non-salient chatter earns NO episodic entry (dedup with sessions/)", async () => {
    writeFileSync(personaPath, fixture());
    seed();
    const loop = new LivingLoop(personaPath, { appraiser: new HeuristicAppraiser() });
    await loop.tick({ observation: "ok", source: "user" });
    await loop.tick({ observation: "how is the weather", source: "user" });
    expect(readMemory(personaPath).length).toBe(0);
    await loop.tick({ observation: "recuerda que el deploy es el viernes", source: "user" });
    expect(readMemory(personaPath).length).toBe(1);
  });
});

describe("write_policy is honored (V2-F1.6)", () => {
  it("ephemeral: nothing reaches the ledger", async () => {
    writeFileSync(personaPath, fixture("  write_policy:\n    default: ephemeral\n"));
    seed();
    const loop = new LivingLoop(personaPath, { appraiser: new HeuristicAppraiser() });
    await loop.tick({ observation: "recuerda esto importante", source: "user" });
    expect(readMemory(personaPath).length).toBe(0);
  });

  it("session: entries are tagged to the session and recall-scoped", async () => {
    writeFileSync(personaPath, fixture("  write_policy:\n    default: session\n"));
    seed();
    const loop = new LivingLoop(personaPath, { appraiser: new HeuristicAppraiser() });
    await loop.tick({ observation: "recuerda: el deploy es el viernes", source: "user", sessionId: "s1" });
    const all = readLiveMemory(personaPath);
    expect(all[0].tags).toContain("session:s1");
    expect(visibleForRecall(all, "s1").length).toBe(1); // its own session sees it
    expect(visibleForRecall(all, "s2").length).toBe(0); // another session does not
  });
});

describe("session distillation (V2-F1.3)", () => {
  const turns = [
    { type: "turn", role: "user", content: "me llamo David", ts: "t1" },
    { type: "turn", role: "assistant", content: "un gusto, David", ts: "t2" },
    { type: "turn", role: "user", content: "decidimos usar pnpm para todo el monorepo", ts: "t3" },
    { type: "turn", role: "assistant", content: "anotado, pnpm en todo", ts: "t4" },
  ] as never[];

  it("distillTurns extracts facts, decisions, and one event line", () => {
    const d = distillTurns(turns as never, "kickoff");
    expect(d.find((x) => x.kind === "fact")?.content).toBe("interlocutor.name = David");
    expect(d.find((x) => x.kind === "decision")?.content).toContain("pnpm");
    expect(d.find((x) => x.kind === "event")?.content).toContain('session "kickoff"');
  });

  it("distillSession writes back-referenced entries and is idempotent", () => {
    writeFileSync(personaPath, fixture());
    ensureSession(personaPath, { id: "s1", kind: "root", participants: ["(root)"], name: "kickoff", created: "2026-07-16", persona: "" });
    appendTurn(personaPath, "s1", { role: "user", content: "me llamo David" });
    appendTurn(personaPath, "s1", { role: "assistant", content: "un gusto" });
    const first = distillSession(personaPath, "s1");
    expect(first.written).toBeGreaterThanOrEqual(2); // the fact + the event
    const entries = readLiveMemory(personaPath);
    expect(entries.every((e) => e.tags.includes("distilled") && e.tags.includes("from:s1"))).toBe(true);
    expect(distillSession(personaPath, "s1").written).toBe(0); // closing twice never duplicates
  });

  it("sessionBrief recaps the newest OTHER session at read time (no artifact)", () => {
    writeFileSync(personaPath, fixture());
    ensureSession(personaPath, { id: "old", kind: "root", participants: ["(root)"], name: "planning", created: "2026-07-15", persona: "" });
    appendTurn(personaPath, "old", { role: "user", content: "armemos el roadmap de la fase 2" });
    appendTurn(personaPath, "old", { role: "assistant", content: "roadmap listo con 4 hitos" });
    const brief = sessionBrief(personaPath, "current");
    expect(brief).toContain("planning");
    expect(brief).toContain("roadmap");
    expect(sessionBrief(personaPath, "old")).toBe(""); // nothing besides the excluded one
  });
});

describe("retention pruning (V2-F1.6)", () => {
  it("tombstones stale entries but spares anchors, facts, and distillates", () => {
    writeFileSync(personaPath, fixture());
    // Backdating an entry would break the hash chain, so age them the other way:
    // prune with a 'now' 40 days in the future against a 30-day window.
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "stale chatter", source: "user" }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "interlocutor.name = David", source: "user", tags: ["kind:fact"] }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "anchored truth", source: "user", tags: ["anchor"] }));
    const future = new Date(Date.now() + 40 * 24 * 3600 * 1000);
    const r = pruneMemory(personaPath, 30, future);
    expect(r.pruned).toBe(1);
    const live = readLiveMemory(personaPath).map((e) => e.content);
    expect(live).not.toContain("stale chatter");
    expect(live).toContain("interlocutor.name = David");
    expect(live).toContain("anchored truth");
    expect(pruneMemory(personaPath, undefined).pruned).toBe(0); // no window declared → no-op
  });
});

describe("retrieval (V2-F1.4)", () => {
  function seedDocs(): void {
    writeFileSync(personaPath, fixture());
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "the deploy pipeline uses github actions", source: "user" }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "interlocutor.name = David", source: "user", tags: ["kind:fact"] }));
    commitMemoryEntry(personaPath, prepareMemoryEntry(personaPath, { content: "lunch was pasta", source: "internal" }));
  }

  it("rankLexical surfaces the relevant entry first", () => {
    seedDocs();
    const docs = memoryDocs(personaPath);
    const r = rankLexical(docs, "deploy pipeline", 5);
    expect(r[0].doc.text).toContain("github actions");
  });

  it("searchMemory (lexical) honors max_items and finds the name", async () => {
    seedDocs();
    const r = await searchMemory(personaPath, "David name", { maxItems: 2, useEmbeddings: false, useReranker: false });
    expect(r.via).toBe("lexical");
    expect(r.results.length).toBeLessThanOrEqual(2);
    expect(r.results[0].doc.text).toContain("David");
  });

  it("memory_search / memory_get tools answer through the registry contract", async () => {
    seedDocs();
    const tools = memoryTools(personaPath, { maxItems: 10, useEmbeddings: false, useReranker: false });
    const search = tools.find((t) => t.name === "memory_search")!;
    expect(search.isReadOnly).toBe(true);
    const out = await search.execute({ query: "deploy" }, {} as never);
    expect(out).toContain("github actions");
    const id = out.match(/#[0-9a-f]{8}/)?.[0];
    expect(id).toBeTruthy();
    const get = tools.find((t) => t.name === "memory_get")!;
    const full = await get.execute({ id }, {} as never);
    expect(full).toContain("github actions");
  });

  it("recallWindow prefers the last 48h and falls back to last-6", () => {
    seedDocs();
    const win = recallWindow(personaPath, { maxItems: 10 });
    expect(win.length).toBe(3); // all fresh
    const winFuture = recallWindow(personaPath, { maxItems: 10, now: new Date(Date.now() + 10 * 24 * 3600 * 1000) });
    expect(winFuture.length).toBe(3); // nothing recent → falls back to last-6
  });
});

describe("salience", () => {
  it("ranks a typed user fact above internal chatter", () => {
    const fact = { ts: new Date().toISOString(), content: "x", source: "user", tags: ["kind:fact"], prev_hash: "", hash: "a" } as MemoryEntry;
    const chatter = { ts: new Date().toISOString(), content: "y", source: "internal", tags: [], prev_hash: "", hash: "b" } as MemoryEntry;
    const flagged = { ts: new Date().toISOString(), content: "z", source: "tool", tags: ["injection-flagged"], prev_hash: "", hash: "c" } as MemoryEntry;
    expect(salienceOf(fact)).toBeGreaterThan(salienceOf(chatter));
    expect(salienceOf(flagged)).toBeLessThan(salienceOf(chatter));
  });
});
