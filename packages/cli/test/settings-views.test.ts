import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { statusLines, configLines, usageLines, statsLines, settingsLines, SETTINGS_TABS } from "../src/repl/views/settings-data.js";
import { agoLabel } from "../src/repl/views/resume.js";
import { writeStarterPersona } from "../src/starter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function scaffoldCtx() {
  const personaPath = writeStarterPersona(dir, "Vega");
  return makeCtx(personaPath, makeMeter());
}

describe("Settings miniapp collectors (V5.P1.2)", () => {
  it("statusLines: snapshot + live state + no crash on a fresh persona", () => {
    const ctx = scaffoldCtx();
    const lines = statusLines(ctx);
    const text = lines.join("\n");
    expect(text).toContain("persona");
    expect(text).toContain("Vega");
    expect(text).toContain("drift");
    expect(text).toContain("mutations");
    // Status is the SNAPSHOT ("what am I now"); the coordinate-by-coordinate movement
    // belongs to /drift ("how far have I moved"). Printing the envelope block in both made
    // the two screens look identical. Status keeps the single drift number and points at
    // the other command.
    expect(text).not.toContain("Live state (envelopes)");
    expect(text).toContain("/drift");
  });

  it("configLines: shows resolution source and session behavior", () => {
    const ctx = scaffoldCtx();
    const text = configLines(ctx).join("\n");
    expect(text).toContain("Model");
    expect(text).toContain("Session behavior");
    expect(text).toContain("posture");
    expect(text).toContain("improve");
  });

  it("usageLines: totals plus per-model breakdown when present", () => {
    const ctx = scaffoldCtx();
    ctx.usage.turns = 2;
    ctx.usage.tokens = 1500;
    ctx.usage.costUsd = 0.12;
    ctx.usage.byModel = { "command-a": { turns: 2, tokens: 1500, costUsd: 0.12 } };
    const text = usageLines(ctx).join("\n");
    expect(text).toContain("$0.1200");
    expect(text).toContain("Usage by model");
    expect(text).toContain("command-a");
  });

  it("statsLines: graceful with no sessions, heatmap once sessions exist", () => {
    const ctx = scaffoldCtx();
    expect(statsLines(ctx).join("\n")).toContain("no saved sessions");
    // One saved session -> stats aggregate.
    const sess = join(dir, ".personaxis", "sessions");
    mkdirSync(sess, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(sess, "abc.jsonl"),
      [
        JSON.stringify({ id: "abc", kind: "chat", participants: [], name: "prueba", created: now, persona: "Vega" }),
        JSON.stringify({ role: "user", content: "hola", ts: now }),
        JSON.stringify({ role: "assistant", content: "hola!", ts: now }),
      ].join("\n") + "\n",
    );
    const text = statsLines(ctx).join("\n");
    expect(text).toContain("Activity");
    expect(text).toContain("sessions");
    expect(text).toContain("streak");
  });

  it("settingsLines dispatches per tab and the tab list is stable", () => {
    const ctx = scaffoldCtx();
    expect(SETTINGS_TABS).toEqual(["Status", "Config", "Usage", "Stats"]);
    for (let t = 0; t < SETTINGS_TABS.length; t++) expect(settingsLines(ctx, t).length).toBeGreaterThan(0);
  });
});

describe("agoLabel (V5.P1.3: elapsed since the LAST MESSAGE)", () => {
  it("formats minutes, hours and days", () => {
    const now = Date.parse("2026-07-18T12:00:00Z");
    expect(agoLabel("2026-07-18T11:59:40Z", now)).toBe("now");
    expect(agoLabel("2026-07-18T11:30:00Z", now)).toBe("30m ago");
    expect(agoLabel("2026-07-18T06:00:00Z", now)).toBe("6h ago");
    expect(agoLabel("2026-07-15T12:00:00Z", now)).toBe("3d ago");
  });
});
