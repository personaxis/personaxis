/**
 * Authoring a persona with a model, one stage at a time, every field with its provenance.
 *
 * Replaces the one-call extraction plus builder defaults that Genesis used until 2026-10-07, which asked the
 * model for about fifteen kinds of field and filled the rest (23 in Clio) with fixed values. Now each stage
 * of `STAGES` is one call that sees the sources, what earlier stages decided, the stage's own schema and the
 * guidance for it, and answers with its reasoning first (format before reasoning cuts reasoning: Let Me
 * Speak Freely, EMNLP 2024), then the block, then where each field came from. The code decides nothing about
 * the persona: it checks the answer (schema, provenance on every field, quotes that are really in their
 * source, numbers that can move something), asks once more with the exact problems, and stops visibly if the
 * second answer still fails.
 */

import { dump } from "js-yaml";
import { validate as validateSchema, validatePersona, personaSchema } from "@personaxis/spec";

import { bandBoundaries } from "../math/bands.js";
import { ModelRequiredError } from "../model-config.js";
import { isGenesisProfile, profileGuidance } from "./profiles.js";
import { closestSentence, quoteIsIn, renderSources, type Source } from "./sources.js";
import { STAGES, type Stage } from "./stages.js";
import type { StructuredCaller } from "./types.js";

/** Where one field came from: a quote from a source, or an inference and its reason. */
export interface FieldProvenance {
	path: string;
	source?: string;
	quote?: string;
	inferred?: string;
}

export interface StageRecord {
	stage: string;
	reasoning: string;
	provenance: FieldProvenance[];
	/** How many answers the stage took: 1 when the first passed its checks. */
	attempts: number;
}

export interface AuthoredPersona {
	/** The frontmatter, valid against the spec. */
	spec: Record<string, unknown>;
	stages: StageRecord[];
}

export interface AuthorInput {
	sources: readonly Source[];
	/** The model. None means no persona: there is no fallback (2026-10-07). */
	call: StructuredCaller | null;
	/** The starting profile, as guidance: regulated, standard or research. */
	profile?: string;
	/** ISO date, for metadata.created; injected so prompts are deterministic within a day. */
	today?: string;
	/** The file name the person chose (`personaxis create <slug>`): the persona's canonical_id. */
	canonicalId?: string;
}

/** A stage whose answer still failed its checks after the repair. */
export class GenesisStageError extends Error {
	constructor(
		public readonly stage: string,
		public readonly issues: readonly string[],
	) {
		super(`Genesis could not author ${stage}: ${issues.slice(0, 6).join("; ")}${issues.length > 6 ? ` (+${issues.length - 6} more)` : ""}`);
		this.name = "GenesisStageError";
	}
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The schema with every `$ref` to `$defs` inlined, so a stage's slice stands on its own. */
function inline(node: unknown, defs: Json): unknown {
	if (Array.isArray(node)) return node.map((n) => inline(n, defs));
	if (!isObj(node)) return node;
	const ref = node.$ref;
	if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
		const { $ref: _ref, ...rest } = node;
		return { ...(inline(defs[ref.slice("#/$defs/".length)], defs) as Json), ...(inline(rest, defs) as Json) };
	}
	return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inline(v, defs)]));
}

/** The part of the persona schema a stage decides, as one object schema. */
export function stageSchema(stage: Stage, schema: Json = personaSchema): Json {
	const defs = (schema.$defs ?? {}) as Json;
	const props = (schema.properties ?? {}) as Json;
	return {
		type: "object",
		additionalProperties: false,
		required: [...stage.keys],
		properties: Object.fromEntries(stage.keys.map((k) => [k, inline(props[k], defs)])),
	};
}

/** What the model answers with: its reasoning first, then the block, then where each field came from. */
export function responseSchema(stage: Stage, schema: Json = personaSchema): Json {
	return {
		type: "object",
		additionalProperties: false,
		required: ["reasoning", "layer", "provenance"],
		properties: {
			reasoning: { type: "string" },
			layer: stageSchema(stage, schema),
			provenance: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["path"],
					properties: {
						path: { type: "string" },
						source: { type: "string" },
						quote: { type: "string" },
						inferred: { type: "string" },
					},
				},
			},
		},
	};
}

/** File bookkeeping the runtime sets; the model writes metadata.description and tags only. */
function bookkeeping(decided: Json, today: string, canonicalId?: string): Json {
	const identity = isObj(decided.identity) ? { ...decided.identity, ...(canonicalId ? { canonical_id: canonicalId } : {}) } : {};
	const metadata = isObj(decided.metadata) ? decided.metadata : {};
	return {
		apiVersion: "personaxis.com/v1",
		kind: "AgentPersona",
		spec_version: "1.1.0",
		...decided,
		...(isObj(decided.identity) ? { identity } : {}),
		metadata: { ...metadata, name: identity.canonical_id ?? metadata.name, version: "1.0.0", created: today },
	};
}

/** The prompt for one stage. Deterministic for the same inputs, which the `agent` provider relies on. */
export function stagePrompt(stage: Stage, sources: readonly Source[], decided: Json, profile: string, schema: Json = personaSchema): string {
	const before = Object.keys(decided).length ? dump(decided, { lineWidth: 120, noRefs: true }) : "(nothing yet: this is the first stage)";
	return [
		`You are authoring one part of an AI persona: ${stage.title} (keys: ${stage.keys.join(", ")}).`,
		"A persona is the complete way a professional works: procedures, criteria, tools, knowledge with",
		"sources, what it learned, and limits. You write this part from the SOURCES below and nothing else.",
		"",
		"Rules:",
		"- Every field comes from the sources. When a source states it, cite it: `source` is its id and `quote`",
		"  the exact words. When no source states it, infer it from what the sources do say about this job, and",
		"  write in `inferred` what you inferred it from and why. Never fill a field with a generic value.",
		"- `inferred` names what in the sources or in this job the value follows from, never the format rule it",
		"  satisfies ('the range crosses a band' is not a reason; 'reviews must not soften findings' is).",
		"- Do not soften or brighten what the sources say: a terse or blunt professional stays terse or blunt. Personas",
		"  written by a model drift towards an upbeat, agreeable default (Li et al., NeurIPS 2025); resist it.",
		"- Give provenance for every field you write: a `path` (dot notation, e.g. personality.traits.rigor.mean)",
		"  per field, or one per group whose fields share the same origin (e.g. personality.traits.rigor).",
		"- Write `reasoning` first: what the sources say for this part and what you decide from them.",
		`- Starting profile: ${profileGuidance(isGenesisProfile(profile) ? profile : "standard")}`,
		"",
		"Guidance for this part:",
		stage.guidance,
		"",
		"What earlier stages decided (stay consistent with it):",
		before.trim(),
		"",
		"The JSON Schema of this part (every description says what the field means):",
		JSON.stringify(stageSchema(stage, schema)),
		"",
		"SOURCES:",
		renderSources(sources),
		"",
		"Answer with one JSON object: { \"reasoning\": string, \"layer\": { the keys of this part }, \"provenance\": [ { path, source?, quote?, inferred? } ] }.",
	].join("\n");
}

/** Every leaf path of a block; an array is one leaf. */
function leaves(value: unknown, prefix: string): string[] {
	if (!isObj(value)) return [prefix];
	const out: string[] = [];
	for (const [k, v] of Object.entries(value)) out.push(...leaves(v, prefix ? `${prefix}.${k}` : k));
	return out.length ? out : [prefix];
}

/** Every envelope (an object with a numeric mean and a [min, max] range) in a block, with its path. */
function envelopes(value: unknown, prefix: string, out: Array<{ path: string; e: Json }> = []): Array<{ path: string; e: Json }> {
	if (!isObj(value)) return out;
	if (typeof value.mean === "number" && Array.isArray(value.range) && value.range.length === 2) out.push({ path: prefix, e: value });
	for (const [k, v] of Object.entries(value)) envelopes(v, `${prefix}.${k}`, out);
	return out;
}

/** A sentence about the persona rather than to it: a third-person pronoun, or its own name, as the subject. */
function writtenAbout(text: string, name: string | undefined): boolean {
	const t = text.trim();
	if (/^(he|she|they|his|her|hers|their|its)\b/i.test(t)) return true;
	const n = name?.trim();
	return !!n && t.toLowerCase().startsWith(`${n.toLowerCase()} `);
}

/** Whether the range reaches two bands with the boundaries it declares (or the spec's defaults). */
function crossesWithItsBands(e: { mean: number; min: number; max: number; bands?: { low_max?: number; moderate_max?: number } }): boolean {
	const [b1, b2] = bandBoundaries(e);
	const reached = (e.min <= b1 ? 1 : 0) + (e.max > b1 && e.min <= b2 ? 1 : 0) + (e.max > b2 ? 1 : 0);
	return reached >= 2;
}

/** What is wrong with a stage's answer, in words the model can act on. Empty when it passes. */
export function checkStage(stage: Stage, answer: unknown, sources: readonly Source[], decided: Json, today: string): string[] {
	const issues: string[] = [];
	if (!isObj(answer)) return ["The answer is not a JSON object with reasoning, layer and provenance."];
	if (typeof answer.reasoning !== "string" || !answer.reasoning.trim()) issues.push("`reasoning` is missing or empty.");
	const layer = answer.layer;
	if (!isObj(layer)) return [...issues, "`layer` is missing or not an object."];

	const keys = Object.keys(layer);
	for (const k of stage.keys) if (!keys.includes(k)) issues.push(`\`layer.${k}\` is missing; this stage decides it.`);
	for (const k of keys) if (!stage.keys.includes(k)) issues.push(`\`layer.${k}\` belongs to another stage; leave it out.`);

	// The schema, on the document as it would be with this stage merged in.
	const draft = bookkeeping({ ...decided, ...layer }, today);
	if (!validateSchema(draft)) {
		for (const e of validateSchema.errors ?? []) {
			const at = e.instancePath.replace(/^\//, "").replace(/\//g, ".");
			if (stage.keys.some((k) => at === k || at.startsWith(`${k}.`))) {
				const p = (e.params ?? {}) as Record<string, unknown>;
				const detail =
					"additionalProperty" in p
						? ` (remove \`${String(p.additionalProperty)}\`)`
						: "allowedValues" in p
							? ` (${JSON.stringify(p.allowedValues)})`
							: "missingProperty" in p
								? ` (add \`${String(p.missingProperty)}\`)`
								: "";
				issues.push(`${at || "(root)"}: ${e.message}${detail}`);
			}
		}
	}

	// What earlier runs taught. A name that repeats the prompt's framing is the prompt leaking (2026-09-11:
	// "Personaxis Genesis Seed: Payments Service PR Reviewer"). A self-concept written about the persona does
	// not belong in a document that speaks to it (E176). A voice exemplar teaches what to say as well as how,
	// so an invented one teaches invented facts (2026-10-07: a command that does not exist).
	const id = isObj(layer.identity) ? layer.identity : undefined;
	if (id && typeof id.display_name === "string" && /personaxis|genesis|\bextractor\b|authoring/i.test(id.display_name)) {
		issues.push(`identity.display_name repeats the authoring prompt ("${id.display_name}"); use the persona's own name or a plain role name.`);
	}
	const selfConcept = id && isObj(id.narrative_identity) ? id.narrative_identity.self_concept : undefined;
	if (typeof selfConcept === "string" && writtenAbout(selfConcept, typeof id?.display_name === "string" ? id.display_name : undefined)) {
		issues.push(`identity.narrative_identity.self_concept is written about the persona ("${selfConcept.slice(0, 60)}"); write it in the second person ("You ...").`);
	}
	const exemplars = isObj(layer.persona) && Array.isArray(layer.persona.voice_exemplars) ? layer.persona.voice_exemplars.filter(isObj) : [];
	for (const ex of exemplars) {
		const line = typeof ex.persona === "string" ? ex.persona : "";
		if (line && !sources.some((s) => quoteIsIn(sources, s.id, line))) {
			issues.push(`The voice exemplar "${line.slice(0, 60)}" is not in any source. Quote how the persona speaks from a source, or leave voice_exemplars out.`);
		}
	}

	// The spec's universals and coherence rules, for this stage's fields, so they are fixed here and not at
	// the end: on the first real run (2026-10-07) an inverted uncertainty policy and a hard virtue backed by a
	// movable trait only surfaced on the whole document.
	if (issues.length === 0) {
		const result = validatePersona(draft);
		for (const issue of result.valid ? [] : result.errors) {
			if (ownedBy(issue.field, issue.message).includes(stage)) issues.push(`${issue.field}: ${issue.message} Fix: ${issue.fix}`);
		}
	}

	// Provenance: every field covered, by its own entry or by a group entry at least two levels deep.
	const provenance = Array.isArray(answer.provenance) ? (answer.provenance as unknown[]).filter(isObj) : [];
	if (!Array.isArray(answer.provenance)) issues.push("`provenance` is missing or not an array.");
	const paths = provenance.map((p) => String(p.path ?? "")).filter(Boolean);
	const covered = (leaf: string) =>
		paths.some((p) => p.split(".").length >= 2 && (leaf === p || leaf.startsWith(`${p}.`)));
	const uncovered = stage.keys.flatMap((k) => (k === "metadata" ? leaves(layer.metadata, "metadata").filter((l) => /description|tags/.test(l)) : leaves(layer[k], k))).filter((l) => !covered(l));
	if (uncovered.length) {
		const shown = uncovered.slice(0, 12);
		issues.push(
			`No provenance for: ${shown.join(", ")}${uncovered.length > 12 ? ` and ${uncovered.length - 12} more` : ""}. For each, add an entry such as {"path": "${shown[0]}", "source": "S1", "quote": "<exact words>"} or {"path": "${shown[0]}", "inferred": "<what it was inferred from>"}, or remove the field if no source supports it.`,
		);
	}

	// E65: a page read on the web may inform what the persona knows, never who it is or what it refuses.
	const fromTheWeb = new Set(sources.filter((s) => s.kind === "research").map((s) => s.id));
	for (const p of provenance) {
		const top = String(p.path ?? "").split(".")[0];
		if (fromTheWeb.has(String(p.source ?? "")) && ["identity", "character", "self_regulation"].includes(top)) {
			issues.push(`${String(p.path)} cites ${String(p.source)}, which is web research: web research may inform knowledge and procedures, not who the persona is or what it refuses.`);
		}
	}

	for (const p of provenance) {
		const hasQuote = typeof p.quote === "string" && p.quote.trim().length > 0;
		const hasInference = typeof p.inferred === "string" && p.inferred.trim().length > 0;
		if (!hasQuote && !hasInference) issues.push(`Provenance for ${String(p.path)} gives neither a quote nor what it was inferred from.`);
		if (hasQuote && !quoteIsIn(sources, String(p.source ?? ""), String(p.quote))) {
			const near = closestSentence(sources, String(p.source ?? ""), String(p.quote));
			issues.push(
				`The quote for ${String(p.path)} is not in source ${String(p.source ?? "(none)")}: "${String(p.quote).slice(0, 80)}". Quote the exact words, or mark it inferred.` +
					(near ? ` The closest words in that source are: "${near.slice(0, 160)}"` : ""),
			);
		}
	}

	// Numbers that move something: inside their range, and able to cross a band.
	for (const k of stage.keys) {
		for (const { path, e } of envelopes(layer[k], k)) {
			const [min, max] = e.range as [number, number];
			const mean = e.mean as number;
			// E127: whatever a run moves in personality or affect comes back by itself, so each declares how fast.
			if ((path.startsWith("personality.") || path.startsWith("affect.")) && typeof e.half_life !== "number") {
				issues.push(`${path}: declare \`half_life\`, the turns a displaced value takes to come halfway back, from how this professional recovers.`);
			}
			if (!(min <= mean && mean <= max)) issues.push(`${path}: mean ${mean} is outside its range [${min}, ${max}].`);
			else if (max > min && !crossesWithItsBands({ mean, min, max, bands: e.bands as { low_max?: number; moderate_max?: number } | undefined }))
				issues.push(
					path.includes(".drives.")
						? `${path}: the range [${min}, ${max}] stays inside one band, so the number changes nothing; a drive cannot declare \`bands\`, so widen its range across 0.33 or 0.66, or make it static with a \`level\`.`
						: `${path}: the range [${min}, ${max}] stays inside one band, so the number changes nothing; declare \`bands\` the range crosses.`,
				);
		}
	}
	return issues;
}

/**
 * The stages a finding concerns: the one owning its field, and every stage whose key the message names (a
 * hard virtue's coherence is fixed in character or in personality), in authoring order.
 */
function ownedBy(field: string, message: string): Stage[] {
	const top = field.replace(/^\//, "").split(/[./]/)[0];
	return STAGES.filter((s) => s.keys.includes(top) || s.keys.some((k) => new RegExp(`\\b${k}\\.`).test(message)));
}

/** Map validator findings on the whole document back to the stages that own them, in authoring order. */
function findingsByStage(spec: Json): Map<Stage, string[]> {
	const result = validatePersona(spec);
	const out = new Map<Stage, string[]>();
	for (const issue of result.valid ? [] : result.errors) {
		for (const stage of ownedBy(issue.field, issue.message)) out.set(stage, [...(out.get(stage) ?? []), `${issue.field}: ${issue.message} Fix: ${issue.fix}`]);
	}
	return new Map(STAGES.filter((s) => out.has(s)).map((s) => [s, out.get(s)!]));
}

/**
 * How many times a stage is asked again with its exact problems before Genesis stops. Two, measured on
 * 2026-10-07 with command-a-03-2025: with one, a mid-size model that slips once in a stage (a free-text
 * field it added without provenance) failed whole runs of eleven stages.
 */
const REPAIRS = 2;

/**
 * Author a persona from its sources. Throws `ModelRequiredError` without a model and `GenesisStageError`
 * when a stage still fails after `REPAIRS` repairs; never returns a persona with a field nobody decided.
 */
export async function authorPersona(input: AuthorInput): Promise<AuthoredPersona> {
	const { sources, call } = input;
	if (!call) throw new ModelRequiredError("Creating a persona");
	const profile = input.profile ?? "standard";
	const today = input.today ?? new Date().toISOString().slice(0, 10);
	const decided: Json = {};
	const records: StageRecord[] = [];

	const runStage = async (stage: Stage, extra: string[] = []): Promise<void> => {
		const prompt = stagePrompt(stage, sources, decided, profile);
		const schema = responseSchema(stage);
		const first = await call(extra.length ? `${prompt}\n\nThe whole document failed these checks; fix them in this part:\n- ${extra.join("\n- ")}` : prompt, schema, `persona_${stage.id}`);
		let answer = first;
		let issues = checkStage(stage, answer, sources, decided, today);
		let attempts = 1;
		while (issues.length) {
			if (attempts > REPAIRS) throw new GenesisStageError(stage.id, issues);
			attempts += 1;
			const repair = `${prompt}\n\nYour previous answer was:\n${JSON.stringify(answer)}\n\nIt failed these checks. Answer again with all of them fixed:\n- ${issues.join("\n- ")}`;
			answer = await call(repair, schema, `persona_${stage.id}`);
			issues = checkStage(stage, answer, sources, decided, today);
		}
		const a = answer as { reasoning: string; layer: Json; provenance: FieldProvenance[] };
		Object.assign(decided, a.layer);
		const rest = records.filter((r) => r.stage !== stage.id);
		records.length = 0;
		records.push(...rest, { stage: stage.id, reasoning: a.reasoning, provenance: a.provenance, attempts });
	};

	for (const stage of STAGES) await runStage(stage);

	// The whole document, against the full validator (universals included); the owning stages fix their part once.
	let spec = bookkeeping(decided, today, input.canonicalId);
	const findings = findingsByStage(spec);
	if (findings.size) {
		for (const [stage, issues] of findings) await runStage(stage, issues);
		spec = bookkeeping(decided, today, input.canonicalId);
		const left = findingsByStage(spec);
		if (left.size) throw new GenesisStageError([...left.keys()].map((s) => s.id).join(", "), [...left.values()].flat());
	}
	return { spec, stages: STAGES.map((s) => records.find((r) => r.stage === s.id)!).filter(Boolean) };
}
