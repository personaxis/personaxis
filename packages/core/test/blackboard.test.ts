import { describe, it, expect } from "vitest";
import {
  Blackboard,
  orchestrate,
  matchScore,
  extractCapabilities,
  type Agent,
} from "../src/index.js";

const agents: Agent[] = [
  { id: "cmo", capabilities: ["marketing", "positioning", "brand", "growth", "demand"] },
  { id: "frontend", capabilities: ["react", "typescript", "ui", "css", "frontend"] },
  { id: "security", capabilities: ["security", "audit", "threat", "vulnerability", "review"] },
];

describe("capability matching", () => {
  it("scores by overlap with the task's needs", () => {
    const { score, matched } = matchScore(["brand", "positioning", "launch"], agents[0].capabilities);
    expect(matched.sort()).toEqual(["brand", "positioning"]);
    expect(score).toBeCloseTo(2 / 3, 3);
  });

  it("extracts capabilities from a persona frontmatter", () => {
    const caps = extractCapabilities({
      identity: {
        system_identity: { purpose: "Run the marketing function and own positioning", allowed_domains: ["marketing", "brand"] },
        role_identity: { primary_role: "chief_marketing_officer" },
      },
    });
    expect(caps).toEqual(expect.arrayContaining(["marketing", "positioning", "brand"]));
  });
});

describe("blackboard cycle", () => {
  it("posts, ranks volunteers, assigns the best, contributes, resolves", () => {
    const board = new Blackboard();
    const task = board.post("audit the security review and threat model");
    const ranked = board.solicit(task.id, agents);
    expect(ranked[0].id).toBe("security"); // best capability match
    const chosen = board.assign(task.id, agents);
    expect(chosen!.id).toBe("security");
    board.contribute(task.id, "security", "found 2 issues");
    board.resolve(task.id, "done");
    const t = board.get(task.id)!;
    expect(t.status).toBe("resolved");
    expect(t.contributions).toHaveLength(1);
    expect(board.log.map((e) => e.kind)).toEqual(["post", "assign", "contribute", "resolve"]);
  });

  it("routes a marketing task to the CMO, not the frontend persona", () => {
    const board = new Blackboard();
    const ranked = board.solicit(board.post("plan the brand positioning and growth launch").id, agents);
    expect(ranked[0].id).toBe("cmo");
  });

  it("orchestrate runs the full cycle with a pluggable worker", async () => {
    const board = new Blackboard();
    const res = await orchestrate(board, "build the react typescript ui", agents, {
      worker: (a, t) => `${a.id} did ${t.id}`,
    });
    expect(res.assigned!.id).toBe("frontend");
    expect(res.contribution).toBe("frontend did t1");
    expect(res.task.status).toBe("resolved");
  });

  it("returns null assignment when no agent matches", async () => {
    const board = new Blackboard();
    const res = await orchestrate(board, "quantum chromodynamics lattice", agents);
    expect(res.assigned).toBeNull();
  });
});
