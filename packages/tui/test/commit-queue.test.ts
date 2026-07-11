/**
 * The newline-gated markdown commit queue (FR.3): committed lines must never
 * change again, so open fences and growing tables are HELD in the live
 * region until provably complete.
 */
import { describe, it, expect } from "vitest";
import { CommitQueue } from "../src/streaming/commit-queue.js";

describe("CommitQueue", () => {
  it("commits only complete lines; the partial tail stays live", () => {
    const q = new CommitQueue();
    expect(q.push("hola ")).toEqual([]);
    expect(q.pending()).toBe("hola ");
    expect(q.push("mundo\nsegunda lí")).toEqual(["hola mundo"]);
    expect(q.pending()).toBe("segunda lí");
    expect(q.flush()).toEqual(["segunda lí"]);
    expect(q.pending()).toBe("");
  });

  it("holds an open ``` fence and commits the block atomically on close", () => {
    const q = new CommitQueue();
    expect(q.push("antes\n```ts\nconst x = 1;\n")).toEqual(["antes"]);
    // Fence open: nothing commits, all held in the live region.
    expect(q.pending()).toContain("```ts");
    expect(q.pending()).toContain("const x = 1;");
    expect(q.push("const y = 2;\n")).toEqual([]);
    const committed = q.push("```\n");
    expect(committed).toEqual(["```ts", "const x = 1;", "const y = 2;", "```"]);
    expect(q.pending()).toBe("");
  });

  it("TABLE-HOLDBACK: rows are held until a non-table line proves the table done", () => {
    const q = new CommitQueue();
    expect(q.push("| a | b |\n| --- | --- |\n| 1 | 2 |\n")).toEqual([]);
    expect(q.pending()).toContain("| 1 | 2 |");
    // Another row: still growing, still held.
    expect(q.push("| 3 | 4 |\n")).toEqual([]);
    // A prose line closes the table: everything commits together, in order.
    expect(q.push("después\n")).toEqual(["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "después"]);
  });

  it("flush() commits a still-open table or fence as-is (end of stream)", () => {
    const q = new CommitQueue();
    q.push("| a |\n| - |\n");
    expect(q.flush()).toEqual(["| a |", "| - |"]);
    const q2 = new CommitQueue();
    q2.push("```\nabierto\n");
    expect(q2.flush()).toEqual(["```", "abierto"]);
    // After flush, fence state resets, the queue is reusable.
    expect(q2.push("normal\n")).toEqual(["normal"]);
  });
});
