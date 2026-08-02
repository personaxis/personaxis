/**
 * J.2b: asking for a tool that is not in the subset.
 *
 * J.2 narrows the catalog to what a task's skills need, because a model shown forty tools
 * picks worse than one shown six. The cost is the case J.2 cannot predict: a task that
 * turns out to need something the skill did not declare. Without a way out, the model does
 * the wrong thing with a tool it has rather than saying it needs one it does not, and that
 * failure looks like a capable agent making a bad choice.
 *
 * The deferred pattern: the model searches, gets NAMES AND DESCRIPTIONS, and asks for the
 * ones it wants. Two properties matter and neither is obvious:
 *
 *   SEARCHING IS NOT GRANTING. Finding a tool tells the model it exists; the loop decides
 *   whether to expand the subset, and the tool's own gate still runs at call time. A search
 *   result that were also an authorisation would make the narrowing decorative.
 *
 *   IT ANSWERS WITH NOTHING RATHER THAN GUESSING. A search that matched nothing returns an
 *   empty list saying so. Returning the closest thing is how a model ends up using
 *   `run_command` because it asked for `send_email`.
 */

import type { ToolSpec } from "./registry.js";

export interface ToolMatch {
	name: string;
	category: string;
	description: string;
	/** Already in the subset, so asking for it is a no-op. */
	active: boolean;
}

/**
 * Search a catalog by words in a query.
 *
 * Scored rather than filtered, because a model asking to "send an email to the team" should
 * find `send_email` above `send_slack_message`, and a boolean match orders them by whatever
 * the registry happened to return. Deliberately simple: substring matching over name,
 * category and description. Anything cleverer here is a ranking model nobody can debug from
 * a trace, and the model reads the descriptions anyway.
 */
export function findTools(query: string, catalog: readonly ToolSpec[], active: readonly ToolSpec[]): ToolMatch[] {
	const activeNames = new Set(active.map((t) => t.name));
	const words = query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((w) => w.length > 2);

	if (words.length === 0) return [];

	const scored = catalog.map((tool) => {
		const name = tool.name.toLowerCase();
		const description = tool.description.toLowerCase();
		// Optional on ToolSpec: tools authored before J.1 carry no category, and reading
		// through undefined here would throw on exactly those.
		const category = (tool.category ?? "").toLowerCase();

		let score = 0;
		for (const word of words) {
			// A name match is worth most: it is the thing the model will actually call, and
			// a description mentioning "email" is much weaker evidence than a name that is
			// `send_email`.
			if (name.includes(word)) score += 10;
			if (category.includes(word)) score += 4;
			if (description.includes(word)) score += 1;
		}
		return { tool, score };
	});

	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
		.slice(0, 10)
		.map(({ tool }) => ({
			name: tool.name,
			category: tool.category ?? "uncategorized",
			description: tool.description,
			active: activeNames.has(tool.name),
		}));
}

/**
 * What the model is told about a search.
 *
 * An empty result says so plainly and does not suggest alternatives. "No tool matches X"
 * lets a model conclude the task cannot be done that way; a list of near-misses invites it
 * to use one of them.
 */
export function describeMatches(query: string, matches: readonly ToolMatch[]): string {
	if (matches.length === 0) {
		return `No tool matches "${query}". Nothing here can do that; say so rather than substituting another tool.`;
	}

	const lines = matches.map(
		(m) => `${m.name} (${m.category})${m.active ? " [already available]" : ""}: ${m.description}`,
	);
	return [
		`${matches.length} tool(s) match "${query}":`,
		...lines,
		"",
		"Tools not marked [already available] have been added for this run. Their own limits still apply when you call them.",
	].join("\n");
}

/**
 * Expand a subset with the tools a search turned up.
 *
 * Returns a NEW array; the caller replaces its `activeTools`. Bounded, because a model that
 * searches repeatedly would otherwise rebuild the full catalog one query at a time and undo
 * the narrowing entirely, quietly, over a long run.
 */
export function expandActive(
	active: readonly ToolSpec[],
	catalog: readonly ToolSpec[],
	matches: readonly ToolMatch[],
	maxTotal = 20,
): ToolSpec[] {
	const byName = new Map(catalog.map((t) => [t.name, t]));
	const out = [...active];
	const present = new Set(out.map((t) => t.name));

	for (const match of matches) {
		if (out.length >= maxTotal) break;
		if (present.has(match.name)) continue;
		const tool = byName.get(match.name);
		if (!tool) continue;
		out.push(tool);
		present.add(match.name);
	}

	return out;
}

/** The name the loop special-cases. One owner, so a rename cannot half-happen. */
export const FIND_TOOLS_TOOL = "find_tools";

/**
 * The tool the model calls.
 *
 * Its `execute` is never reached: the loop intercepts by name, because the result has to
 * change the loop's own subset and a tool cannot reach that. It is here so the model is
 * shown a real declaration rather than an instruction in a prompt, and the body says so
 * rather than returning something plausible if anyone ever calls it directly.
 */
export const findToolsTool: ToolSpec = {
	name: FIND_TOOLS_TOOL,
	category: "meta",
	description:
		"Search for a tool you have not been given. Describe what you need to do in plain words " +
		"(for example 'send an email'). Returns matching tool names with their descriptions and " +
		"makes them available for this run. If nothing matches, say the task cannot be done that " +
		"way rather than substituting another tool.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: { query: { type: "string", description: "What you need to do, in plain words." } },
	},
	isReadOnly: true,
	isConcurrencySafe: true,
	gate: () => ({
		decision: "allow",
		reason: "searching is not acting",
		// A lookup over a static catalog: it writes nothing, reaches nothing, and cannot
		// leave the workspace. What it FINDS still faces its own gate when called.
		class: { writesFiles: false, network: false, destructive: false, escapesWorkspace: false },
	}),
	execute: async () =>
		"error: find_tools is handled by the agent loop and cannot be executed directly.",
};
