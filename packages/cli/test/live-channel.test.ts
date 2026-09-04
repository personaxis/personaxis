/**
 * E24: the ephemeral channel, and why it is a separate one.
 *
 * The workspace wire is DURABLE. Every event carries `seq`, the server stores it and
 * acknowledges it, and that acknowledgement is what makes a resume gapless. A
 * token-by-token delta on that channel would write the same sentence into the record a
 * hundred times in pieces, and a record of fragments is not a record of what happened.
 *
 * So the property under test is not "deltas arrive". It is that a delta NEVER REACHES
 * THE RECORD, is not counted as something the record lost, and leaves nothing behind
 * when nobody is listening.
 */
import { describe, it, expect } from "vitest";
import type { LoopEvent } from "@personaxis/core";
import type { WireEvent } from "@personaxis/protocol/workspace";

import { JobReporter } from "../src/workspace/job-reporter.js";

function reporter(over: Partial<ConstructorParameters<typeof JobReporter>[0]> = {}) {
  const emitted: WireEvent[] = [];
  const drops: Array<[string, string]> = [];
  const live: string[] = [];
  const r = new JobReporter({
    jobId: "job_1",
    sink: { emit: (e) => emitted.push(e) },
    onDrop: (kind, reason) => drops.push([kind, reason]),
    onLive: (delta) => live.push(delta),
    ...over,
  });
  return { r, emitted, drops, live };
}

const delta = (text: string): LoopEvent => ({ type: "agent-delta", text });

describe("the live channel is not the record (E24)", () => {
  it("a delta reaches the live channel and never the wire", () => {
    const { r, emitted, live } = reporter();
    r.report(delta("The "));
    r.report(delta("answer "));
    r.report(delta("is 4."));

    expect(live).toEqual(["The ", "answer ", "is 4."]);
    expect(emitted).toHaveLength(0);
  });

  it("a delta is not counted as something the record LOST", () => {
    // The distinction the whole row rests on: a drop is a decision about the record,
    // and this never had a place in it. Counting deltas as drops would make every
    // streamed turn look like a run with hundreds of missing events.
    const { r, drops } = reporter();
    for (let i = 0; i < 50; i++) r.report(delta("x"));
    expect(drops).toHaveLength(0);
    expect(r.dropped).toBe(0);
  });

  it("with nobody listening, a delta is discarded and leaves nothing behind", () => {
    const { r, emitted, drops } = reporter({ onLive: undefined });
    r.report(delta("nobody is watching"));
    expect(emitted).toHaveLength(0);
    expect(drops).toHaveLength(0);
    expect(r.dropped).toBe(0);
  });

  it("a delta does not disturb the call the record is tracking", () => {
    // Deltas arrive between a proposal and its result. If one closed or renamed the
    // call in flight, the verdict and the result would land under different ids, and
    // a gate would be freezing a call nobody could find.
    const { r, emitted, live } = reporter();
    r.report({ type: "tool-propose", tool: "read_file", args: { path: "a.txt" } } as LoopEvent);
    r.report(delta("thinking about it"));
    r.report({ type: "tool-result", tool: "read_file", ok: true, output: "contents" } as LoopEvent);

    expect(live).toEqual(["thinking about it"]);
    const ids = emitted.map((e) => (e as unknown as { call_id?: string }).call_id).filter(Boolean);
    expect(new Set(ids).size).toBe(1);
  });
});
