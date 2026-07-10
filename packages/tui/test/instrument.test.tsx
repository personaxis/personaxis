/**
 * FASE 7 P2 — the living-instrument surfaces, driven through ink-testing-library:
 * the persistent header, the drift gauge segment, the band-crossing moment
 * (NO_ANIM fast path commits the summary deterministically), and the embedded
 * drift view with its key handling. The math itself is core's; here we assert
 * the app SHOWS it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ReplApp, createReplStore, crossingSummary } from "../src/ink-repl.js";
import { DriftView } from "../src/components.js";
import { driftGauge } from "../src/visual.js";
import type { ReplHooks } from "../src/screen.js";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

const REPORT = {
  global: 0.42,
  maxStepDelta: 0.15,
  coordinates: [
    { field: "affect.baseline.mood.tone", value: 0.18, u: 0.42, drift: 0.42, band: "moderate", toNextBoundary: 0.02, minStepsToCross: 1, decayAssisted: false, protected: false, headroomUp: 0.27, headroomDown: 0.48 },
    { field: "personality.traits.candor", value: 0.9, u: 0, drift: 0, band: "high", toNextBoundary: 0.1, minStepsToCross: Infinity, decayAssisted: false, protected: true, headroomUp: 0.08, headroomDown: 0.1 },
  ],
  layers: [
    { layer: "affect", drift: 0.42, threshold: 0.2, exceeded: true, fields: ["affect.baseline.mood.tone"] },
    { layer: "personality", drift: 0, threshold: 0.1, exceeded: false, fields: ["personality.traits.candor"] },
  ],
} as never;

function hooks(over: Partial<ReplHooks> = {}): ReplHooks {
  return {
    prompt: () => "> ",
    status: () => "ctx offline · improve:locked",
    commands: [{ name: "help", desc: "show help" }],
    onSubmit: () => {},
    ...over,
  };
}

describe("living instrument (P2)", () => {
  beforeEach(() => {
    process.env.PERSONAXIS_NO_ANIM = "1";
  });
  afterEach(() => {
    delete process.env.PERSONAXIS_NO_ANIM;
  });

  it("renders the persistent header when the hook provides one", async () => {
    const store = createReplStore();
    const { lastFrame } = render(
      <ReplApp store={store} hooks={hooks({ header: () => "◉ personaxis · Clio · workspace-write" })} />,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("◉ personaxis · Clio · workspace-write");
  });

  it("appends the drift gauge segment to the status line once a report lands", async () => {
    const store = createReplStore();
    const { lastFrame } = render(
      <ReplApp store={store} hooks={hooks({ driftSegment: (r) => `D=${(r as { global: number }).global.toFixed(2)}` })} />,
    );
    store.getState().setDrift(REPORT);
    await flush();
    expect(lastFrame() ?? "").toContain("D=0.42");
  });

  it("band-crossing moment (NO_ANIM): commits one summary line per crossing, then clears", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks()} />);
    store.getState().setMoment({
      crossings: [{ field: "affect.baseline.mood.tone", fromBand: "moderate", toBand: "high", prose: "Your register runs bright." }],
    });
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("band crossing");
    expect(out).toContain("moderate ▸ high");
    expect(out).toContain("Your register runs bright.");
    expect(store.getState().moment).toBeNull(); // committed and cleared
  });

  it("crossingSummary carries field, direction, and the new band's prose", () => {
    const line = crossingSummary({ field: "x", fromBand: "low", toBand: "moderate", prose: "p" });
    expect(line).toContain("x");
    expect(line).toContain("low ▸ moderate");
    expect(line).toContain("«p»");
  });

  it("drift view: lists coordinates from the event report, marks protected, Esc calls onBack", async () => {
    let back = 0;
    const { stdin, lastFrame } = render(
      <DriftView personaPath="" report={REPORT} active={true} onBack={() => back++} />,
    );
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("affect.baseline.mood.tone");
    expect(out).toContain("immutable");
    expect(out).toContain("⚠ affect"); // exceeded layer on the gauge line
    stdin.write(""); // Esc at list level → back
    await flush();
    expect(back).toBe(1);
  });

  it("the /drift view opens from the store and the input row hides", async () => {
    const store = createReplStore();
    const { lastFrame } = render(<ReplApp store={store} hooks={hooks()} />);
    store.getState().setDrift(REPORT);
    store.getState().setView("drift");
    await flush();
    const out = lastFrame() ?? "";
    expect(out).toContain("Esc back");
    expect(out).not.toContain("> "); // chat prompt hidden inside a view
  });

  it("driftGauge is width-stable and flags exceeded layers", () => {
    const theme = { palette: { primary: 39, secondary: 45, accent: 51, dim: 240 }, glyphs: " .:*#", seed: 1, voice: { density: "balanced" } } as never;
    const g = driftGauge(theme, REPORT as never, 10);
    expect(g).toContain("0.42");
    expect(g).toContain("⚠affect");
  });
});
