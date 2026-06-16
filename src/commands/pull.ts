import { Command } from "commander";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import chalk from "chalk";
import matter from "gray-matter";
import { validatePersona } from "../schema.js";
import {
	REGISTRY_BASE_URL,
	REGISTRY_CLIENT_TOKEN,
	REGISTRY_UA_PREFIX,
} from "../registry-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
	readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf-8"),
) as { version: string };

function isValidSlug(slug: string): boolean {
	return slug.length > 0 && slug.length <= 100 && /^[a-z0-9][a-z0-9_-]*$/.test(slug);
}

export const pullCommand = new Command("pull")
	.description("Download a published persona from the Personaxis registry")
	.argument("<slug>", "Persona slug in the personaxis registry (e.g. 'maven')")
	.option("-o, --out <path>", "Destination path (defaults to ./PERSONA.md)")
	.option("-f, --force", "Overwrite existing file")
	.action(async (slug: string, opts: { out?: string; force?: boolean }) => {
		if (!isValidSlug(slug)) {
			console.error(chalk.red("Invalid slug:"), slug);
			console.error(chalk.dim("Slugs must be lowercase, alphanumeric with - or _, max 100 chars."));
			process.exit(1);
		}

		const dest = resolve(opts.out ?? "./PERSONA.md");
		if (existsSync(dest) && !opts.force) {
			console.error(chalk.yellow("Already exists:"), dest);
			console.error(chalk.dim("Use --force to overwrite."));
			process.exit(1);
		}

		const url = `${REGISTRY_BASE_URL}/${encodeURIComponent(slug)}`;
		console.log(chalk.dim("→"), url);

		let res: Response;
		try {
			res = await fetch(url, {
				method: "GET",
				headers: {
					"User-Agent": `${REGISTRY_UA_PREFIX}${pkg.version}`,
					"X-Personaxis-Client": REGISTRY_CLIENT_TOKEN,
					"X-Personaxis-Cli-Version": pkg.version,
					Accept: "text/markdown",
				},
			});
		} catch (err) {
			console.error(chalk.red("✗"), "Network error:", (err as Error).message);
			console.error(chalk.dim("Check your internet connection or PERSONAXIS_REGISTRY_URL."));
			process.exit(2);
		}

		if (res.status === 404) {
			console.error(chalk.red("✗"), `Persona '${slug}' not found in the personaxis registry.`);
			process.exit(1);
		}

		if (res.status === 403) {
			const body = await res.json().catch(() => null);
			const code = body?.error?.code as string | undefined;
			if (code === "INVALID_CLIENT_TOKEN") {
				console.error(chalk.red("✗"), "Client token rejected by server.");
				console.error(chalk.dim("Upgrade the CLI:"), chalk.cyan("npm i -g @personaxis/persona.md"));
			} else {
				console.error(chalk.red("✗"), "Forbidden:", body?.error?.message ?? res.statusText);
			}
			process.exit(1);
		}

		if (res.status === 429) {
			const retry = res.headers.get("retry-after");
			console.error(chalk.red("✗"), "Rate limited.", retry ? `Retry after ${retry}s.` : "Slow down and try again.");
			process.exit(1);
		}

		if (!res.ok) {
			console.error(chalk.red("✗"), `Server returned ${res.status} ${res.statusText}.`);
			process.exit(1);
		}

		const content = await res.text();
		const version = res.headers.get("x-persona-version") ?? "unknown";

		// Validate locally — write the file even on warning, but flag it.
		let validationStatus = "(skipped)";
		try {
			const { data } = matter(content);
			const result = validatePersona(data);
			validationStatus = result.status;

			if (!result.valid) {
				console.warn(chalk.yellow("!"), `Downloaded persona failed validation: ${result.status}`);
				console.warn(chalk.dim("  This is unusual for an official registry persona. Reporting details:"));
				for (const e of result.errors.slice(0, 5)) {
					console.warn(chalk.dim(`    - ${e.field}: ${e.message}`));
				}
				console.warn(chalk.dim("  The file will be written anyway; review before using."));
			} else if (result.warnings.length > 0) {
				console.warn(chalk.dim("!"), `${result.warnings.length} warning(s) — run \`personaxis validate ${opts.out ?? "PERSONA.md"}\` to inspect.`);
			}
		} catch (err) {
			console.warn(chalk.yellow("!"), "Could not parse YAML frontmatter:", (err as Error).message);
		}

		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content, "utf-8");

		console.log("");
		console.log(chalk.green("✓"), chalk.bold(slug), chalk.dim(`(v${version}, ${validationStatus})`), chalk.dim("→"), dest);
		console.log("");
		console.log(chalk.dim("  Compile to a runtime:"));
		console.log(chalk.cyan(`  personaxis compile ${opts.out ?? "PERSONA.md"} --target claude-code`));
		console.log(chalk.cyan(`  personaxis compile ${opts.out ?? "PERSONA.md"} --target codex`));
		console.log("");
	});
