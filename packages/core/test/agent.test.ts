import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonaAgent,
  evaluateFileWrite,
  executeCommand,
  executeFileWrite,
  executeFileEdit,
  readFileSafe,
  DEFAULT_POLICY,
  type Policy,
  type LoopEvent,
} from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-agent-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function policy(over: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, workspaceRoot: dir, ...over };
}

/** A scripted OpenAI-style /chat/completions fetch. Each call returns the next item. */
function scriptedFetch(steps: Array<{ text?: string; tool?: string; args?: object }>): typeof fetch {
  let i = 0;
  return (async () => {
    const s = steps[Math.min(i, steps.length - 1)];
    i++;
    const message = s.tool
      ? { content: s.text ?? "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args ?? {}) } }] }
      : { content: s.text ?? "" };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
  }) as unknown as typeof fetch;
}

const llm = (fetchImpl: typeof fetch) => ({ endpoint: "http://x/v1", model: "m", fetchImpl });

describe("PersonaAgent (governed task execution)", () => {
  it("finishes immediately when the model calls finish", async () => {
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([{ tool: "finish", args: { summary: "nothing to do" } }])),
      policy: policy(),
    });
    const res = await agent.run("noop");
    expect(res.finished).toBe(true);
    expect(res.summary).toBe("nothing to do");
  });

  it("never executes a deny-listed command (gate is authoritative)", async () => {
    const events: LoopEvent[] = [];
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([
        { tool: "run_command", args: { command: "rm -rf /" } },
        { tool: "finish", args: { summary: "stopped" } },
      ])),
      policy: policy({ deny: ["rm\\s+-rf"] }),
    });
    agent.bus.on((e) => events.push(e));
    await agent.run("danger");
    const verdict = events.find((e) => e.type === "tool-verdict");
    expect(verdict).toMatchObject({ decision: "deny" });
  });

  it("asks before a risky write and honors a user denial", async () => {
    let asked = 0;
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([
        { tool: "write_file", args: { path: "out.txt", content: "hi" } },
        { tool: "finish", args: { summary: "done" } },
      ])),
      policy: policy({ approval: "on-request", sandbox: "workspace-write" }),
      onApproval: async () => {
        asked++;
        return "deny";
      },
    });
    await agent.run("write a file");
    expect(asked).toBe(1);
    expect(existsSync(join(dir, "out.txt"))).toBe(false); // denied → not written
  });

  it("executes an approved write end-to-end", async () => {
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([
        { tool: "write_file", args: { path: "note.txt", content: "hello world" } },
        { tool: "finish", args: { summary: "wrote note" } },
      ])),
      policy: policy({ approval: "on-request", sandbox: "workspace-write" }),
      onApproval: async () => "approve",
    });
    const res = await agent.run("write note");
    expect(res.finished).toBe(true);
    expect(readFileSync(join(dir, "note.txt"), "utf-8")).toBe("hello world");
  });

  it("stops at max steps without finishing", async () => {
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([{ tool: "list_dir", args: { path: "." } }])), // never finishes
      policy: policy(),
      maxSteps: 3,
    });
    const res = await agent.run("loop forever");
    expect(res.finished).toBe(false);
    expect(res.steps).toBe(3);
    expect(res.budget.stoppedBy).toBe("max_steps");
  });

  it("stops on a token budget", async () => {
    // a fetch that always proposes a read and reports 500 tokens per call
    let i = 0;
    const usageFetch = (async () => {
      i++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } }] } }],
          usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 },
        }),
      };
    }) as unknown as typeof fetch;
    const agent = new PersonaAgent({
      llm: llm(usageFetch),
      policy: policy(),
      budget: { maxSteps: 100, maxTokens: 1200, stopConditions: [], onExhaust: "stop" },
    });
    const res = await agent.run("read a lot");
    expect(res.finished).toBe(false);
    expect(res.budget.stoppedBy).toBe("max_tokens");
    expect(res.budget.tokens).toBeGreaterThanOrEqual(1200);
  });

  it("blocking verification rejects an unverified finish and stops after retries", async () => {
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([{ tool: "finish", args: { summary: "I think it is done" } }])),
      policy: policy(),
      verification: { mode: "blocking", quorum: "all", onFail: "retry", maxRetries: 1, gates: [{ type: "predicate", kind: "contains", expr: "ALL_TESTS_PASS" }] },
    });
    const res = await agent.run("do the thing");
    expect(res.finished).toBe(false);
    expect(res.verification?.passed).toBe(false);
    expect(res.budget.stoppedBy).toBe("verification_failed");
  });

  it("advisory verification reports but never blocks", async () => {
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([{ tool: "finish", args: { summary: "done-ish" } }])),
      policy: policy(),
      verification: { mode: "advisory", quorum: "all", onFail: "stop", maxRetries: 0, gates: [{ type: "predicate", kind: "contains", expr: "NEVER" }] },
    });
    const res = await agent.run("do the thing");
    expect(res.finished).toBe(true);
    expect(res.verification?.passed).toBe(false); // reported as failed, but did not block
  });
});

describe("evaluateFileWrite", () => {
  it("denies writes under read-only", () => {
    expect(evaluateFileWrite("a.txt", policy({ sandbox: "read-only" })).decision).toBe("deny");
  });
  it("denies writes escaping the workspace under workspace-write", () => {
    expect(evaluateFileWrite("../../etc/passwd", policy({ sandbox: "workspace-write" })).decision).toBe("deny");
  });
  it("asks for in-workspace writes under on-request", () => {
    expect(evaluateFileWrite("a.txt", policy({ approval: "on-request" })).decision).toBe("ask");
  });
  it("allows when matched by allow-list", () => {
    expect(evaluateFileWrite("a.txt", policy({ allow: ["a\\.txt"] })).decision).toBe("allow");
  });
});

describe("exec primitives", () => {
  it("writes, edits and reads a file in the workspace", () => {
    const w = executeFileWrite("f.txt", "alpha beta", policy());
    expect(w.ok).toBe(true);
    const e = executeFileEdit("f.txt", "beta", "gamma", policy());
    expect(e.ok).toBe(true);
    expect(readFileSafe("f.txt", policy()).content).toBe("alpha gamma");
  });

  it("edit_file reports when the find text is absent", () => {
    writeFileSync(join(dir, "g.txt"), "abc");
    const e = executeFileEdit("g.txt", "zzz", "x", policy());
    expect(e.ok).toBe(false);
    expect(e.error).toMatch(/not present/);
  });

  it("executeCommand captures stdout and exit code (mocked spawn)", async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("hello"));
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const r = await executeCommand("echo hello", policy(), { spawnImpl: fakeSpawn });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello");
  });
});
