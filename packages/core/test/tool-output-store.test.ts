/**
 * J.6: a big tool output is offloaded to a handle (not truncated), and recovered on demand.
 * A small output passes through unchanged; a 100k log becomes a short preview + pointer and is
 * still readable by slice/grep.
 */
import { describe, it, expect } from "vitest";
import { ToolOutputStore, outputStoreTools, OFFLOAD_THRESHOLD, PREVIEW_CHARS } from "../src/tool-output-store.js";
import { DEFAULT_POLICY } from "../src/sandbox.js";
import { noExecution } from "../src/ports/execution.js";

/**
 * E32: the third argument is the ExecutionPort, WHERE the action happens, and these
 * calls were leaving it out. One that refuses everything rather than a live one, so
 * the call also asserts what it should: none of these tools touches the machine.
 */
const INERT = noExecution("this tool must not act");

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

  it("never stores a window of a stored output again, which used to loop until the step ran out", () => {
    // Found 2026-09-11 in the E52 bench: read_output(out-1, limit 200) returned the whole
    // file, which crossed the threshold and was stored as out-2, which was read the same way,
    // 19 times in one step, and the step failed without writing anything.
    const store = new ToolOutputStore();
    const review = Array.from({ length: 90 }, (_, i) => `line ${i}: ${"the refund amount is not validated ".repeat(2)}`).join("\n");
    expect(review.length).toBeGreaterThan(OFFLOAD_THRESHOLD);
    expect(store.offload("read_file", review).handle).toBe("out-1");
    const window = store.slice("out-1", 0, 200);
    // The window fits, so it would not be stored...
    expect(window.length).toBeLessThan(OFFLOAD_THRESHOLD);
    // ...and it says where to go on from.
    expect(window).toMatch(/remain; call again with offset \d+/);
    // Even a window that did not fit is never stored under a new handle.
    expect(store.offload("read_output", review).offloaded).toBe(false);
    expect(store.offload("grep_output", review).offloaded).toBe(false);
    expect(store.size).toBe(1);
  });

  it("pages through a stored output to its end, each window fitting", () => {
    const store = new ToolOutputStore();
    const text = Array.from({ length: 300 }, (_, i) => `row ${i} ${"x".repeat(60)}`).join("\n");
    store.offload("run_command", text);
    let offset = 0;
    let seen = 0;
    for (let guard = 0; guard < 50; guard++) {
      const w = store.slice("out-1", offset, 1000);
      expect(w.length).toBeLessThan(OFFLOAD_THRESHOLD);
      const next = /call again with offset (\d+)/.exec(w);
      seen += w.split("\n").filter((l) => l.startsWith("row ")).length;
      if (!next) break;
      offset = Number(next[1]);
    }
    expect(seen).toBe(300);
  });

  it("cuts a single line longer than the budget instead of sending it whole", () => {
    const store = new ToolOutputStore();
    store.offload("run_command", "y".repeat(OFFLOAD_THRESHOLD * 3));
    const w = store.slice("out-1", 0, 1);
    expect(w.length).toBeLessThan(OFFLOAD_THRESHOLD);
    expect(w).toContain("line cut at");
  });

  it("keeps a search under the threshold too", () => {
    const store = new ToolOutputStore();
    store.offload("run_command", Array.from({ length: 400 }, (_, i) => `ERROR ${i} ${"z".repeat(80)}`).join("\n"));
    const hits = store.grep("out-1", "ERROR");
    expect(hits.length).toBeLessThan(OFFLOAD_THRESHOLD);
    expect(hits).toContain("narrow the pattern");
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
    const out = await read.execute({ handle: "out-1", offset: 10, limit: 3 }, DEFAULT_POLICY, INERT);
    expect(out).toContain("L10");
    expect(out).toContain("L12");
  });

  it("grep_output tool searches by pattern; both tools are read-only and allowed", async () => {
    const store = new ToolOutputStore();
    store.offload("run_command", ("alpha\nbeta ERROR here\ngamma").padEnd(OFFLOAD_THRESHOLD + 1));
    const [read, grep] = outputStoreTools(store);
    expect(read.isReadOnly && grep.isReadOnly).toBe(true);
    expect(read.gate({}, DEFAULT_POLICY).decision).toBe("allow");
    const out = await grep.execute({ handle: "out-1", pattern: "ERROR" }, DEFAULT_POLICY, INERT);
    expect(out).toContain("beta ERROR here");
  });

  /**
   * E109: a document gets its outline, with the line each section starts on.
   *
   * Measured 2026-09-22 with the autonomy bench. Asked which sources its advice on game feel rested on, a
   * persona opened the right 9,836-character file and then answered from the preview, which is the first 800
   * characters, which happen to be the first section: it cited the sources of "core loops" in six runs out of
   * six. The one run that searched for "game feel juice" got the heading line back and nothing else, because
   * grep returns matching LINES. Knowing a section exists is not enough; the only way to read one is
   * read_output at its offset, and offsets here are lines.
   */
  describe("the preview of a document (E109)", () => {
    /**
     * A reference with a title, an intro, and sections whose contents are what somebody would want.
     *
     * Big enough to be offloaded, which a first version was not: under the threshold the store passes the
     * content through untouched and there is no preview to test at all.
     */
    const document = (): string => {
      const section = (n: string, body: string) => `### ${n}\n\n${body}\n\n${"filler line that makes this section long enough to matter\n".repeat(40)}`;
      const text =
        `# What was read on the web\n\nSearched with a tool.\n\n` +
        section("core loops", "- [A core loop guide](https://example.com/loops)") +
        section("game feel and juice", "- [The juice guide](https://example.com/juice)") +
        section("level design", "- [A level guide](https://example.com/levels)");
      expect(text.length).toBeGreaterThan(OFFLOAD_THRESHOLD);
      return text;
    };

    it("shows the sections and the line each starts on, not the first 800 characters", () => {
      const store = new ToolOutputStore();
      const text = store.offload("read_file", document()).text;

      expect(text).toContain("Its sections:");
      expect(text).toMatch(/line \d+: ### game feel and juice/);
      // The head is exactly what it must NOT answer from: the first section's link is not in the preview.
      expect(text).not.toContain("example.com/loops");
    });

    it("gives a line number read_output can use to bring back that section's contents", () => {
      const store = new ToolOutputStore();
      const text = store.offload("read_file", document()).text;
      const at = /line (\d+): ### game feel and juice/.exec(text);

      expect(at).not.toBeNull();
      // The whole point: from the outline to the thing the question was about, in one call.
      const section = store.slice("out-1", Number(at![1]), 4);
      expect(section).toContain("example.com/juice");
      expect(section).not.toContain("example.com/loops");
    });

    it("says that grep returns lines, which is the trap the measurement found", () => {
      const store = new ToolOutputStore();
      const text = store.offload("read_file", document()).text;

      expect(text).toContain("returns the matching LINES only");
      // And it is true: searching for the heading gives the heading, not the link under it.
      const hit = store.grep("out-1", "game feel and juice");
      expect(hit).toContain("### game feel and juice");
      expect(hit).not.toContain("example.com/juice");
    });

    it("leaves an output with no headings on its head, because an outline of nothing says nothing", () => {
      const store = new ToolOutputStore();
      const log = Array.from({ length: 900 }, (_, i) => `2026-09-22 worker ${i} did something`).join("\n");
      const text = store.offload("run_command", log).text;

      expect(text).toContain("worker 0 did something");
      expect(text).toContain("output truncated in context");
      expect(text).not.toContain("Its sections:");
    });

    it("falls back to the head when the outline does not fit, rather than showing part of one", () => {
      const store = new ToolOutputStore();
      const many = Array.from({ length: 200 }, (_, i) => `### section ${i} with a long enough title to blow the budget\n\nbody\n`).join("\n");
      const text = store.offload("read_file", `# Huge\n\n${many}`).text;

      expect(text).not.toContain("Its sections:");
      expect(text).toContain("output truncated in context");
    });
  });
});
