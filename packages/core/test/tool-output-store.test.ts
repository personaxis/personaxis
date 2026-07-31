/**
 * J.6: a big tool output is offloaded to a handle (not truncated), and recovered on demand.
 * A small output passes through unchanged; a 100k log becomes a short preview + pointer and is
 * still readable by slice/grep.
 */
import { describe, it, expect } from "vitest";
import { ToolOutputStore, outputStoreTools, OFFLOAD_THRESHOLD, PREVIEW_CHARS } from "../src/tool-output-store.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";

describe("ToolOutputStore", () => {
  it("passes a small output through unchanged (no offload)", () => {
    const store = new ToolOutputStore();
    const r = store.offload("run_command", "ok, done");
    expect(r.offloaded).toBe(false);
    expect(r.text).toBe("ok, done");
    expect(store.size).toBe(0);
  });

  it("offloads a 100k log to a small preview + handle, recoverable by slice", () => {
    const store = new ToolOutputStore();
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    expect(big.length).toBeGreaterThan(OFFLOAD_THRESHOLD);
    const r = store.offload("run_command", big);
    expect(r.offloaded).toBe(true);
    expect(r.handle).toBe("out-1");
    // what the model sees is bounded, not the whole 100k
    expect(r.text.length).toBeLessThan(PREVIEW_CHARS + 400);
    expect(r.text).toContain("stored as 'out-1'");
    // the tail is recoverable
    const win = store.slice("out-1", 4990, 5);
    expect(win).toContain("line 4990");
    expect(win).toContain("line 4994");
  });

  it("grep finds matching lines in an offloaded output", () => {
    const store = new ToolOutputStore();
    const log = ["INFO start", "WARN slow", "ERROR boom at foo.ts:12", "INFO done"].join("\n").padEnd(OFFLOAD_THRESHOLD + 1, " ");
    store.offload("run_command", log);
    const hits = store.grep("out-1", "ERROR");
    expect(hits).toContain("ERROR boom at foo.ts:12");
    expect(store.grep("out-1", "/w.rn/i")).toContain("WARN slow");
  });

  it("reports a missing handle rather than throwing", () => {
    const store = new ToolOutputStore();
    expect(store.slice("out-9")).toContain("no stored output");
    expect(store.grep("out-9", "x")).toContain("no stored output");
  });

  it("gives deterministic sequential handles per store", () => {
    const store = new ToolOutputStore();
    const big = "x".repeat(OFFLOAD_THRESHOLD + 1);
    expect(store.offload("t", big).handle).toBe("out-1");
    expect(store.offload("t", big).handle).toBe("out-2");
  });
});

describe("outputStoreTools", () => {
  it("read_output returns the requested window", async () => {
    const store = new ToolOutputStore();
    store.offload("run_command", Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n").padEnd(OFFLOAD_THRESHOLD + 1));
    const [read] = outputStoreTools(store);
    const out = await read.execute({ handle: "out-1", offset: 10, limit: 3 }, DEFAULT_POLICY);
    expect(out).toContain("L10");
    expect(out).toContain("L12");
  });

  it("grep_output tool searches by pattern; both tools are read-only and allowed", async () => {
    const store = new ToolOutputStore();
    store.offload("run_command", ("alpha\nbeta ERROR here\ngamma").padEnd(OFFLOAD_THRESHOLD + 1));
    const [read, grep] = outputStoreTools(store);
    expect(read.isReadOnly && grep.isReadOnly).toBe(true);
    expect(read.gate({}, DEFAULT_POLICY).decision).toBe("allow");
    const out = await grep.execute({ handle: "out-1", pattern: "ERROR" }, DEFAULT_POLICY);
    expect(out).toContain("beta ERROR here");
  });
});
