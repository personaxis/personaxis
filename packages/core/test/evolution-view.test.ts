/**
 * F3.8, the appraiser evolution view (grounded editable-surface projection).
 */
import { describe, it, expect } from "vitest";
import { buildEvolutionView, renderEvolutionView, LlmAppraiser, type Envelope } from "../src/index.js";

const envelopes: Record<string, Envelope> = {
  "mood.tone": { mean: 0, min: -1, max: 1 },
  "traits.openness": { mean: 0.8, min: 0.65, max: 0.92 },
};

describe("F3.8 buildEvolutionView", () => {
  it("grounds each field in its current value, envelope, band, and headroom", () => {
    const v = buildEvolutionView({
      values: { "mood.tone": 0.9, "traits.openness": 0.8 },
      envelopes,
      editableSections: ["persona"],
      mode: "suggesting",
    });
    expect(v.mode).toBe("suggesting");
    const tone = v.fields.find((f) => f.path === "mood.tone")!;
    expect(tone.current).toBe(0.9);
    expect(tone.min).toBe(-1);
    expect(tone.max).toBe(1);
    expect(tone.band).toBe("high"); // 0.9 near the top
    expect(tone.headroomUp).toBe(0.1);
    expect(tone.headroomDown).toBe(1.9);
  });

  it("falls back to the envelope mean when the field has no stored value", () => {
    const v = buildEvolutionView({ values: {}, envelopes, editableSections: [], mode: "locked" });
    expect(v.fields.find((f) => f.path === "traits.openness")!.current).toBe(0.8);
  });

  it("flags at-min / at-max bands at the envelope edges", () => {
    const v = buildEvolutionView({
      values: { "mood.tone": -1, "traits.openness": 0.92 },
      envelopes,
      editableSections: [],
      mode: "autonomous",
    });
    expect(v.fields.find((f) => f.path === "mood.tone")!.band).toBe("at-min");
    expect(v.fields.find((f) => f.path === "traits.openness")!.band).toBe("at-max");
  });
});

describe("F3.8 renderEvolutionView", () => {
  it("renders current/range/headroom per field and the mode", () => {
    const text = renderEvolutionView(
      buildEvolutionView({ values: { "mood.tone": 0.9 }, envelopes: { "mood.tone": envelopes["mood.tone"] }, editableSections: ["persona"], mode: "suggesting" }),
    );
    expect(text).toContain("improvement mode: suggesting");
    expect(text).toContain("mood.tone: current 0.9 in [-1, 1] (high)");
    expect(text).toContain("headroom ↓1.9 ↑0.1");
    expect(text).toContain("persona");
  });

  it("warns and blocks self-edits under a locked mode", () => {
    const text = renderEvolutionView(buildEvolutionView({ values: {}, envelopes: {}, editableSections: [], mode: "locked" }));
    expect(text).toMatch(/LOCKED/);
  });
});

describe("F3.8 LlmAppraiser embeds the evolution view in the prompt", () => {
  it("sends the grounded view (not bare field names) when it is provided", async () => {
    let captured = "";
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
      captured = body.messages.find((m) => m.role === "user")!.content;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ appraisal: "ok", confidence: 0.5, mutations: [], memories: [] }) } }] }),
      };
    }) as unknown as typeof fetch;

    const appraiser = new LlmAppraiser({ endpoint: "http://x", model: "m", fetchImpl: fakeFetch });
    await appraiser.appraise({
      observation: "the user was curt",
      source: "user",
      personaBody: "You are Test.",
      mutableFields: ["mood.tone"],
      editableSections: ["persona"],
      evolutionView: buildEvolutionView({ values: { "mood.tone": 0.9 }, envelopes: { "mood.tone": envelopes["mood.tone"] }, editableSections: ["persona"], mode: "suggesting" }),
    });
    expect(captured).toContain("Evolution view");
    expect(captured).toContain("mood.tone: current 0.9 in [-1, 1]");
  });
});
