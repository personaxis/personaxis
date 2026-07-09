/**
 * Genesis interview wizard (F6.7b) — driven through ink-testing-library's
 * stdin, so this covers the real key handling the TTY uses. The number
 * mappings themselves are core's (interview.property/unit tests); here we
 * assert the wizard COLLECTS the right answers and SHOWS the field→rule
 * mapping (the honesty surface).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { InterviewWizard } from "../src/wizard.js";
import { sparkline, envelopeRow } from "../src/visual.js";
import type { InterviewItem, InterviewAnswers } from "@personaxis/core";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

const ITEMS: InterviewItem[] = [
  { id: "id-name", kind: "text", construct: "identity.display_name", rule: "verbatim", question: "What is this persona called?" },
  { id: "t-open", kind: "likert", construct: "personality.traits.openness", rule: "likert-to-mean", question: "Explores unconventional angles." },
  { id: "d-unknown", kind: "choice", construct: "cognition.default_strategy", rule: "dilemma-unknown", question: "Facing unknowns it should…", options: ["ask for evidence", "hypothesize, labeled", "best effort, disclosed"] },
  { id: "v-rank", kind: "rank", construct: "values_and_drives.values", rule: "rank-to-weight", question: "Order what it values most.", candidates: ["clarity", "speed"] },
];

async function drive(items: InterviewItem[], keys: string[]): Promise<{ answers: InterviewAnswers; frames: () => string }> {
  let answers: InterviewAnswers = {};
  const { stdin, lastFrame } = render(
    <InterviewWizard items={items} onDone={(a) => (answers = a)} />,
  );
  await flush();
  for (const k of keys) {
    stdin.write(k);
    await flush();
  }
  return { answers, frames: () => lastFrame() ?? "" };
}

describe("InterviewWizard", () => {
  it("collects text, likert, choice, and rank answers end to end", async () => {
    const { answers } = await drive(ITEMS, [
      "K", "a", "y", "a", "\r",      // text: Kaya
      "4", "\r",                     // likert: 4
      "[B", "\r",              // choice: ↓ → option index 1
      "\r", "\r",                    // rank: pick "clarity", then "speed" (auto-advance on last)
      " ",                           // finish screen → any key builds
    ]);
    expect(answers["id-name"]).toBe("Kaya");
    expect(answers["t-open"]).toBe(4);
    expect(answers["d-unknown"]).toBe(1);
    expect(answers["v-rank"]).toEqual(["clarity", "speed"]);
  });

  it("shows the field→rule mapping live (every number earned, visibly)", async () => {
    const { frames } = await drive(ITEMS, ["K", "\r"]); // answer text, land on likert
    const out = frames();
    expect(out).toContain("personality.traits.openness");
    expect(out).toContain("rule likert-to-mean");
    expect(out).toContain("mean 0.50"); // live preview at default likert 3
    expect(out).toContain("identity.display_name"); // the trail line for the recorded answer
  });

  it("Esc skips: no answer recorded, trail marks the labeled default", async () => {
    const { answers, frames } = await drive(ITEMS, [""]); // skip the text item
    expect(answers["id-name"]).toBeUndefined();
    expect(frames()).toContain("skipped");
  });

  it("progress and completion screen reflect the walk", async () => {
    const two = ITEMS.slice(0, 2);
    const { frames } = await drive(two, ["K", "\r", "5", "\r"]);
    const out = frames();
    expect(out).toContain("done");
    expect(out).toContain("2");
  });
});

describe("dashboard drill-down (F6.7b)", () => {
  it("CoordinateDetail shows value/u/band, the T3 cost, the sparkline, and recent log lines", async () => {
    const { CoordinateDetail } = await import("../src/components.js");
    const frame = {
      name: "t",
      theme: { palette: { primary: 39, secondary: 45, accent: 51, dim: 240 }, glyphs: " .:*#", seed: 1, voice: { density: "balanced" } },
      values: { "mood.tone": 0.2 },
      envelopes: { "mood.tone": { mean: 0, min: -1, max: 1 } },
      drift: [{ field: "mood.tone", value: 0.2, u: 0.2, drift: 0.2, band: "moderate", toNextBoundary: 0.13, minStepsToCross: 1, protected: false, headroomUp: 0.8, headroomDown: 1.2 }],
      log: [{ ts: "2026-07-08T12:00:00Z", field: "mood.tone", from: 0, to: 0.2, actor: "appraiser", clamped: false, reason: "smoke" }],
      mutations: 1,
      memories: 0,
      chainOk: true,
    };
    const { lastFrame } = render(<CoordinateDetail frame={frame as never} field="mood.tone" />);
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("mood.tone");
    expect(out).toContain("band");
    expect(out).toContain("moderate");
    expect(out).toContain("audited step(s) minimum");
    expect(out).toContain("0.000→0.200");
    expect(out).toContain("smoke");
  });
  it("CoordinateDetail marks hard-virtue-backed coordinates immutable (T3 = ∞)", async () => {
    const { CoordinateDetail } = await import("../src/components.js");
    const frame = {
      name: "t",
      theme: { palette: { primary: 39, secondary: 45, accent: 51, dim: 240 }, glyphs: " .:*#", seed: 1, voice: { density: "balanced" } },
      values: { "traits.candor": 0.9 },
      envelopes: { "traits.candor": { mean: 0.9, min: 0.8, max: 0.98 } },
      drift: [{ field: "traits.candor", value: 0.9, u: 0, drift: 0, band: "high", toNextBoundary: 0.2, minStepsToCross: Infinity, protected: true, headroomUp: 0.08, headroomDown: 0.1 }],
      log: [],
      mutations: 0,
      memories: 0,
      chainOk: true,
    };
    const { lastFrame } = render(<CoordinateDetail frame={frame as never} field="traits.candor" />);
    await flush();
    expect(lastFrame() ?? "").toContain("immutable");
  });
});

describe("visual drill-down helpers (F6.7b)", () => {
  it("sparkline scales the series into the envelope", () => {
    const s = sparkline([0, 0.5, 1], 0, 1, 8);
    expect(s.length).toBe(3);
    expect(s[0]).toBe("▁");
    expect(s[2]).toBe("█");
  });
  it("sparkline windows to the last `width` points and handles empty", () => {
    expect(sparkline([], 0, 1)).toBe("");
    expect(sparkline(Array.from({ length: 50 }, (_, i) => i / 49), 0, 1, 10).length).toBe(10);
  });
  it("envelopeRow renders the selection cursor", () => {
    const theme = { palette: { primary: 39, secondary: 45, accent: 51, dim: 240 }, glyphs: " .:*#", seed: 1, voice: { density: "balanced" } } as never;
    expect(envelopeRow(theme, "mood.tone", 0.1, { min: -1, max: 1 }, 10, true)).toContain("▸");
    expect(envelopeRow(theme, "mood.tone", 0.1, { min: -1, max: 1 }, 10, false)).not.toContain("▸");
  });
});
