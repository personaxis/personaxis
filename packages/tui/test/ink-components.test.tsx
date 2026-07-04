/**
 * Ink 7 components render via ink-testing-library — the Dashboard shows the
 * SAME content as the pre-Ink renderFrame (visual.ts is the shared source),
 * and the Transcript commits lines through <Static>.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { loadPersona, ensureState } from "@personaxis/core";
import { Dashboard, Transcript } from "../src/components.js";
import { createEngineStore } from "../src/store.js";

let dir: string;
let personaPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-ink-"));
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(
    personaPath,
    `---
apiVersion: personaxis.com/v1
kind: AgentPersona
spec_version: "1.0.0"
metadata: { name: inky, version: 1.0.0, description: d, created: "2026-01-01" }
identity: { canonical_id: inky, display_name: Inky }
affect:
  baseline:
    mood:
      tone: { mean: 0.1, range: [-0.5, 0.5] }
---
body
`,
  );
  ensureState(loadPersona(personaPath));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Ink components (FR.3)", () => {
  it("Dashboard renders name, sigil header, envelope bars and chain status", () => {
    const { lastFrame, unmount } = render(
      <Dashboard personaPath={personaPath} maxFrames={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Inky");
    expect(frame).toContain("sigil #");
    expect(frame).toContain("mutations 0");
    expect(frame).toContain("intact");
    unmount();
  });

  it("Transcript commits lines via <Static> and shows the live tail", () => {
    const { lastFrame, unmount } = render(
      <Transcript committed={["línea uno", "línea dos"]} live={"escribiend"} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("línea uno");
    expect(frame).toContain("línea dos");
    expect(frame).toContain("escribiend");
    unmount();
  });

  it("the engine store frame-batches token deltas into commit + live", async () => {
    const { store, onEvent, flushTokens } = createEngineStore();
    onEvent({
      event: "session.configured",
      sessionId: "s",
      persona: { name: "Inky", path: personaPath },
      mode: "suggesting",
      protocolVersion: 1,
    });
    expect(store.getState().personaName).toBe("Inky");

    onEvent({ event: "turn.started", turnId: "t" });
    expect(store.getState().busy).toBe(true);
    onEvent({ event: "token.delta", turnId: "t", text: "hola\npar" });
    flushTokens(); // deterministic in tests (normally ~1 frame later)
    expect(store.getState().committed).toEqual(["hola"]);
    expect(store.getState().live).toBe("par");

    onEvent({ event: "turn.completed", turnId: "t" });
    expect(store.getState().busy).toBe(false);
    expect(store.getState().committed).toEqual(["hola", "par"]);
    expect(store.getState().live).toBe("");
  });
});
