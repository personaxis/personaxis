/**
 * `personaxis web search`: the same web search a persona gets, run by a person.
 *
 * Added 2026-09-11 with the provider layer in core. It answers the same question a persona's
 * `web_search` tool answers, through the same resolution: the project's `web` block, then the
 * home's, then Tavily when `TAVILY_API_KEY` is set. So what a person sees here is what a persona
 * would have been handed, and a missing key says so in one line instead of failing mid-turn.
 */

import { Command } from "commander";
import chalk from "chalk";
import { WEB_PROVIDERS, renderWebResults, resolveWebSearch } from "@personaxis/core";

const searchCommand = new Command("search")
	.description("Search the web with the configured provider (Tavily first), as a persona's web_search tool would")
	.argument("<query...>", "What to search for")
	.option("-n, --max <n>", "How many results, 1 to 10", "5")
	.option("--deep", "Ask the provider for better excerpts (costs more per query)", false)
	.option("--json", "Print the results as JSON", false)
	.action(async (words: string[], opts: { max: string; deep?: boolean; json?: boolean }) => {
		const query = words.join(" ");
		const provider = resolveWebSearch();
		if (!provider) {
			console.error(
				chalk.red("✗"),
				`no web search provider: set TAVILY_API_KEY, or add "web": { "provider": "tavily", "apiKeyEnv": "<VAR>" } to .personaxis/config.json. Known providers: ${WEB_PROVIDERS.join(", ")}.`,
			);
			process.exitCode = 2;
			return;
		}
		try {
			const results = await provider.search(query, { maxResults: Number(opts.max) || 5, depth: opts.deep ? "advanced" : "basic" });
			console.log(opts.json ? JSON.stringify({ provider: provider.name, query, results }, null, 2) : renderWebResults(query, results));
		} catch (e) {
			console.error(chalk.red("✗"), e instanceof Error ? e.message : String(e));
			process.exitCode = 1;
		}
	});

export const webCommand = new Command("web").description("Search the web with the configured provider").addCommand(searchCommand);
