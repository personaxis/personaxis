/**
 * F6.5 — shared HTTP hardening for every provider call.
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
      return (await res.json()) as unknown;
    } catch (e) {
      const err = e as Error;
      // AbortError (timeout) and network failures are retryable; HTTP errors
      // already decided above (a thrown non-retryable Error must not loop).
      const isTimeoutOrNetwork = err.name === "TimeoutError" || err.name === "AbortError" || err.message.includes("fetch failed");
      if (isTimeoutOrNetwork && attempt < retries) {
        lastError = err;
        continue;
      }
      throw attempt > 0 && lastError && !isTimeoutOrNetwork ? err : err;
    }
  }
  throw lastError ?? new Error(`${url}: request failed`);
}
