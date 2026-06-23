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
  const p = join(dir, "personaxis.md");
  writeFileSync(p, PERSONA);
  server = buildHttpServer(p);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.close();
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
