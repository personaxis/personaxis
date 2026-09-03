/**
 * What each destination says it accepts.
 *
 * `model-seam.ts` states the rule this file exists to serve: a destination declares
 * its capabilities and the caller reads the declaration, rather than a cascade of
 * predicates over a hostname. The seam has been written since phase 4 and nothing
 * declared anything, so the rule had no data to run on.
 *
 * ## The table is deliberately small, and silence means no
 *
 * An entry exists only where the capability is known from the provider's own
 * documentation. Everything else resolves to `UNKNOWN`, which accepts no effort level,
 * caches nothing and takes no foreign reasoning. That default is not laziness, it is
 * the only safe direction: the field we would otherwise send is one an endpoint that
 * does not know it rejects with a 400, and a local runtime somebody spun up this
 * morning is exactly the endpoint least likely to know it.
 *
 * So a model gains an effort level by being added here on purpose, with a reason, and
 * never by resembling one that has it.
 *
 * ## Matched on the model, then on the endpoint
 *
 * The model name is the specific fact and the endpoint is the general one. A gateway
 * that proxies many models under one host answers on its own URL, so matching the
 * endpoint first would give every model behind it the capabilities of whichever one
 * the entry was written for.
 */

import type { DestinationCapabilities } from "./model-seam.js";

/**
 * What a destination nobody declared is assumed to do: nothing extra.
 *
 * Named rather than inline so a reader can see that the fallback is a real entry with
 * real values, rather than an accident of an object being undefined somewhere.
 *
 * Not exported. It is the shape of an absence, and a caller that wanted it would be
 * asking "what does a destination I know nothing about accept", which is a question
 * `capabilitiesFor` already answers by returning it.
 */
const UNKNOWN: DestinationCapabilities = {
	id: "unknown",
	effort: [],
	foreignReasoning: false,
	cacheSeconds: 0,
	rejects: [],
};

interface Entry {
	/** Matched against the model name, case insensitively. */
	readonly model?: RegExp;
	/** Matched against the endpoint, when the model was not enough. */
	readonly endpoint?: RegExp;
	readonly capabilities: DestinationCapabilities;
}

/**
 * The declarations, most specific first.
 *
 * Effort vocabularies differ between families and are NOT translated here. A level
 * this table does not list is stepped down by `resolveEffort`, never up, which is the
 * one behaviour of this subsystem worth copying from the reference without changes:
 * their unrecognised level fell back to a weak default, so asking for the maximum
 * resolved weaker than asking for a middle level.
 */
const TABLE: readonly Entry[] = [
	{
		// OpenAI's reasoning models take a named effort. `minimal` exists on the newer
		// ones and not on the o-series, and the ladder handles that by stepping down.
		model: /^(o[1-9]|gpt-5)/i,
		capabilities: {
			id: "openai-reasoning",
			effort: ["low", "medium", "high"],
			foreignReasoning: false,
			cacheSeconds: 3600,
			rejects: [],
		},
	},
	{
		// The rest of OpenAI's chat models: prompt caching, no effort vocabulary.
		endpoint: /api\.openai\.com/i,
		capabilities: {
			id: "openai",
			effort: [],
			foreignReasoning: false,
			cacheSeconds: 3600,
			rejects: [],
		},
	},
	{
		// Anthropic budgets thinking in tokens rather than in levels, so it declares no
		// effort ladder: a level sent here would be a field it does not know. Its cache
		// is explicit and short-lived, which is what `cachePrefix` marks.
		endpoint: /api\.anthropic\.com/i,
		capabilities: {
			id: "anthropic",
			effort: [],
			foreignReasoning: false,
			cacheSeconds: 300,
			rejects: [],
		},
	},
];

/**
 * What this endpoint and model accept.
 *
 * The id carries the model name so two models on one host are two destinations, which
 * matters for `mayReplay`: reasoning issued by one model is not reasoning the next one
 * can be handed back.
 */
export function capabilitiesFor(endpoint: string, model: string): DestinationCapabilities {
	for (const entry of TABLE) {
		if (entry.model?.test(model) || (entry.endpoint && !entry.model && entry.endpoint.test(endpoint))) {
			return { ...entry.capabilities, id: `${entry.capabilities.id}:${model}` };
		}
	}
	return { ...UNKNOWN, id: `unknown:${model}` };
}
