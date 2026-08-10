import { Command } from "commander";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import chalk from "chalk";
import matter from "gray-matter";
import { validatePersona } from "../schema.js";
import { version } from "../generated/assets.js";
import {
	REGISTRY_BASE_URL,
	REGISTRY_CLIENT_TOKEN,
	REGISTRY_UA_PREFIX,
} from "../registry-config.js";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

function isValidName(value: string): boolean {
	return value.length > 0 && value.length <= 100 && NAME.test(value);
}

/**
 * `maven` is the official catalogue; `@david/maven` is somebody's own.
 *
 * The bare form keeps meaning what it has always meant. A `personaxis pull
 * maven` already exists in installs out there, and quietly resolving it
 * somewhere else would break them.
 *
 * Returns the path segments to request, or null if the reference is malformed.
 */
export function parsePersonaRef(reference: string): string[] | null {
	if (!reference.startsWith("@")) {
		return isValidName(reference) ? [reference] : null;
	}

	const [namespace, slug, ...rest] = reference.slice(1).split("/");
	if (rest.length > 0 || !namespace || !slug) return null;
	if (!isValidName(namespace) || !isValidName(slug)) return null;
	return [`@${namespace}`, slug];
}

export const pullCommand = new Command("pull")
	.description("Download a published persona from the Personaxis registry")
	.argument("<persona>", "'maven' for the official catalogue, or '@namespace/slug' for anybody's")
	.option("-o, --out <path>", "Destination path (defaults to ./PERSONA.md)")
	.option("-f, --force", "Overwrite existing file")
	.action(async (slug: string, opts: { out?: string; force?: boolean }) => {
		const segments = parsePersonaRef(slug);
		if (!segments) {
			console.error(chalk.red("Invalid persona reference:"), slug);
			console.error(
				chalk.dim("Expected 'slug' or '@namespace/slug', lowercase alphanumeric with - or _, max 100 chars each."),
			);
			process.exit(1);
		}

		const dest = resolve(opts.out ?? "./PERSONA.md");
		if (existsSync(dest) && !opts.force) {
			console.error(chalk.yellow("Already exists:"), dest);
			console.error(chalk.dim("Use --force to overwrite."));
			process.exit(1);
		}

		// Segment by segment, not one encoded string. `@david%2Fmaven` would depend
		// on every proxy in between leaving the encoded slash alone, and one that
		// normalised it would turn a working pull into a 404 nobody can reproduce.
		const url = `${REGISTRY_BASE_URL}/${segments.map(encodeURIComponent).join("/")}`;
		console.log(chalk.dim("→"), url);

		let res: Response;
		try {
			res = await fetch(url, {
				method: "GET",
				headers: {
					"User-Agent": `${REGISTRY_UA_PREFIX}${version}`,
					"X-Personaxis-Client": REGISTRY_CLIENT_TOKEN,
					"X-Personaxis-Cli-Version": version,
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
				console.error(chalk.dim("Upgrade the CLI:"), chalk.cyan("npm i -g personaxis"));
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
		const personaVersion = res.headers.get("x-persona-version") ?? "unknown";

		// Validate locally, write the file even on warning, but flag it.
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
				console.warn(chalk.dim("!"), `${result.warnings.length} warning(s), run \`personaxis validate ${opts.out ?? "PERSONA.md"}\` to inspect.`);
			}
		} catch (err) {
			console.warn(chalk.yellow("!"), "Could not parse YAML frontmatter:", (err as Error).message);
		}

		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content, "utf-8");

		console.log("");
		console.log(chalk.green("✓"), chalk.bold(slug), chalk.dim(`(v${personaVersion}, ${validationStatus})`), chalk.dim("→"), dest);
		console.log("");
		console.log(chalk.dim("  Compile to a runtime:"));
		console.log(chalk.cyan(`  personaxis compile ${opts.out ?? "PERSONA.md"} --target claude-code`));
		console.log(chalk.cyan(`  personaxis compile ${opts.out ?? "PERSONA.md"} --target codex`));
		console.log("");
	});
