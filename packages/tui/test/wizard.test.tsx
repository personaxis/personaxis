/**
 * Genesis interview wizard (F6.7b), driven through ink-testing-library's stdin, so this covers the real key
 * handling the TTY uses. The questions are a model's (core's genesis-interview tests); here we assert the
 * wizard collects the right replies for one round and never skips or leaves by accident.
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { InterviewWizard } from "../src/wizard.js";
import { sparkline, envelopeRow } from "../src/visual.js";
import type { InterviewQuestion, Reply } from "@personaxis/core";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

const QUESTIONS: InterviewQuestion[] = [
  { id: "q1", stage: "self_regulation", question: "What change must it never approve?", why: "The brief states no limits." },
  { id: "q2", stage: "persona", question: "How should it word a rejection?", why: "The brief says nothing about its voice.", options: ["blunt, one line", "blunt, with the reason"] },
  { id: "q3", stage: "cognition", question: "What does it check first?", why: "No procedure is described." },
];

async function drive(questions: InterviewQuestion[], keys: string[]): Promise<{ replies: Reply[] | undefined; frames: () => string }> {
  let replies: Reply[] | undefined;
  const { stdin, lastFrame } = render(<InterviewWizard questions={questions} asked={0} limit={15} onDone={(r) => (replies = r)} />);
  await flush();
  for (const k of keys) {
    stdin.write(k);
    await flush();
  }
  return { replies, frames: () => lastFrame() ?? "" };
}

const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const DOWN = ESC + "[B";
const LEFT = ESC + "[D";

describe("InterviewWizard", () => {
  it("collects typed answers, a picked option and a skip, one reply per question", async () => {
    const { replies } = await drive(QUESTIONS, ["L", "o", "g", "s", CR, DOWN, CR, "s"]);
    expect(replies).toEqual([{ answer: "Logs" }, { answer: "blunt, with the reason" }, { skip: true }]);
  }, 30_000);

  it("shows why each question is asked, and its options", async () => {
    const { frames } = await drive(QUESTIONS, ["x", CR]);
    const out = frames();
    expect(out).toContain("The brief says nothing about its voice.");
    expect(out).toContain("2. blunt, with the reason");
    expect(out).toContain("question 2, at most 15");
  }, 30_000);

  it("typing replaces the options with your own answer, and an s inside it is a letter", async () => {
    const { replies } = await drive(QUESTIONS.slice(1, 2), ["s", "o", "f", "t", CR]);
    expect(replies).toEqual([{ skip: true }]); // `s` on the empty field skips; what follows types into nothing
    const typed = await drive(QUESTIONS.slice(1, 2), ["n", "o", "s", CR]);
    expect(typed.replies).toEqual([{ answer: "nos" }]);
  }, 30_000);

  it("Enter on an empty field without options records nothing", async () => {
    const { replies, frames } = await drive(QUESTIONS.slice(0, 1), [CR]);
    expect(replies).toBeUndefined();
    expect(frames()).toContain("What change must it never approve?");
  }, 30_000);

  it("← goes back and lets a question be answered again", async () => {
    const { replies } = await drive(QUESTIONS.slice(0, 2), ["A", CR, LEFT, "B", CR, CR]);
    expect(replies).toEqual([{ answer: "B" }, { answer: "blunt, one line" }]);
  }, 30_000);

  it("Esc asks before leaving, and leaving keeps what was answered", async () => {
    const stay = await drive(QUESTIONS, [ESC, "n"]);
    expect(stay.replies).toBeUndefined();
    const leave = await drive(QUESTIONS, ["A", CR, ESC, "y"]);
    expect(leave.replies).toEqual([{ answer: "A" }, { stop: true }]);
  }, 30_000);
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
