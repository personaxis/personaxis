/**
 * `personaxis serve` — expose a living persona over plain HTTP + agents.md (F5).
 *
 * The low-context interop path (Hugging Face "Spaces as Agent Tools" pattern):
 * any agent that doesn't speak MCP can `curl /agents.md`, learn the endpoints,
 * and drive the persona over HTTP. Same governed engine as the REPL/MCP — every
 * mutation clamped + audited, every observation injection-scanned.
 *
 *   GET  /agents.md            human/agent-readable tool contract
 *   GET  /persona/state        current envelope values + recent mutations
 *   GET  /persona/audit        mutation log + memory chain + anomalies
 *   POST /persona/observe      { observation, source } -> one governed loop cycle
 *   POST /persona/adjust       { field, delta, reason } -> clamped, audited mutation
 */

import { Command } from "commander";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import {
  loadPersona,
  ensureState,
  extractEnvelopes,
  resolveField,
  displayName,
  type ProvenanceSource,
} from "@personaxis/core";
import { Persona } from "@personaxis/sdk";

const AGENTS_MD = (name: string) => `# ${name} — personaxis agent tools

This endpoint hosts a living, governed persona. All mutation is clamped to the
persona's envelopes and appended to an immutable audit log.

## Endpoints
- \`GET  /persona/state\` — current envelope values + recent mutations
- \`GET  /persona/audit\` — mutation log + memory-chain integrity + anomalies
- \`POST /persona/observe\` — body \`{ "observation": string, "source": "user|tool|internal|synthesis" }\`; runs one governed loop cycle
- \`POST /persona/adjust\`  — body \`{ "field": string, "delta": number, "reason": string }\`; clamped, audited mutation
- \`POST /persona/agent\`   — body \`{ "task": string }\`; runs the governed Agent Loop (sandbox-gated tool calls); needs a tool-calling model

## Notes
- Untrusted observations are prompt-injection scanned; malicious ones do not steer evolution.
- Identity is immutable; only runtime state + memory evolve, within universal invariants.
`;

export function buildHttpServer(personaPath: string): Server {
  const handle = loadPersona(personaPath);
  ensureState(handle);
  const name = displayName(handle.frontmatter);

  return createServer((req, res) => void route(req, res, personaPath, name));
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  personaPath: string,
  name: string,
): Promise<void> {
  try {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/agents.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end(AGENTS_MD(name));
      return;
    }
    // Engine ops delegate to the single SDK façade (F3.5); serve owns only HTTP
    // shaping + validation + injection-scanned observations (unchanged behavior).
    const persona = new Persona(personaPath);
    if (req.method === "GET" && url === "/persona/state") {
      const st = persona.state();
      return json(res, 200, { values: st.values, recent_mutations: st.recentMutations });
    }
    if (req.method === "GET" && url === "/persona/audit") {
      const a = persona.audit();
      return json(res, 200, {
        mutation_count: a.mutationCount,
        memory_entries: a.memoryEntries,
        memory_chain_intact: a.memoryChainIntact,
        anomalies: a.anomalies,
      });
    }
    if (req.method === "POST" && url === "/persona/observe") {
      const { body, parseError } = await readJson(req);
      if (parseError) return json(res, 400, { error: "invalid JSON body" });
      const observation = String(body.observation ?? "");
      if (!observation.trim()) return json(res, 400, { error: "observation (non-empty string) is required" });
      const { report, events } = await persona.observe(observation, (body.source as ProvenanceSource) ?? "user");
      return json(res, 200, { report, events });
    }
    if (req.method === "POST" && url === "/persona/adjust") {
      const { body, parseError } = await readJson(req);
      if (parseError) return json(res, 400, { error: "invalid JSON body" });
      // HTTP validation stays in serve; the mutation itself (clamp+audit+lock) is the SDK's.
      const env = extractEnvelopes(loadPersona(personaPath).frontmatter);
      const field = resolveField(String(body.field ?? ""), env.envelopes);
      const delta = Number(body.delta);
      if (!(field in env.envelopes)) {
        return json(res, 400, { error: `unknown envelope field '${field}'`, fields: Object.keys(env.envelopes) });
      }
      if (!Number.isFinite(delta)) return json(res, 400, { error: "delta must be a finite number" });
      const result = persona.adjust(field, delta, String(body.reason ?? "http adjust"));
      return json(res, 200, result);
    }
    if (req.method === "POST" && url === "/persona/agent") {
      const { body, parseError } = await readJson(req);
      if (parseError) return json(res, 400, { error: "invalid JSON body" });
      const task = String(body.task ?? "");
      if (!task.trim()) return json(res, 400, { error: "task (non-empty string) is required" });
      const result = await persona.agentRun(task);
      if ("error" in result) return json(res, 400, result);
      return json(res, 200, result);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

interface ParsedBody {
  body: Record<string, unknown>;
  parseError: boolean;
}

function readJson(req: IncomingMessage): Promise<ParsedBody> {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    const MAX = 1_000_000; // 1 MB cap — refuse oversized bodies
    req.on("data", (c) => {
      raw += c;
      if (raw.length > MAX) {
        req.destroy();
        rejectBody(new Error("request body too large"));
      }
    });
    req.on("error", (err) => rejectBody(err));
    req.on("end", () => {
      if (!raw) return resolveBody({ body: {}, parseError: false });
      try {
        resolveBody({ body: JSON.parse(raw) as Record<string, unknown>, parseError: false });
      } catch {
        resolveBody({ body: {}, parseError: true });
      }
    });
  });
}

export const serveCommand = new Command("serve")
  .description("Serve a living persona over HTTP + agents.md (low-context interop for any agent).")
  .requiredOption("-p, --persona <path>", "Path to personaxis.md / PERSONA.md")
  .option("--port <n>", "Port", "7637")
  .action((opts: { persona: string; port: string }) => {
    const personaPath = resolve(opts.persona);
    if (!existsSync(personaPath)) {
      console.error(chalk.red("Error:"), `persona not found at ${personaPath}`);
      process.exit(1);
    }
    const server = buildHttpServer(personaPath);
    const port = Number(opts.port) || 7637;
    server.on("error", (err: NodeJS.ErrnoException) => {
      const why = err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message;
      console.error(chalk.red("Error:"), `could not start server — ${why}`);
      process.exit(1);
    });
    server.listen(port, () => {
      console.log(chalk.green("✓"), `persona serving on ${chalk.cyan(`http://localhost:${port}`)}`);
      console.log(chalk.dim(`  curl http://localhost:${port}/agents.md`));
    });
  });
