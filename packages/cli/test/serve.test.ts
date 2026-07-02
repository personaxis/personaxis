import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildHttpServer } from "../src/commands/serve.js";

let dir: string;
let server: Server;
let base: string;
let savedHome: string | undefined;
let savedEnv: Record<string, string | undefined>;

const PERSONA = `---
metadata: { name: srv, version: 1.0.0 }
identity: { canonical_id: srv }
affect:
  baseline:
    mood:
      tone: { mean: 0.0, range: [-1, 1] }
---
served body
`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pxs-serve-"));
  // Isolate from any real ~/.personaxis/config.json + PERSONAXIS_* env so "no model configured"
  // tests are deterministic regardless of the developer's machine config.
  savedHome = process.env.PERSONAXIS_HOME;
  savedEnv = { e: process.env.PERSONAXIS_ENDPOINT, m: process.env.PERSONAXIS_MODEL, k: process.env.PERSONAXIS_API_KEY };
  process.env.PERSONAXIS_HOME = join(dir, "home");
  delete process.env.PERSONAXIS_ENDPOINT;
  delete process.env.PERSONAXIS_MODEL;
  delete process.env.PERSONAXIS_API_KEY;
  const p = join(dir, "personaxis.md");
  writeFileSync(p, PERSONA);
  server = buildHttpServer(p);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.close();
  if (savedHome === undefined) delete process.env.PERSONAXIS_HOME;
  else process.env.PERSONAXIS_HOME = savedHome;
  if (savedEnv.e !== undefined) process.env.PERSONAXIS_ENDPOINT = savedEnv.e;
  if (savedEnv.m !== undefined) process.env.PERSONAXIS_MODEL = savedEnv.m;
  if (savedEnv.k !== undefined) process.env.PERSONAXIS_API_KEY = savedEnv.k;
  rmSync(dir, { recursive: true, force: true });
});

describe("serve HTTP endpoints (bug fixes)", () => {
  it("400 on invalid JSON", async () => {
    const res = await fetch(`${base}/persona/observe`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("400 on missing observation", async () => {
    const res = await fetch(`${base}/persona/observe`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("400 on unknown envelope field for /adjust", async () => {
    const res = await fetch(`${base}/persona/adjust`, { method: "POST", body: JSON.stringify({ field: "nope", delta: 0.1 }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown envelope field/);
  });

  it("200 + values on /persona/state", async () => {
    const res = await fetch(`${base}/persona/state`);
    expect(res.status).toBe(200);
    expect((await res.json()).values).toHaveProperty("mood.tone");
  });

  it("serves the agents.md contract", async () => {
    const res = await fetch(`${base}/agents.md`);
    expect(res.headers.get("content-type")).toContain("markdown");
    expect(await res.text()).toContain("/persona/observe");
  });

  it("400 on /persona/agent without a configured model", async () => {
    const prev = process.env.PERSONAXIS_MODEL;
    delete process.env.PERSONAXIS_MODEL;
    const res = await fetch(`${base}/persona/agent`, { method: "POST", body: JSON.stringify({ task: "do x" }) });
    expect(res.status).toBe(400);
    if (prev) process.env.PERSONAXIS_MODEL = prev;
  });
});
