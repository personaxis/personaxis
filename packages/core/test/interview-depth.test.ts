/**
 * Two interviews over ONE question bank, and a draft that survives an abandoned run.
 *
 * The bank is tagged per item rather than kept as two lists, because two lists drift: an
 * item added to the bank and forgotten in the "quick" array would silently never be asked.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ITEM_BANK, ITEM_BANK_VERSION } from "../src/genesis/item-bank.js";
import { pendingItems } from "../src/genesis/interview.js";
import { saveDraft, loadDraft, clearDraft, draftPath } from "../src/genesis/draft.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-draft-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("interview depth", () => {
  it("EVERY item declares a depth: no question can be silently unreachable", () => {
    for (const item of ITEM_BANK) {
      expect(["core", "deep"], `${item.id} has no valid depth`).toContain(item.depth);
    }
  });

  it("the core interview is twelve questions, and covers what decides WHO it is", () => {
    const core = pendingItems({}, "core");
    expect(core).toHaveLength(12);
    const constructs = core.map((i) => i.construct).join(" ");
    // Identity, the five trait axes, values, voice, and the hard refusals.
    expect(constructs).toContain("identity.display_name");
    expect(constructs).toContain("identity.system_identity.purpose");
    for (const trait of ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"]) {
      expect(constructs, `core must ask ${trait}`).toContain(`personality.traits.${trait}`);
    }
    expect(constructs).toContain("values_and_drives.values");
    expect(constructs).toContain("persona.voice.tone");
    expect(constructs).toContain("character.prohibited_behaviors");
  });

  it("the deep interview is a SUPERSET: it never drops a core question", () => {
    const core = pendingItems({}, "core").map((i) => i.id);
    const deep = pendingItems({}, "deep").map((i) => i.id);
    expect(deep.length).toBeGreaterThan(core.length);
    for (const id of core) expect(deep, `deep dropped ${id}`).toContain(id);
    expect(deep).toHaveLength(ITEM_BANK.length);
  });

  it("both depths skip what has already been answered", () => {
    const answered = { "id-name": "Clio", "t-open": 4 };
    const core = pendingItems(answered, "core").map((i) => i.id);
    expect(core).not.toContain("id-name");
    expect(core).not.toContain("t-open");
    expect(core).toHaveLength(10);
  });

  it("defaults to the full bank, so existing callers are unchanged", () => {
    expect(pendingItems({})).toHaveLength(ITEM_BANK.length);
  });
});

describe("interview drafts", () => {
  it("round-trips the answers given so far", () => {
    saveDraft(dir, { answers: { "id-name": "Clio", "t-open": 5 }, depth: "deep", bankVersion: ITEM_BANK_VERSION });
    const d = loadDraft(dir, ITEM_BANK_VERSION);
    expect(d?.answers).toEqual({ "id-name": "Clio", "t-open": 5 });
    expect(d?.depth).toBe("deep");
    expect(d?.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("resuming a draft leaves exactly the unanswered questions", () => {
    saveDraft(dir, {
      answers: { "id-name": "Clio", "id-role": "reviewer", "id-purpose": "review code" },
      depth: "core",
      bankVersion: ITEM_BANK_VERSION,
    });
    const d = loadDraft(dir, ITEM_BANK_VERSION)!;
    expect(pendingItems(d.answers, d.depth)).toHaveLength(9);
  });

  /**
   * Answers are keyed by item id. Replaying them into a CHANGED bank would map an answer
   * onto a question that no longer asks what it asked, so a draft from another version is
   * discarded rather than resumed.
   */
  it("refuses a draft written against a different question bank", () => {
    saveDraft(dir, { answers: { "id-name": "Clio" }, depth: "core", bankVersion: "0.0.1-old" });
    expect(loadDraft(dir, ITEM_BANK_VERSION)).toBeUndefined();
  });

  it("offers nothing when there is no draft, an empty one, or a torn file", () => {
    expect(loadDraft(dir, ITEM_BANK_VERSION)).toBeUndefined();
    saveDraft(dir, { answers: {}, depth: "core", bankVersion: ITEM_BANK_VERSION });
    expect(loadDraft(dir, ITEM_BANK_VERSION), "an empty draft is not worth resuming").toBeUndefined();
    mkdirSync(dirname(draftPath(dir)), { recursive: true });
    writeFileSync(draftPath(dir), "{ not json", "utf-8");
    expect(loadDraft(dir, ITEM_BANK_VERSION)).toBeUndefined();
  });

  it("clears cleanly, and clearing twice is not an error", () => {
    saveDraft(dir, { answers: { "id-name": "Clio" }, depth: "core", bankVersion: ITEM_BANK_VERSION });
    expect(existsSync(draftPath(dir))).toBe(true);
    clearDraft(dir);
    expect(existsSync(draftPath(dir))).toBe(false);
    expect(() => clearDraft(dir)).not.toThrow();
  });
});
