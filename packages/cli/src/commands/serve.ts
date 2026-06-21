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
  LivingLoop,
  HeuristicAppraiser,
  loadPersona,
  ensureState,
  extractEnvelopes,
  applyMutation,
  writeState,
  readState,
  readMemory,
  verifyMemoryChain,
  detectMemoryAnomalies,
  displayName,
  type LoopEvent,
  type ProvenanceSource,
} from "@personaxis/core";

const AGENTS_MD = (name: string) => `# ${name} — personaxis agent tools

This endpoint hosts a living, governed persona. All mutation is clamped to the
persona's envelopes and appended to an immutable audit log.

## Endpoints
- \`GET  /persona/state\` — current envelope values + recent mutations
- \`GET  /persona/audit\` — mutation log + memory-chain integrity + anomalies
- \`POST /persona/observe\` — body \`{ "observation": string, "source": "user|tool|internal|synthesis" }\`; runs one governed loop cycle
- \`POST /persona/adjust\`  — body \`{ "field": string, "delta": number, "reason": string }\`; clamped, audited mutation

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
    const handle = loadPersona(personaPath);
    if (req.method === "GET" && url === "/persona/state") {
      const st = readState(handle.statePath);
      return json(res, 200, { values: st.values, recent_mutations: st.mutation_log.slice(-5) });
    }
    if (req.method === "GET" && url === "/persona/audit") {
      const st = readState(handle.statePath);
      const mem = readMemory(handle.personaPath);
      return json(res, 200, {
        mutation_log: st.mutation_log.slice(-10),
        memory_entries: mem.length,
        memory_chain_intact: verifyMemoryChain(handle.personaPath).ok,
        anomalies: detectMemoryAnomalies(mem),
      });
    }
    if (req.method === "POST" && url === "/persona/observe") {
      const body = await readJson(req);
      const events: LoopEvent[] = [];
      const loop = new LivingLoop(personaPath, { appraiser: new HeuristicAppraiser() });
      loop.bus.on((e) => events.push(e));
      const report = await loop.tick({
        observation: String(body.observation ?? ""),
        source: (body.source as ProvenanceSource) ?? "user",
      });
      return json(res, 200, { report, events });
    }
    if (req.method === "POST" && url === "/persona/adjust") {
      const body = await readJson(req);
      const env = extractEnvelopes(handle.frontmatter);
      const st = readState(handle.statePath);
      const result = applyMutation(st, env.envelopes, {
        field: String(body.field),
        delta: Number(body.delta),
        reason: String(body.reason ?? "http adjust"),
        actor: "actor-llm",
      });
      writeState(handle.statePath, st);
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolveBody(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolveBody({});
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
    server.listen(port, () => {
      console.log(chalk.green("✓"), `persona serving on ${chalk.cyan(`http://localhost:${port}`)}`);
      console.log(chalk.dim(`  curl http://localhost:${port}/agents.md`));
    });
  });
