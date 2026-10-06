import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureState,
  PersonaAgent,
  evaluateFileWrite,
  executeCommand,
  executeFileWrite,
  executeFileEdit,
  readFileSafe,
  readMemory,
  loadPersona,
  readState,
  DEFAULT_POLICY,
  compile,
  type CompiledPolicy,
  type ExecutablePolicy,
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

/**
 * The persona's compiled limits, which E2 made the loop require.
 *
 * Only the tests that actually execute something need one, and that asymmetry is the
 * change working rather than a gap: a run with no compiled policy now refuses every
 * call by name, so the two tests below that write a file had to say which persona
 * they were writing as. The ones that assert a refusal did not, because they were
 * already getting one.
 *
 * `danger-full-access` on purpose. The capability axis is not what these two are
 * about, and a posture that refused the write on its own would let them pass while
 * proving nothing about the approval flow they exist to check.
 */
function capability(over: Partial<CompiledPolicy> = {}): ExecutablePolicy {
  return compile({
    persona_version_id: "pv_test",
    hash: "h",
    compiled_at: new Date().toISOString(),
    ttl_seconds: 3600,
    deny: [],
    allow: [],
    hard_limits: [],
    prohibited_behaviors: [],
    egress_allowlist: [],
    sandbox: "danger-full-access",
    approval: "never",
    gate_rules: [],
    ...over,
  });
}

/** A scripted OpenAI-style /chat/completions fetch. Each call returns the next item. */
function scriptedFetch(steps: Array<{ text?: string; tool?: string; args?: object }>): typeof fetch {
  let i = 0;
  return (async (url: string) => {
    // The context manager probes /models; answer without consuming a scripted step.
    if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
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
      capability: capability(),
      onApproval: async () => {
        asked++;
        return "deny";
      },
    });
    await agent.run("write a file");
    expect(asked).toBe(1);
    expect(existsSync(join(dir, "out.txt"))).toBe(false); // denied → not written
  });

  it("tells the model WHO refused, not that a user did", async () => {
    // C6b. Every refusal on this path was written down as `user denied` and shown to
    // the model as `denied by user`, including the paths where no user exists: an SDK
    // embedding, a daemon, and a delegated sub-task, which refuses by rule and asks
    // nobody. A record that names a person who was never consulted is the same fault
    // as an ending attributed to a persona that was cut off mid-sentence.
    const sent: string[] = [];
    const capturing = ((async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (init?.body) sent.push(init.body);
      const step = sent.length === 1
        ? { id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "o.txt", content: "x" }) } }
        : { id: "c2", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "stopped" }) } };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls: [step] } }] }) };
    }) as unknown) as typeof fetch;

    const agent = new PersonaAgent({
      llm: llm(capturing),
      policy: policy({ approval: "on-request", sandbox: "workspace-write" }),
      capability: capability(),
      onApproval: async () => ({ decision: "deny", reason: "a delegated sub-task cannot ask" }),
    });
    await agent.run("write a file");

    // The refusal reaches the model on the request AFTER the one it was refused on.
    expect(sent.at(-1)).toContain("a delegated sub-task cannot ask");
    expect(sent.at(-1)).not.toContain("denied by user");

    // And in the forensic log, which is the half that matters more: the model is
    // told once, the log is what somebody reads afterwards to ask who decided.
    // Found by a negative control coming back GREEN: putting `user denied` back into
    // the log left every test passing, because nothing looked here.
    const blocked = agent.forensic.filter((entry) => entry.decision === "ask");
    expect(blocked.map((entry) => entry.reason)).toEqual(["a delegated sub-task cannot ask"]);
  });

  it("says there was nobody to ask when there was no handler at all", async () => {
    // A different sentence from somebody saying no, and the two used to be one.
    const sent: string[] = [];
    const capturing = ((async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      if (init?.body) sent.push(init.body);
      const step = sent.length === 1
        ? { id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "o.txt", content: "x" }) } }
        : { id: "c2", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "stopped" }) } };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "", tool_calls: [step] } }] }) };
    }) as unknown) as typeof fetch;

    const agent = new PersonaAgent({
      llm: llm(capturing),
      policy: policy({ approval: "on-request", sandbox: "workspace-write" }),
      capability: capability(),
    });
    await agent.run("write a file");

    expect(sent.at(-1)).toContain("nobody to ask");
  });

  it("executes an approved write end-to-end", async () => {
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([
        { tool: "write_file", args: { path: "note.txt", content: "hello world" } },
        { tool: "finish", args: { summary: "wrote note" } },
      ])),
      policy: policy({ approval: "on-request", sandbox: "workspace-write" }),
      capability: capability(),
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
    const usageFetch = (async (url: string) => {
      if (String(url).endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
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

  it("records REAL runs in the EXISTING memory (no STATE.md); one-shot chat is not duplicated", async () => {
    const personaPath = join(dir, "personaxis.md");
    // A persona with episodic memory enabled + seeded state.json.
    writeFileSync(personaPath, `---\nmetadata: { name: a, version: 1.0.0 }\nidentity: { canonical_id: a }\nmemory: { types: { episodic: true } }\n---\nbody`);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ schema_version: "0.9.0", persona_id: "a", persona_version: "1.0.0", values: {}, mutation_log: [] }));

    // V2-F1.3 dedup: a 1-step success (a chat-style finish, no action) earns NO
    // ledger entry, the dialog already lives in sessions/.
    await new PersonaAgent({
      llm: llm(scriptedFetch([{ tool: "finish", args: { summary: "nothing to do" } }])),
      policy: policy(),
      personaPath,
    }).run("say hi");
    expect(readMemory(personaPath).filter((m) => m.tags.includes("agent-run")).length).toBe(0);

    // A multi-step run (real action taken) IS recorded.
    const agent = new PersonaAgent({
      llm: llm(scriptedFetch([{ tool: "list_dir", args: { path: "." } }, { tool: "finish", args: { summary: "shipped the landing page" } }])),
      policy: policy(),
      personaPath,
    });
    await agent.run("build a landing page");
    // No STATE.md / agent-state.jsonl files exist.
    expect(existsSync(join(dir, "STATE.md"))).toBe(false);
    expect(existsSync(join(dir, "memory", "agent-state.jsonl"))).toBe(false);
    const mem = readMemory(personaPath);
    expect(mem.some((m) => m.tags.includes("agent-run") && m.content.includes("build a landing page"))).toBe(true);
    // The loop no longer writes `agent_session` itself, and this test used to pin
    // that it did. The block is printed from the record, folded over the turns, and
    // this agent was driven without a runner so no turn was ever recorded: there is
    // nothing to fold and nothing to print. Two writers for one block is what it was:
    // this one wrote `stop_reason: "goal_met"` while the projection said `answered`,
    // and the file flip-flopped between them.
    const st = ensureState(loadPersona(personaPath));
    expect(st.agent_session).toBeUndefined();
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

  it("C4: refuses an ambiguous edit rather than picking one", () => {
    // This replaced the FIRST occurrence and reported `edited`, so a find text that
    // appeared twice was a coin flip nobody was told about: the model asked to change
    // one thing, changed another, and believed the file was fixed.
    writeFileSync(join(dir, "twice.ts"), 'const a = "x";\nconst b = "x";\n');
    const e = executeFileEdit("twice.ts", '"x"', '"y"', policy());

    expect(e.ok).toBe(false);
    expect(e.error).toContain("appears 2 times");
    expect(e.error).toContain("no change made");
    // Refused means untouched, which is the half worth asserting: an "ambiguous"
    // error over a file that was edited anyway would be worse than no check.
    expect(readFileSync(join(dir, "twice.ts"), "utf-8")).toBe('const a = "x";\nconst b = "x";\n');
  });

  it("C4: says what it changed, and where", () => {
    writeFileSync(join(dir, "diff.ts"), "one\ntwo\nthree\n");
    const e = executeFileEdit("diff.ts", "two", "TWO", policy());

    expect(e.ok).toBe(true);
    expect(e.content).toContain("at line 2");
    expect(e.content).toContain("- two");
    expect(e.content).toContain("+ TWO");
  });

  it("C4: refuses to edit a file that is not text", () => {
    // MEASURED on 2026-09-08: reading these bytes as UTF-8 and writing the string back
    // turned 24 bytes into 40 different ones, and the tool reported `edited`.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe]);
    writeFileSync(join(dir, "image.png"), png);
    const e = executeFileEdit("image.png", "PNG", "x", policy());

    expect(e.ok).toBe(false);
    expect(e.error).toContain("not a text file");
    expect(readFileSync(join(dir, "image.png")).equals(png)).toBe(true);
  });

  it("C4: answers about a binary instead of handing back damaged text", () => {
    // Eight of its twenty-four characters came back as replacement characters, and
    // nothing in that string says "this is an image": the model pays tokens for
    // mojibake it cannot recognise as mojibake.
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x01, 0x00, 0x02, 0xff]));
    const r = readFileSafe("blob.bin", policy());

    expect(r.ok).toBe(true);
    expect(r.content).toContain("not a text file");
    expect(r.content).toContain("4 bytes");
    expect(r.content).not.toContain("�");
  });

  it("C4: still reads a text file with accents, which is not a binary", () => {
    // The control on the detector itself. A rule that called every non-ASCII file
    // binary would be worse than none: most of what this product writes has accents
    // in it.
    writeFileSync(join(dir, "prosa.md"), "camión, ñandú, façade\n", "utf-8");

    expect(readFileSafe("prosa.md", policy()).content).toBe("camión, ñandú, façade\n");
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
