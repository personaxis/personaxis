import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLedger, type SkillCandidate } from "../src/index.js";

let dir: string;
let ledger: SkillLedger;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-skl-"));
  ledger = new SkillLedger(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("skill attribution", () => {
  it("tracks uses + outcomes into a success rate", () => {
    ledger.register("planner", "1.0.0");
    ledger.recordUse("planner", "1.0.0");
    ledger.recordOutcome("planner", "1.0.0", true);
    ledger.recordOutcome("planner", "1.0.0", true);
    ledger.recordOutcome("planner", "1.0.0", false);
    const s = ledger.stats("planner", "1.0.0");
    expect(s.uses).toBe(1);
    expect(s.successRate).toBeCloseTo(2 / 3, 3);
    expect(s.status).toBe("active");
  });
});

describe("evidence-gated evolution", () => {
  it("does not promote without a minimum sample", () => {
    ledger.recordOutcome("s", "2.0.0", true);
    const d = ledger.evolve("s", "1.0.0", "2.0.0", { minSample: 5 });
    expect(d.promoted).toBe(false);
    expect(d.reason).toMatch(/minSample/);
  });

  it("promotes a better version and deprecates the old one", () => {
    // incumbent 1.0.0: 50% over 4 outcomes
    for (let i = 0; i < 2; i++) ledger.recordOutcome("s", "1.0.0", true);
    for (let i = 0; i < 2; i++) ledger.recordOutcome("s", "1.0.0", false);
    // candidate 2.0.0: 100% over 6 outcomes
    for (let i = 0; i < 6; i++) ledger.recordOutcome("s", "2.0.0", true);
    const d = ledger.evolve("s", "1.0.0", "2.0.0", { minSample: 5, margin: 0.02 });
    expect(d.promoted).toBe(true);
    expect(ledger.stats("s", "1.0.0").status).toBe("deprecated");
    expect(ledger.stats("s", "2.0.0").status).toBe("active");
  });

  it("does not promote a regression", () => {
    for (let i = 0; i < 8; i++) ledger.recordOutcome("s", "1.0.0", true);
    for (let i = 0; i < 5; i++) ledger.recordOutcome("s", "2.0.0", i < 2); // 40%
    const d = ledger.evolve("s", "1.0.0", "2.0.0", { minSample: 5 });
    expect(d.promoted).toBe(false);
  });
});

describe("recommendation", () => {
  const candidates: SkillCandidate[] = [
    { skill: "growth-audit", version: "1.0.0", capabilities: ["growth", "audit", "funnel"], reviewVerdict: "ok" },
    { skill: "evil", version: "1.0.0", capabilities: ["growth", "audit"], reviewVerdict: "danger" },
    { skill: "risky", version: "1.0.0", capabilities: ["growth"], reviewVerdict: "review" },
  ];

  it("excludes dangerous skills and ranks by match × trust × success", () => {
    ledger.recordOutcome("growth-audit", "1.0.0", true);
    ledger.recordOutcome("growth-audit", "1.0.0", true);
    const recs = ledger.recommend(candidates, ["growth", "audit"]);
    expect(recs.map((r) => r.skill)).not.toContain("evil"); // dangerous excluded
    expect(recs[0].skill).toBe("growth-audit"); // best match + ok review + success
  });

  it("excludes deprecated skills", () => {
    ledger.deprecate("growth-audit", "1.0.0");
    const recs = ledger.recommend(candidates, ["growth", "audit"]);
    expect(recs.map((r) => r.skill)).not.toContain("growth-audit");
  });
});
