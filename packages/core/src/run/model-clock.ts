/**
 * E168: the clock a call to the model runs under, which used to be Node's and not ours.
 *
 * Node's `fetch` (undici) gives up on a request whose first header takes more than 300 seconds, and on a body that
 * goes quiet for as long. Seen on 2026-10-03 with qwen3:4b on a laptop's CPU behind Ollama: the server sends no header
 * until it has read the whole prompt, a prompt of a few thousand tokens took longer than that, and the call failed
 * with `UND_ERR_HEADERS_TIMEOUT` while the model was working. That is the first version's promise breaking on the
 * machine of the person who installs it: an open model, served locally.
 *
 * So each call to the model carries its own dispatcher, with a longer clock, instead of changing the process-wide one,
 * which would reach into whoever embeds this package. The clock still exists: a server that never answers is let go
 * after it, rather than holding the turn forever.
 */

import { Agent } from "undici";

/** Fifteen minutes, or `PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS` when set to a positive number of milliseconds. */
function modelClockMs(env: NodeJS.ProcessEnv = process.env): number {
	const declared = Number(env.PERSONAXIS_MODEL_HEADERS_TIMEOUT_MS);
	return Number.isFinite(declared) && declared > 0 ? declared : 15 * 60 * 1000;
}

let shared: { ms: number; agent: Agent } | undefined;

/**
 * The init of a call to the model, with the dispatcher that carries the clock.
 *
 * Node's `fetch` reads `dispatcher` from the init; a `fetchImpl` a test or a harness passes in receives it and may
 * ignore it, which is why a wrapper around the global `fetch` (the bench's wire log) keeps working unchanged.
 */
export function withModelClock(init: RequestInit): RequestInit {
	const ms = modelClockMs();
	if (!shared || shared.ms !== ms) shared = { ms, agent: new Agent({ headersTimeout: ms, bodyTimeout: ms }) };
	return { ...init, dispatcher: shared.agent } as RequestInit;
}
