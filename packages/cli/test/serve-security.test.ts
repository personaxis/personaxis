import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { buildHttpServer } from "../src/commands/serve.js";
import { writeStarterPersona } from "../src/starter.js";

let dir: string;
let server: Server | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-serve-"));
});
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function listen(s: Server): Promise<number> {
  return new Promise((resolvePort) => {
    s.listen(0, "127.0.0.1", () => resolvePort((s.address() as { port: number }).port));
  });
}

describe("serve security (V5.P2.6)", () => {
  it("without a token every route stays open (local default)", async () => {
    const personaPath = writeStarterPersona(dir, "Srv");
    server = buildHttpServer(personaPath);
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/agents.md`);
    expect(res.status).toBe(200);
  });

  it("with a token, requests are 401 without it and 200 with it", async () => {
    const personaPath = writeStarterPersona(dir, "Srv2");
    server = buildHttpServer(personaPath, { token: "s3cret" });
    const port = await listen(server);
    const noAuth = await fetch(`http://127.0.0.1:${port}/persona/state`);
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${port}/persona/state`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    const okRes = await fetch(`http://127.0.0.1:${port}/persona/state`, { headers: { authorization: "Bearer s3cret" } });
    expect(okRes.status).toBe(200);
  });
});
