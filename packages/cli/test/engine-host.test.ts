/**
 * EngineHost e2e: a protocol client drives the REAL governed engine over the
 * OS pipe, clamped mutations, audited state, loop events broadcast. This is
 * the FR seam working end-to-end, not a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineHost } from "../src/host/engine-host.js";
import { ProtocolClient, type EventMsg } from "@personaxis/protocol";

let dir: string;
let personaPath: string;
let host: EngineHost | null = null;
let client: ProtocolClient | null = null;
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-host-"));
  // Hermetic: a developer's ~/.personaxis/config.json must not resolve a model.
  savedHome = process.env.PERSONAXIS_HOME;
  process.env.PERSONAXIS_HOME = join(dir, "home");
  mkdirSync(join(dir, ".personaxis"), { recursive: true });
  personaPath = join(dir, ".personaxis", "personaxis.md");
  writeFileSync(
    personaPath,
    `---
apiVersion: personaxis.com/v1
kind: AgentPersona
spec_version: "1.0.0"
metadata: { name: host, version: 1.0.0, description: d, created: "2026-01-01" }
identity: { canonical_id: host, display_name: Hosty }
improvement_policy: { mode: suggesting }
memory: { types: { episodic: true } }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-0.2, 0.2] }
---
You are Hosty.
`,
  );
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = savedHome;
  client?.close();
  client = null;
  await host?.close();
  host = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("EngineHost over the protocol seam", () => {
  it("greets with session.configured (persona + governed mode + version)", async () => {
    host = new EngineHost(personaPath);
    await host.listen();
    client = new ProtocolClient();
    const events: EventMsg[] = [];
    client.onEvent((e) => events.push(e));
    await client.connect(host.pipePath);
    await new Promise((r) => setTimeout(r, 100));
    const hello = events.find((e) => e.event === "session.configured");
    expect(hello && hello.event === "session.configured" && hello.persona.name).toBe("Hosty");
    expect(hello && hello.event === "session.configured" && hello.mode).toBe("suggesting");
  });

  it("adjust goes through the real clamp (short-form field, envelope ceiling)", async () => {
    host = new EngineHost(personaPath);
    await host.listen();
    client = new ProtocolClient();
    const events: EventMsg[] = [];
    client.onEvent((e) => events.push(e));
    await client.connect(host.pipePath);

    const r = await client.submit({ op: "adjust", field: "mood.tone", delta: 0.9, reason: "clamp me" });
    expect(r.ok).toBe(true);
    const applied = r.data as { to: number; clamped: boolean };
    expect(applied.clamped).toBe(true);
    expect(applied.to).toBe(0.2); // envelope ceiling, not 0.9

    const st = await client.submit({ op: "state_get" });
    const values = (st.data as { values: Record<string, number> }).values;
    expect(values["affect.baseline.mood.tone"]).toBe(0.2); // v1 full dot-path key
    expect(events.some((e) => e.event === "state.snapshot")).toBe(true);

    const rejected = await client.submit({ op: "adjust", field: "nope.nope", delta: 0.1, reason: "x" });
    expect(rejected.ok).toBe(false);
  });

  it("observe runs a governed tick and broadcasts loop events + audit stays intact", async () => {
    host = new EngineHost(personaPath);
    await host.listen();
    client = new ProtocolClient();
    const events: EventMsg[] = [];
    client.onEvent((e) => events.push(e));
    await client.connect(host.pipePath);

    const r = await client.submit({ op: "observe", observation: "the user prefers terse answers", source: "user" });
    expect(r.ok).toBe(true);
    const names = events.map((e) => e.event);
    expect(names).toContain("turn.started");
    expect(names).toContain("engine.event");
    expect(names).toContain("turn.completed");

    const audit = await client.submit({ op: "audit_get" });
    expect((audit.data as { memory_chain_intact: boolean }).memory_chain_intact).toBe(true);
  });
});
