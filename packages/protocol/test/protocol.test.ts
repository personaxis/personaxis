/**
 * SQ/EQ roundtrip over the REAL transport (named pipe on win32, UDS on POSIX)
 * — not a mock: proves the seam works end-to-end on this OS.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  ProtocolServer,
  ProtocolClient,
  pipePathFor,
  PROTOCOL_VERSION,
  type Op,
  type EventMsg,
} from "../src/index.js";

let server: ProtocolServer | null = null;
let client: ProtocolClient | null = null;
afterEach(async () => {
  client?.close();
  client = null;
  await server?.close();
  server = null;
});

function uniquePipe(name: string): string {
  return pipePathFor(`${name}-${process.pid}-${createHash("sha256").update(String(Math.random())).digest("hex")}`);
}

describe("@personaxis/protocol — SQ/EQ over JSON-RPC on node:net", () => {
  it("pipePathFor is deterministic and OS-appropriate", () => {
    const a = pipePathFor("C:/x/personaxis.md");
    expect(a).toBe(pipePathFor("C:/x/personaxis.md"));
    expect(a).not.toBe(pipePathFor("C:/y/personaxis.md"));
    if (process.platform === "win32") expect(a).toMatch(/^\\\\\.\\pipe\\personaxis-/);
    else expect(a).toMatch(/personaxis-.*\.sock$/);
  });

  it("submits ops and receives typed results over the real pipe", async () => {
    const pipe = uniquePipe("ops");
    const seen: Op[] = [];
    server = new ProtocolServer((op) => {
      seen.push(op);
      if (op.op === "state_get") return { ok: true, data: { values: { "affect.baseline.mood.tone": 0.05 } } };
      return { ok: true };
    });
    await server.listen(pipe);

    client = new ProtocolClient();
    await client.connect(pipe);

    const r1 = await client.submit({ op: "adjust", field: "mood.tone", delta: -0.05, reason: "test" });
    expect(r1.ok).toBe(true);
    const r2 = await client.submit({ op: "state_get" });
    expect((r2.data as { values: Record<string, number> }).values["affect.baseline.mood.tone"]).toBe(0.05);
    expect(seen.map((o) => o.op)).toEqual(["adjust", "state_get"]);
  });

  it("broadcasts events to every connected front-end", async () => {
    const pipe = uniquePipe("events");
    server = new ProtocolServer(() => ({ ok: true }));
    await server.listen(pipe, (conn) => {
      server!.send(conn, {
        event: "session.configured",
        sessionId: "s1",
        persona: { name: "clio", path: "/x" },
        mode: "suggesting",
        protocolVersion: PROTOCOL_VERSION,
      });
    });

    const a = new ProtocolClient();
    const b = new ProtocolClient();
    const got: Record<string, EventMsg[]> = { a: [], b: [] };
    // Subscribe BEFORE connect: the greeting arrives during the handshake.
    a.onEvent((e) => got.a.push(e));
    b.onEvent((e) => got.b.push(e));
    await a.connect(pipe);
    await b.connect(pipe);

    server.broadcast({ event: "token.delta", turnId: "t1", text: "hola" });
    server.broadcast({
      event: "engine.event",
      payload: { type: "tick-complete", mutationsApplied: 1, memoriesWritten: 1 },
    });
    await new Promise((r) => setTimeout(r, 200));

    for (const k of ["a", "b"] as const) {
      const names = got[k].map((e) => e.event);
      expect(names).toContain("session.configured");
      expect(names).toContain("token.delta");
      expect(names).toContain("engine.event");
    }
    expect(server.connectionCount).toBe(2);
    a.close();
    b.close();
  });

  it("a handler exception returns an error result, not a transport failure", async () => {
    const pipe = uniquePipe("err");
    server = new ProtocolServer(() => {
      throw new Error("engine hiccup");
    });
    await server.listen(pipe);
    client = new ProtocolClient();
    await client.connect(pipe);
    const r = await client.submit({ op: "interrupt" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("engine hiccup");
    // The connection survives for the next op.
    const r2 = await client.submit({ op: "interrupt" });
    expect(r2.ok).toBe(false);
  });
});
