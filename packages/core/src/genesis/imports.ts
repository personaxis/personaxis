/**
 * Genesis import adapters: the ecosystem's persona formats become source material (`--from-import`).
 *
 * Character cards (V2/V3, JSON or embedded in a PNG), SOUL.md / SoulSpec packages, and plain system
 * prompts (CLAUDE.md, AGENTS.md) are read whole and handed to the model as one source, with the card's
 * fields labelled. Until 2026-10-07 regular expressions mapped some of their fields straight into the
 * persona (a first heading became the name, a "boundaries" list became prohibited behaviors); now the model
 * reads the file like any other source and cites it, so nothing in a persona comes from a guess about a
 * file's layout.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ImportedMaterial {
	/** The whole file, readable, with any structured fields labelled. */
	text: string;
	format: "card-v2" | "card-v3" | "system-prompt" | "agents-md" | "soul-md";
}

interface CardData {
	name?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	first_mes?: string;
	mes_example?: string;
	creator_notes?: string;
	tags?: string[];
	system_prompt?: string;
}

// ── PNG tEXt extraction (no deps: walk chunks, find `chara`/`ccv3`) ──────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Extract the base64 card payload from a PNG's tEXt chunks. */
export function extractCardFromPng(buf: Buffer): { spec: "card-v2" | "card-v3"; json: unknown } | null {
	if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
	let off = 8;
	const found: Record<string, string> = {};
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("latin1", off + 4, off + 8);
		if (type === "tEXt") {
			const data = buf.subarray(off + 8, off + 8 + len);
			const nul = data.indexOf(0);
			if (nul > 0) {
				const keyword = data.toString("latin1", 0, nul);
				found[keyword] = data.toString("latin1", nul + 1);
			}
		}
		off += 12 + len; // length + type + data + CRC
		if (type === "IEND") break;
	}
	for (const [keyword, spec] of [["ccv3", "card-v3"], ["chara", "card-v2"]] as const) {
		if (found[keyword]) {
			try {
				return { spec, json: JSON.parse(Buffer.from(found[keyword], "base64").toString("utf-8")) };
			} catch {
				/* fall through to the other keyword */
			}
		}
	}
	return null;
}

const CARD_FIELDS: ReadonlyArray<[keyof CardData, string]> = [
	["name", "Name"],
	["description", "Description"],
	["personality", "Personality"],
	["scenario", "Scenario"],
	["first_mes", "First message"],
	["mes_example", "Example dialogue"],
	["system_prompt", "System prompt"],
	["creator_notes", "Creator notes"],
	["tags", "Tags"],
];

/** Parse a character card file: .json, or .png with an embedded chara/ccv3 chunk. */
export function importCharacterCard(path: string): ImportedMaterial {
	const buf = readFileSync(path);
	let payload: unknown;
	let format: "card-v2" | "card-v3" = "card-v2";
	if (path.toLowerCase().endsWith(".png")) {
		const extracted = extractCardFromPng(buf);
		if (!extracted) throw new Error(`${path}: no chara/ccv3 tEXt chunk found, not a character-card PNG.`);
		payload = extracted.json;
		format = extracted.spec;
	} else {
		payload = JSON.parse(buf.toString("utf-8"));
	}
	const o = payload as { spec?: string; data?: CardData } & CardData;
	if (o.spec === "chara_card_v3") format = "card-v3";
	else if (o.spec === "chara_card_v2") format = "card-v2";
	const data = o.data ?? o; // V2/V3 nest under data; V1 is flat
	const text = CARD_FIELDS.map(([key, label]) => {
		const value = data[key];
		const shown = Array.isArray(value) ? value.join(", ") : value;
		return typeof shown === "string" && shown.trim() ? `${label}:\n${shown.trim()}` : "";
	})
		.filter(Boolean)
		.join("\n\n");
	return { text, format };
}

/**
 * SOUL.md / SoulSpec: the SOUL.md, plus `IDENTITY.md` and `soul.json` when they sit beside it, each under
 * its own file name.
 */
export function importSoulMd(path: string): ImportedMaterial {
	const dir = dirname(path);
	const parts = [`SOUL.md:\n${readFileSync(path, "utf-8").trim()}`];
	for (const sibling of ["IDENTITY.md", "soul.json"]) {
		const p = join(dir, sibling);
		if (existsSync(p)) parts.push(`${sibling}:\n${readFileSync(p, "utf-8").trim()}`);
	}
	return { text: parts.join("\n\n"), format: "soul-md" };
}

/** True when a path names a SOUL.md file (or a SoulSpec package directory). */
export function isSoulImport(path: string): boolean {
	return /(^|[\\/])SOUL\.md$/i.test(path) || existsSync(join(path, "SOUL.md"));
}

/** A system prompt, CLAUDE.md or AGENTS.md, as written. */
export function importPrompt(path: string): ImportedMaterial {
	return { text: readFileSync(path, "utf-8"), format: /CLAUDE\.md$|AGENTS\.md$/i.test(path) ? "agents-md" : "system-prompt" };
}
