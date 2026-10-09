/**
 * A valid persona for tests, written where a project keeps one.
 *
 * Until 2026-10-08 this was the product's starter persona ("Aria"), which the CLI wrote for anyone who
 * started without one. The product writes no fixed persona any more (a model writes every one, `init`), so
 * the file lives here, as a test fixture only: tests need a persona that validates and that they do not
 * have to author through a model.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { markRecompilePending } from "@personaxis/core";

const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "test-persona.md"), "utf8");

const slugify = (name: string): string =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "") || "companion";

/**
 * Write the test persona. Root (default) → `<baseDir>/.personaxis/personaxis.md`; with `subSlug`, a
 * sub-persona → `<baseDir>/.personaxis/personas/<subSlug>/personaxis.md`. Marked as never compiled.
 */
export function writeTestPersona(baseDir: string, name: string, subSlug?: string): string {
	const slug = subSlug ? slugify(subSlug) : slugify(name);
	const dir = subSlug ? join(baseDir, ".personaxis", "personas", slug) : join(baseDir, ".personaxis");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "personaxis.md");
	const content = TEMPLATE.replace(/__SLUG__/g, slug)
		.replace(/__NAME__/g, name)
		.replace(/__DATE__/g, new Date().toISOString().slice(0, 10));
	writeFileSync(path, content, "utf-8");
	markRecompilePending(path, "initial compile pending");
	return path;
}
