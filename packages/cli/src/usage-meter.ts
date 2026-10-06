/**
 * Every model call this process makes, counted where all of them pass: the global `fetch`.
 *
 * A persona step makes more calls than the one that answers. The governed tick asks the appraiser,
 * and naming a new session can ask the model too. Each of those builds its own request, in the
 * engine or in a provider, and the only place they all meet is `fetch`. Counting at the provider
 * would miss the appraiser; counting at the responder would miss both. So this wraps `fetch` for
 * as long as a command wants the numbers, and puts it back.
 *
 * Only `/chat/completions` responses are read, and only for their `usage` block, from a clone, so
 * the caller reads its own copy untouched. A JSON body is read before the caller gets it. A streamed
 * one is read in the background, because waiting for the whole stream first would deliver every
 * token at the end and stop it being a stream; its usage is in the last chunk when the request
 * asked for `include_usage`, which the engine's tool-calling loop does. So a caller that needs exact
 * numbers asks for `settled()`, which waits for those reads. A call whose response carried no usage
 * is counted as unreported rather than as zero tokens.
 */

export interface ModelUsage {
	calls: number;
	promptTokens: number;
	completionTokens: number;
	/** Calls whose response said nothing about tokens. Counted so a zero is never a guess. */
	unreported: number;
}

export interface UsageMeter {
	/** The numbers so far. A stream still being read is not in them yet: see `settled`. */
	snapshot(): ModelUsage;
	/** The numbers once every response read so far has been read to its end. */
	settled(): Promise<ModelUsage>;
	stop(): void;
}

type UsageBlock = { prompt_tokens?: number; completion_tokens?: number };

/** The usage of a server-sent-events body: the last `data:` chunk that carried one. */
export function usageFromStream(text: string): UsageBlock | null {
	let found: UsageBlock | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const chunk = JSON.parse(data) as { usage?: UsageBlock | null };
			if (chunk.usage) found = chunk.usage;
		} catch {
			// A chunk that is not JSON carries no usage. Skipped, not fatal: the answer is not ours.
		}
	}
	return found;
}

const ZERO: ModelUsage = { calls: 0, promptTokens: 0, completionTokens: 0, unreported: 0 };

/** The difference between two snapshots: what happened between them. */
export function usageBetween(before: ModelUsage, after: ModelUsage): ModelUsage {
	return {
		calls: after.calls - before.calls,
		promptTokens: after.promptTokens - before.promptTokens,
		completionTokens: after.completionTokens - before.completionTokens,
		unreported: after.unreported - before.unreported,
	};
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

export function meterModelCalls(): UsageMeter {
	const original = globalThis.fetch;
	const tally: ModelUsage = { ...ZERO };
	const pending = new Set<Promise<void>>();

	const count = (usage: UsageBlock | null | undefined): void => {
		if (!usage || (usage.prompt_tokens === undefined && usage.completion_tokens === undefined)) {
			tally.unreported += 1;
			return;
		}
		tally.promptTokens += usage.prompt_tokens ?? 0;
		tally.completionTokens += usage.completion_tokens ?? 0;
	};

	const metered: typeof fetch = async (input, init) => {
		const res = await original(input, init);
		if (!/\/chat\/completions\/?$/.test(urlOf(input))) return res;
		tally.calls += 1;
		const type = res.headers.get("content-type") ?? "";
		if (!res.ok) {
			tally.unreported += 1;
			return res;
		}
		if (type.includes("event-stream")) {
			const reading: Promise<void> = res
				.clone()
				.text()
				.then((text) => count(usageFromStream(text)))
				.catch(() => count(null))
				.finally(() => pending.delete(reading));
			pending.add(reading);
			return res;
		}
		if (!type.includes("json")) {
			tally.unreported += 1;
			return res;
		}
		const body = (await res
			.clone()
			.json()
			.catch(() => null)) as { usage?: UsageBlock } | null;
		count(body?.usage);
		return res;
	};

	globalThis.fetch = metered;
	return {
		snapshot: () => ({ ...tally }),
		settled: async () => {
			while (pending.size > 0) await Promise.all([...pending]);
			return { ...tally };
		},
		stop: () => {
			// Only put back what was replaced. If something wrapped fetch after this did, restoring
			// over it would silently remove that other wrapper.
			if (globalThis.fetch === metered) globalThis.fetch = original;
		},
	};
}
