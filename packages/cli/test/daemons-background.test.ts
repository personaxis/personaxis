/**
 * V7.H2/H3: what the background actually is.
 *
 * Two capabilities that existed but could not be understood or continued:
 *
 *  - `/serve` and `/watch` ran, and nothing anywhere said what they were FOR, on which
 *    port, bound where, or since when.
 *  - `/bg` produced a session id in its output stream that pointed at nothing: the run
 *    never wrote a transcript, so a background task was a dead end by construction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { makeCtx } from "../src/repl/session.js";
import { makeMeter } from "../src/repl/config.js";
import { writeStarterPersona } from "../src/starter.js";
import { daemonLines } from "../src/repl/views/settings-data.js";

chalk.level = 0;
const CLI = join(process.cwd(), "dist", "index.js");

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pxs-daemon-"));
  home = mkdtempSync(join(tmpdir(), "pxs-daemon-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("the Daemons view explains itself (V7.H2)", () => {
  it("with none running, it says what each daemon is FOR", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Clio"), makeMeter());
    const text = daemonLines(ctx).join("\n");
    expect(text).toContain("none running");
    // Purpose before mechanics: a reader must learn what these are without reading source.
    expect(text).toMatch(/\/serve[\s\S]*read this persona over HTTP/);
    expect(text).toMatch(/\/watch[\s\S]*keeps the compiled PERSONA\.md fresh/);
    // And the security posture is stated, not assumed.
    expect(text).toContain("127.0.0.1");
    expect(text).toMatch(/--token/);
  });

  it("with one running, it reports purpose, pid, uptime, port, binding and token posture", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Clio"), makeMeter());
    ctx.bg = { serve: { pid: 4242, exitCode: null } as never };
    ctx.daemonInfo = {
      serve: {
        purpose: "lets OTHER tools read this persona over HTTP",
        port: 7637,
        host: "127.0.0.1",
        tokenRequired: false,
        startedAt: Date.now() - 95_000,
      },
    };
    const text = daemonLines(ctx).join("\n");
    expect(text).toContain("lets OTHER tools read this persona over HTTP");
    expect(text).toContain("pid 4242");
    expect(text).toContain("port 7637");
    expect(text).toContain("bound to 127.0.0.1");
    expect(text).toMatch(/up \d+m/);
    expect(text).toContain("no token (local only)");
    expect(text).toContain("/serve stop");
  });

  it("a finished daemon is not reported as running", () => {
    const ctx = makeCtx(writeStarterPersona(dir, "Clio"), makeMeter());
    ctx.bg = { watch: { pid: 1, exitCode: 0 } as never };
    expect(daemonLines(ctx).join("\n")).toContain("none running");
  });
});

describe("a background run is a REAL session (V7.H3)", () => {
  it("writes a transcript, labelled `background`, under the id it reported", () => {
    const persona = writeStarterPersona(dir, "Clio", "rev");
    const r = spawnSync(
      process.execPath,
      [CLI, "-p", "what is your role?", "--persona", persona, "--output-format", "stream-json"],
      { cwd: dir, encoding: "utf-8", env: { ...process.env, PERSONAXIS_HOME: home } },
    );
    const init = (r.stdout ?? "")
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string; session_id?: string };
        } catch {
          return {};
        }
      })
      .find((e) => e.type === "init");
    expect(init?.session_id, "the run must report the session it wrote to").toBeTruthy();

    // The id it printed must correspond to a transcript that actually exists: the whole
    // point is that a task can be picked up later.
    const sessionsDir = join(dir, ".personaxis", "personas", "rev", "sessions");
    expect(existsSync(sessionsDir)).toBe(true);
    const file = readdirSync(sessionsDir).find((f) => f.startsWith(init!.session_id!));
    expect(file, `no transcript for ${init?.session_id}`).toBeTruthy();

    const lines = readFileSync(join(sessionsDir, file!), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const header = lines.find((l) => l.type === "header");
    expect(header.kind, "a background run labels itself").toBe("background");
    expect(header.id).toBe(init!.session_id);

    // Both sides of the exchange are there, which is what makes it resumable rather than
    // a log of the answer.
    const turns = lines.filter((l) => l.type === "turn");
    expect(turns.some((t) => t.role === "user" && t.content.includes("what is your role?"))).toBe(true);
    expect(turns.some((t) => t.role === "assistant")).toBe(true);
  }, 60_000);
});
