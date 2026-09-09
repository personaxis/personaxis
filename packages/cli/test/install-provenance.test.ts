/**
 * R5: an installed persona says where it came from and what changed since.
 *
 * ASI04 is supply chain, and a persona pulled from a registry is a supply chain with
 * exactly one link. MEASURED on 2026-09-09: `personaxis pull` knew the registry, the
 * reference and the version the server said it was serving, printed all three, wrote
 * the file verbatim and **recorded none of it**. So an installed persona could answer
 * neither half of this row: not where it came from, and not what changed since, because
 * without a baseline taken on arrival a local edit and an upstream difference are the
 * same unknown.
 *
 * It goes in the manifest, which is already the thing beside a persona that holds
 * hashes so a hand-edit can be detected. Not in the persona document, because `R6` just
 * fixed that a persona's definition must load in a host that is not ours, and "pulled
 * from this registry on Tuesday" is a fact about THIS COPY. Not in a new sidecar,
 * because a second file holding a second hash of the same document is how two answers
 * to one question begin.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	hashContent,
	loadManifest,
	recordInstall,
	saveManifest,
	type InstallProvenance,
} from "../src/manifest.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pxs-install-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DELIVERED = "---\nmetadata: { name: watcher }\n---\nThe body as it arrived.\n";

const arrival = (over: Partial<InstallProvenance> = {}): InstallProvenance => ({
	registry: "https://personaxis.com/api/v1/personas",
	slug: "@acme/watcher",
	version: "2.1.0",
	at: "2026-09-09T10:00:00.000Z",
	hash: hashContent(DELIVERED),
	...over,
});

describe("what an install writes down", () => {
	it("records where it came from, which nothing did before", () => {
		recordInstall(dir, arrival());
		const manifest = loadManifest(dir);

		expect(manifest?.installed).toMatchObject({
			registry: "https://personaxis.com/api/v1/personas",
			slug: "@acme/watcher",
			version: "2.1.0",
		});
		expect(manifest?.lastOp).toBe("install");
	});

	it("records the registry by URL, so a private one is legible too", () => {
		// A boolean "from the official registry" would answer the question for exactly
		// one deployment and lie for every other.
		recordInstall(dir, arrival({ registry: "https://registry.internal.acme/api" }));

		expect(loadManifest(dir)?.installed?.registry).toBe("https://registry.internal.acme/api");
	});

	it("takes the hash of what ARRIVED, which is what makes drift answerable", () => {
		recordInstall(dir, arrival());
		const recorded = loadManifest(dir)?.installed?.hash;

		expect(recorded).toBe(hashContent(DELIVERED));
		// The point of it: the same bytes still match, and one edited character does not.
		expect(hashContent(DELIVERED)).toBe(recorded);
		expect(hashContent(`${DELIVERED}a local edit\n`)).not.toBe(recorded);
	});
});

describe("installing over something that was already here", () => {
	it("keeps the compile baseline, so a re-pull is not read as a clean tree", () => {
		// The rule this function exists for. `validate` and `push` read those hashes to
		// tell a hand-edit from an untouched pair; replacing the manifest outright would
		// make a second pull look like a checkout nobody had ever compiled.
		saveManifest(dir, {
			spec_version: "1.0.0",
			compiledPath: "PERSONA.md",
			personaxisMdHash: "spec-hash",
			compiledMdHash: "compiled-hash",
			lastOp: "compile",
			model: "some-model",
			source: "manual",
			timestamp: "2026-09-01T00:00:00.000Z",
		});

		recordInstall(dir, arrival());
		const manifest = loadManifest(dir);

		expect(manifest?.personaxisMdHash).toBe("spec-hash");
		expect(manifest?.compiledMdHash).toBe("compiled-hash");
		expect(manifest?.compiledPath).toBe("PERSONA.md");
		expect(manifest?.installed?.version).toBe("2.1.0");
		expect(manifest?.lastOp).toBe("install");
	});

	it("replaces the older provenance rather than keeping two", () => {
		// Two answers to "where did this come from" is worse than one that is out of
		// date: the copy on disk came from exactly one place, the last one.
		recordInstall(dir, arrival({ version: "1.0.0" }));
		recordInstall(dir, arrival({ version: "2.1.0", at: "2026-09-09T12:00:00.000Z" }));

		expect(loadManifest(dir)?.installed?.version).toBe("2.1.0");
		expect(loadManifest(dir)?.installed?.at).toBe("2026-09-09T12:00:00.000Z");
	});

	it("writes a manifest from nothing when there was none", () => {
		// The ordinary case: pulling into an empty directory. The compile halves stay
		// ABSENT rather than being filled with empty strings, because a manifest that
		// claimed a compile had happened would make `validate` report drift against a
		// baseline nobody took.
		recordInstall(dir, arrival());
		const manifest = loadManifest(dir);

		expect(manifest?.installed).toBeDefined();
		expect(manifest?.compiledMdHash).toBeUndefined();
		expect(manifest?.personaxisMdHash).toBeUndefined();
	});
});
