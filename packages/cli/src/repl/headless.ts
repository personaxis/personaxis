/**
 * Headless one-shot (V2-F3.A6): `personaxis -p "<prompt>"` runs a single
 * governed turn and prints the reply, then exits. Non-interactive (no Ink),
 * pipe-friendly, so a developer or CI can script the persona.
 * --output-format text | json | stream-json.
 */

import { ensureState, readMemoryKnobs, factsView, recallWindow, readState, readHooksConfig, runHooks } from "@personaxis/core";
import { resolvePersonaPath, makeMeter } from "./config.js";
import { makeCtx, recordTurn } from "./session.js";
import { shortName, friendlyProviderError } from "./render.js";
import { buildAwarenessBlock } from "./awareness.js";
import { expandFileMentions } from "./mentions.js";
import { COMMANDS } from "./commands.js";
import { loadMergedConfig } from "../config.js";
import { recordSpan } from "../telemetry.js";
import { holdPresence } from "../presence-session.js";

export type HeadlessFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
  persona?: string;
  prompt: string;
  format?: HeadlessFormat;
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const format: HeadlessFormat = opts.format ?? "text";
  if (format !== "text" && format !== "json" && format !== "stream-json") {
    process.stderr.write(`personaxis -p: unknown --output-format '${format}' (use text | json | stream-json)\n`);
    return 2;
  }
  const t0 = Date.now();
  const prompt = opts.prompt.trim();
  if (!prompt) {
    process.stderr.write("personaxis -p: empty prompt (pass a string or pipe it on stdin)\n");
    return 2;
  }

  // A slash command in headless mode used to be sent to the MODEL as prose, which
  // answered it by improvising: `personaxis -p "/help"` produced a plausible,
  // entirely invented help text and exit 0. An agent driving the CLI cannot tell
  // that apart from the real thing, which is worse than an error. Route it to the
  // external door each command declares instead.
  if (prompt.startsWith("/")) {
    const name = prompt.slice(1).split(/\s+/)[0].toLowerCase();
    const rest = prompt.slice(1 + name.length).trim();
    const cmd = COMMANDS.find((c) => c.name === name);
    if (!cmd) {
      process.stderr.write(
        `personaxis -p: "/${name}" is not a command. Slash commands belong to the interactive REPL; ` +
          `run \`personaxis --help\` for the subcommands an agent can call.\n`,
      );
      return 2;
    }
    if (cmd.external === "session-only") {
      process.stderr.write(
        `personaxis -p: /${name} only means something inside a live conversation` +
          `${cmd.why ? ` (${cmd.why})` : ""}, so there is nothing to run here.\n`,
      );
      return 2;
    }
    process.stderr.write(
      `personaxis -p: /${name} is a REPL command. Outside the REPL, run: personaxis ${cmd.external}${rest ? ` ${rest}` : ""}\n`,
    );
    return 2;
  }

  const personaPath = resolvePersonaPath(opts.persona);
  if (!personaPath) {
    process.stderr.write(
      "personaxis -p: no persona found (pass --persona <path> or run inside a .personaxis project)\n",
    );
    return 2;
  }
  // User hooks (V2-F3.C14): a UserPromptSubmit hook may observe or block the prompt.
  const pre = await runHooks("UserPromptSubmit", { prompt }, readHooksConfig(personaPath));
  if (pre.blocked) {
    process.stderr.write("personaxis -p: prompt blocked by a UserPromptSubmit hook\n");
    return 1;
  }

  const ctx = makeCtx(personaPath, makeMeter());
  const name = shortName(ctx);

  const knobs = readMemoryKnobs(ctx.handle.frontmatter as Record<string, unknown>);
  const known = factsView(personaPath);
  const memory = [
    ...Object.entries(known.facts).map(([k, v]) => `${k}: ${v.value}`),
    ...recallWindow(personaPath, { maxItems: knobs.maxItems, sessionId: ctx.sessionId }).map((m) => m.content),
  ];
  const state = ensureState(ctx.handle).values;

  // Streaming (V2-F3.E23): stream tokens live for text/stream-json; json buffers.
  const wantStream = format === "text" || format === "stream-json";
  if (format === "stream-json") {
    process.stdout.write(JSON.stringify({ type: "init", persona: name, session_id: ctx.sessionId }) + "\n");
  }
  let streamedAny = false;
  const onToken = wantStream
    ? (t: string) => {
        streamedAny = true;
        if (format === "text") process.stdout.write(t);
        else process.stdout.write(JSON.stringify({ type: "token", text: t }) + "\n");
      }
    : undefined;

  // D6: a headless turn is a session like any other, just without a screen. The vocabulary
  // already had a name for this surface and nothing was emitting it, so an agent driving
  // the CLI in a loop held the persona while every fleet view reported nobody there.
  const presence = holdPresence(personaPath, { host: "headless", sessionId: ctx.sessionId, activity: "answering" });
  const reply = await ctx.responder
    .respond({
      message: expandFileMentions(prompt),
      personaBody: `You are ${name}. Stay in character.\n\n${ctx.personaDoc}`,
      awareness: buildAwarenessBlock(personaPath, { frontmatter: ctx.handle.frontmatter as Record<string, unknown>, cwd: process.cwd() }),
      memory,
      state,
      name,
      ...(onToken ? { onToken } : {}),
    })
    .catch((e) => `(responder error: ${friendlyProviderError((e as Error).message)})`);
  presence.release();

  if (format === "json") {
    process.stdout.write(
      JSON.stringify({ type: "result", persona: name, reply, session_id: ctx.sessionId }) + "\n",
    );
  } else if (format === "stream-json") {
    // If tokens streamed live, the deltas already carried the text; otherwise
    // (offline responder) emit the whole message. Always close with a result.
    if (!streamedAny) {
      process.stdout.write(JSON.stringify({ type: "message", role: "assistant", text: reply }) + "\n");
    }
    process.stdout.write(JSON.stringify({ type: "result", persona: name, session_id: ctx.sessionId }) + "\n");
  } else {
    // text: tokens were streamed live; just end the line (or buffer if offline).
    if (streamedAny) process.stdout.write("\n");
    else process.stdout.write(reply + "\n");
  }
  // A headless run is a REAL session, not a fire-and-forget call: it gets a transcript on
  // disk, labelled `background`, so `/tasks <id>` can load it into a live conversation and
  // carry on. Without this the session id in the output stream pointed at nothing, and a
  // background task was a dead end by construction.
  await recordTurn(ctx, prompt, reply, "background");

  // Opt-in telemetry (V2-F3.D21), no-op unless enabled in config.
  recordSpan(personaPath, { name: "headless.turn", ms: Date.now() - t0, attrs: { format, chars: reply.length } }, loadMergedConfig().telemetry);
  return 0;
}
