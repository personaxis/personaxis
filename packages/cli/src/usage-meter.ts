/**
 * Every model call this process makes, counted where all of them pass: the global `fetch`.
 *
 * A persona step makes more calls than the one that answers. The governed tick asks the appraiser,
 * and naming a new session can ask the model too. Each of those builds its own request, in the
 * engine or in a provider, and the only place they all meet is `fetch`. Counting at the provider
 * would miss the appraiser; counting at the responder would miss both. So this wraps `fetch` for
 * as long as a command wants the numbers, and puts it back.
 *
 * Only `/chat/completions` responses are read, and only for their `usage` block. The body is read
 * from a clone before the caller gets the response, so the numbers are complete the moment the
 * call returns, and the caller reads its own copy untouched. A streamed response carries no usage
 * block to read, and is counted as a call whose tokens went unreported rather than as zero tokens.
 */

export interface ModelUsage {
	calls: number;
	promptTokens: number;
	completionTokens: number;
	/** Calls whose response said nothing about tokens. Counted so a zero is never a guess. */
	unreported: number;
}

export interface UsageMeter {
	snapshot(): ModelUsage;
	stop(): void;
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

	const metered: typeof fetch = async (input, init) => {
		const res = await original(input, init);
		if (!/\/chat\/completions\/?$/.test(urlOf(input))) return res;
		tally.calls += 1;
		const type = res.headers.get("content-type") ?? "";
		if (!res.ok || !type.includes("json")) {
			tally.unreported += 1;
			return res;
		}
		const body = (await res
			.clone()
			.json()
			.catch(() => null)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
		const usage = body?.usage;
		if (!usage || (usage.prompt_tokens === undefined && usage.completion_tokens === undefined)) {
			tally.unreported += 1;
			return res;
		}
		tally.promptTokens += usage.prompt_tokens ?? 0;
		tally.completionTokens += usage.completion_tokens ?? 0;
		return res;
	};

	globalThis.fetch = metered;
	return {
		snapshot: () => ({ ...tally }),
		stop: () => {
			// Only put back what was replaced. If something wrapped fetch after this did, restoring
			// over it would silently remove that other wrapper.
			if (globalThis.fetch === metered) globalThis.fetch = original;
		},
	};
}
