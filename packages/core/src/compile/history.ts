/**
 * Every version of a persona's compiled document, with why it was written and from what.
 *
 * Since 2026-10-07 a model writes PERSONA.md, so two compiles of the same definition are two different
 * documents, and the one an agent read last Tuesday is not recoverable from the definition. Each written
 * version goes into the persona's record as a `compiled` entry (the hash-chained record already had the
 * kind, and nothing wrote it): the document's hash, the cause (creation, a band crossed in a session, an
 * applied self-edit, a manual compile), the hash of the definition it came from, and the model. The text
 * itself is kept once per hash in `compiled/<hash>.md` beside the persona, so a version can be read back.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { openRecord } from "../record/store.js";
import { writingToRecord } from "../record/transaction.js";

export interface CompiledVersion {
	/** When the record says it was written. */
	at: string;
	/** sha256 of the document, the name of its kept copy. */
	hash: string;
	cause?: string;
	/** sha256 of the personaxis.md it was written from. */
	spec?: string;
	model?: string;
	/** Where the text of this version is kept, when it is. */
	path?: string;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const keptAt = (personaPath: string, hash: string): string => join(dirname(personaPath), "compiled", `${hash}.md`);

/**
 * Record a compiled document: its text kept once per hash, and a `compiled` entry in the persona's record.
 * `statePath` is the persona's write lock, as for every record write.
 */
export async function recordCompiled(
	personaPath: string,
	statePath: string,
	version: { document: string; specText: string; cause: string; model: string },
): Promise<CompiledVersion> {
	const hash = sha(version.document);
	const path = keptAt(personaPath, hash);
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, version.document, "utf-8");
	}
	const spec = sha(version.specText);
	const entry = await writingToRecord(personaPath, statePath, {}, (record) =>
		record.append({ kind: "runtime", mechanism: "compiler", reason: version.cause }, { type: "compiled", hash, cause: version.cause, spec, model: version.model }),
	);
	return { at: entry.at, hash, cause: version.cause, spec, model: version.model, path };
}

/** The compiled versions the record holds, oldest first, each with the path of its kept text. */
export function compiledHistory(personaPath: string): CompiledVersion[] {
	return openRecord(personaPath)
		.all()
		.flatMap((entry) => {
			const body = entry.body;
			if (body.type !== "compiled") return [];
			const path = keptAt(personaPath, body.hash);
			return [
				{
					at: entry.at,
					hash: body.hash,
					...(body.cause === undefined ? {} : { cause: body.cause }),
					...(body.spec === undefined ? {} : { spec: body.spec }),
					...(body.model === undefined ? {} : { model: body.model }),
					...(existsSync(path) ? { path } : {}),
				},
			];
		});
}
