/**
 * F6.5, shared HTTP hardening for every provider call.
 *
 * Before this, a hung endpoint hung the CLI forever, a 429 failed immediately,
 * and errors dropped the response body (the part that says WHY). One helper
 * fixes all three for byok + local: bounded timeout (AbortSignal), jittered
 * retry on 429/5xx/network errors, and error messages that carry an excerpt of
 * the body. Deterministic-friendly: retries/timeout are injectable for tests.
 */

export interface PostJsonOptions {
  timeoutMs?: number;
  /** Retries AFTER the first attempt (default 2 → 3 attempts total). */
  retries?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam: sleep between retries. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * E48: an OpenAI-compatible stream (`data:` frames of `choices[0].delta`) as the completion it adds up to.
 *
 * Text, reasoning, the finish reason, the model and the usage, which is everything a caller of a whole completion
 * reads. A frame that does not parse is skipped rather than fatal, as the rest of the stream still carries the answer.
 */
function assembleStream(text: string): unknown {
  let content = "";
  let reasoning = "";
  let finish: string | undefined;
  let model: string | undefined;
  let usage: unknown;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const frame = JSON.parse(data) as {
        model?: string;
        usage?: unknown;
        choices?: { finish_reason?: string | null; delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
      };
      model ??= frame.model;
      if (frame.usage) usage = frame.usage;
      const choice = frame.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      content += choice?.delta?.content ?? "";
      reasoning += choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? "";
    } catch {
      // A frame that does not parse is not the answer; the others still are.
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    choices: [{ ...(finish ? { finish_reason: finish } : {}), message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }],
  };
}

/** True for statuses worth retrying: rate limits and transient server errors. */
const retryable = (status: number): boolean => status === 429 || status >= 500;

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const retries = opts.retries ?? 2;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  // A timeout gets ONE retry, not the full budget. A 429 or a 502 is a blip and retrying
  // is right; a request that ran out of time against a model producing ~25 tokens/second is
  // going to run out of time again, and three attempts turn one slow call into three times
  // the wait for the same answer. Measured 2026-09-10: gemma-3-4b-it on the HuggingFace
  // router sustains 24 to 28 tokens per second, so a full 8192-token completion needs about
  // five minutes and no amount of retrying makes it shorter.
  const timeoutRetries = Math.min(retries, 1);
  let timeoutsSeen = 0;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter: ~1s, ~2s (+0-250ms).
      await sleep(2 ** (attempt - 1) * 1000 + Math.random() * 250);
    }
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const excerpt = (await res.text().catch(() => "")).slice(0, 400);
        const err = new Error(
          `${url} → ${res.status} ${res.statusText}${excerpt ? `: ${excerpt}` : ""}`,
        );
        if (retryable(res.status) && attempt < retries) {
          lastError = err;
          continue;
        }
        throw err;
      }
      // E48: a streamed answer is put back together into the shape of a whole one, so the caller reads both the same.
      // Decided by what the server sent, not by what was asked: a server that ignores `stream` still answers whole.
      if ((res.headers?.get?.("content-type") ?? "").includes("text/event-stream")) return assembleStream(await res.text());
      return (await res.json()) as unknown;
    } catch (e) {
      const err = e as Error;
      // AbortError (timeout) and network failures are retryable; HTTP errors
      // already decided above (a thrown non-retryable Error must not loop).
      const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
      const isTimeoutOrNetwork = isTimeout || err.message.includes("fetch failed");
      if (isTimeout) timeoutsSeen += 1;
      const budget = isTimeout ? timeoutRetries : retries;
      if (isTimeoutOrNetwork && (isTimeout ? timeoutsSeen <= budget : attempt < retries)) {
        lastError = err;
        continue;
      }
      if (isTimeout) {
        // Say what ran out, and what to change. "The operation was aborted due to timeout"
        // names the mechanism and hides the cause, which for a small open model is almost
        // always that the answer was longer than the clock allowed.
        throw new Error(
          `${url} → timed out after ${timeoutMs} ms. A small open model generates at roughly ` +
            `25 tokens/second, so a long answer needs minutes, not seconds. Raise the timeout, ` +
            `or lower maxTokens so the answer fits the clock.`,
        );
      }
      throw attempt > 0 && lastError && !isTimeoutOrNetwork ? err : err;
    }
  }
  throw lastError ?? new Error(`${url}: request failed`);
}
