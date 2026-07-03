import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as svc from "../src/service.js";
import { buildServer } from "../src/index.js";

const SPEC = `---
apiVersion: persona.dev/v1
kind: AgentPersona
spec_version: "0.10.0"
metadata: { name: t, version: 0.0.1, display_name: T, description: t, created: "2026-01-01" }
personality: { model: big_five, traits: { openness: { mean: 0.5, range: [0.2, 0.8] } } }
---
body
`;

function scaffold(): { root: string; inside: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "pxis-mcp-root-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pxis-mcp-out-"));
  mkdirSync(join(root, "p"), { recursive: true });
  writeFileSync(join(root, "p", "personaxis.md"), SPEC, "utf-8");
  writeFileSync(join(outsideDir, "personaxis.md"), SPEC, "utf-8");
  return { root, inside: join("p", "personaxis.md"), outside: join(outsideDir, "personaxis.md") };
}

describe("MCP path confinement (ADR-011 --root)", () => {
  it("allows persona paths inside the root", () => {
    const { root, inside } = scaffold();
    svc.setRoot(root);
    expect(() => svc.compiledDocument(inside)).not.toThrow();
  });

  it("rejects absolute paths outside the root", () => {
    const { root, outside } = scaffold();
    svc.setRoot(root);
    expect(() => svc.compiledDocument(outside)).toThrow(/escapes the server root/);
  });

  it("rejects ../ traversal out of the root", () => {
    const { root } = scaffold();
    svc.setRoot(root);
    expect(() => svc.stateSummary(join("..", "..", "etc", "anything.md"))).toThrow(
      /escapes the server root/,
    );
  });

  it("confines every persona-taking surface, not just reads", () => {
    const { root, outside } = scaffold();
    svc.setRoot(root);
    expect(() => svc.adjustState(outside, "traits.openness", 0.1, "x")).toThrow(/escapes/);
    expect(() => svc.audit(outside)).toThrow(/escapes/);
    expect(() => svc.listProposals(outside)).toThrow(/escapes/);
    expect(() => svc.skillReview(outside)).toThrow(/escapes/);
  });
});

describe("persona_decide_edit gating (proposer≠approver)", () => {
  async function callDecide(allowDecide: boolean, persona: string) {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildServer(allowDecide ? { allowDecide: true } : {});
    await server.connect(st);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(ct);
    const r = (await client.callTool({
      name: "persona_decide_edit",
      arguments: { persona, id: "nonexistent", decision: "approve" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    return r;
  }

  it("refuses without --allow-decide (the client cannot approve its own proposals)", async () => {
    const { root, inside } = scaffold();
    svc.setRoot(root);
    const r = await callDecide(false, inside);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("--allow-decide");
  });

  it("reaches the service when --allow-decide was granted by the human", async () => {
    const { root, inside } = scaffold();
    svc.setRoot(root);
    const r = await callDecide(true, inside);
    // The gate passed: the error (if any) is now about the missing proposal id,
    // never about the flag.
    expect(r.content[0].text).not.toContain("--allow-decide");
  });
});
