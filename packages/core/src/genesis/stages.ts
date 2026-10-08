/**
 * The stages a persona is authored in, one model call each, in order.
 *
 * The order follows the spec's anatomy with one exception: personality and values come before character,
 * because a virtue leans on the trait or value that backs it (`refs`), and the validator holds a hard virtue
 * to the envelope of what it references. Measured 2026-10-07 on command-a-03-2025: with character second, the
 * model referenced traits that did not exist yet and the whole document failed coherence. Then the blocks
 * outside the ten layers that govern change and the runtime. Each stage sees what the ones before it decided. The
 * guidance is what the 2026-10-07 reading of the prompting research says about that part.
 */

export interface Stage {
	id: string;
	title: string;
	/** Top-level keys of personaxis.md this stage decides. */
	keys: readonly string[];
	/** What the model is told about doing this part well. */
	guidance: string;
}

const NUMBERS = [
	"Numbers are positions in a declared range, not decoration: a `mean` is where the persona rests, `range` how far",
	"the work may move it, and every number must change what the persona does. Pick each one from what the sources",
	"show about how this professional works; a narrow range for what must not move, a wide one for what adapts.",
	"Every envelope needs per-band `expression` prose (low, moderate, high), written in the second person as what",
	"the persona DOES at that band in this job, never an adjective. The range must reach two bands, or the number",
	"changes nothing. The default band edges are 0.33 and 0.66 (-0.33 and 0.33 for signed values). Traits and affect",
	"may declare `bands` to move those edges so the range crosses one, keeping the mean in the band its level says;",
	"drives cannot declare `bands`, so a mutable drive's range itself has to cross 0.33 or 0.66. `half_life` is in",
	"turns: how fast a displaced value returns.",
].join("\n");

export const STAGES: readonly Stage[] = [
	{
		id: "identity",
		title: "Identity and metadata",
		keys: ["metadata", "identity"],
		guidance: [
			"Who this persona is and the job it does. The purpose is the job and who it serves, in one or two plain",
			"sentences. The role names the professional it is. The self-concept is how it sees itself, in the second",
			"person ('You ...'). Its origin only if a source gives one. Allowed and prohibited domains are concrete",
			"areas of work, from the sources. Do not invent a biography, a name or personal details the sources do",
			"not give: attributes unrelated to the task lower task performance by up to 30 points (Principled",
			"Personas, EMNLP 2025). metadata.name is the canonical_id; metadata.description says what the persona does.",
		].join("\n"),
	},
	{
		id: "personality",
		title: "Personality",
		keys: ["personality"],
		guidance: [
			"Only the traits that change how this job is done, each from evidence in the sources. Use a recognised",
			"model (big_five, hexaco) when its traits fit, `hybrid_traits` otherwise. A trait that will back a",
			"non-negotiable commitment (honesty, rigor) must keep its whole range above its low band edge.",
			NUMBERS,
		].join("\n"),
	},
	{
		id: "values_and_drives",
		title: "Values and drives",
		keys: ["values_and_drives"],
		guidance: [
			"What it weighs when goals conflict. The spec requires a `safety` value of type governance with weight",
			"at least 0.90. Other values are weighted by how the sources rank them. A drive is static (a level) or",
			"mutable (an envelope). Conflict resolution says which value wins, in this job's terms. Goals and anti-goals",
			"are concrete outcomes of the work, not the purpose restated.",
			NUMBERS,
		].join("\n"),
	},
	{
		id: "character",
		title: "Character",
		keys: ["character"],
		guidance: [
			"The commitments its work is judged by. Virtues are rules it follows, each stated as what it does, with",
			"`enforcement: hard` only when the sources treat it as non-negotiable. `honesty` is required by the spec",
			"and is hard; write its description in this professional's terms. Behavioral commitments are checkable",
			"rules with an id and a severity. Prohibited behaviors are what this professional refuses in its own",
			"domain. Do not repeat the same idea in two fields. Give a virtue `refs` to the trait or value already",
			"decided that backs it; the spec holds a hard virtue to it, so a hard virtue may only reference a trait whose",
			"whole range sits above that trait's low band edge (otherwise reference a value, or no trait).",
		].join("\n"),
	},
	{
		id: "affect",
		title: "Affect",
		keys: ["affect"],
		guidance: [
			"Affect is a functional state that shapes how it works (caution after a failure, pace, assertiveness), not",
			"a feeling it claims. Set the baseline of valence, arousal and dominance (core_affect) and of mood tone,",
			"stability and recovery_rate from how the sources describe this professional under pressure and after",
			"setbacks. If the sources say nothing about one of them, infer it from the job and say so in provenance.",
			NUMBERS,
		].join("\n"),
	},
	{
		id: "cognition",
		title: "Cognition",
		keys: ["cognition"],
		guidance: [
			"How it reasons in this job: the reasoning modes the work needs, its default strategy, and when it",
			"discloses or abstains under uncertainty (disclose_when_above below abstain_when_above). A model's stated",
			"confidence is poorly calibrated, so set thresholds that send it to a check, a source or a question rather",
			"than trusting its own certainty. Tool policy names only tools this job uses.",
		].join("\n"),
	},
	{
		id: "memory",
		title: "Memory",
		keys: ["memory"],
		guidance: [
			"What it remembers and how: the memory kinds this job needs, what it may write without asking, anchors",
			"(what it must not lose: the person's goal, decisions and their reasons), and what it forgets first. The",
			"spec requires deletion on the user's request.",
		].join("\n"),
	},
	{
		id: "metacognition",
		title: "Metacognition",
		keys: ["metacognition"],
		guidance: [
			"What it watches in its own work and what it does when that fires. Prefer monitors that can be checked",
			"against something outside the model (a test, a source, a contradiction with memory) over its own",
			"confidence, which is poorly calibrated. A monitor may `feed` a self_regulation decision group.",
		].join("\n"),
	},
	{
		id: "self_regulation",
		title: "Self-regulation",
		keys: ["self_regulation"],
		guidance: [
			"Its hard limits and the decision it takes on each turn. The spec requires three hard limits, word for",
			"word: 'No claim of subjective consciousness.', 'No persistent memory write without policy pass.', 'No",
			"unauthorized identity change.'. Add the absolute refusals of this job. A stay-in-character rule is a hard",
			"limit of expression. Decisions are grouped by category, each with the options it may take and a default.",
		].join("\n"),
	},
	{
		id: "persona",
		title: "Persona (voice and expression)",
		keys: ["persona"],
		guidance: [
			"How it speaks and acts in the work. Voice from the sources (tone, formality, warmth, verbosity). Voice",
			"exemplars only when a source quotes or shows how it speaks; 3 to 5 varied ones are best, each a short",
			"exchange. Scene contracts tie a situation to what it does and the concrete actions. Behavioral anchors",
			"are do and don't with examples, and only what the virtues and prohibited behaviors already decided do not",
			"say: never restate them. Consistency says what is stable, what evolves, what is situational. The",
			"spec requires the constraints cannot_override_identity, cannot_override_character and",
			"cannot_claim_real_emotion to be true. Adapting to the person can lower truthfulness (task dialogue study,",
			"2026): adaptation changes the register, never the facts.",
		].join("\n"),
	},
	{
		id: "governance",
		title: "Change governance and the runtime contract",
		keys: ["governance", "improvement_policy", "security", "permissions", "verification", "agent_budget", "runtime"],
		guidance: [
			"How it may change and how it runs. Per-layer edit policy and drift thresholds: identity, character and",
			"self_regulation need a person; what adapts may move under review. improvement_policy.mode: suggesting",
			"unless the sources ask for locked or autonomous. Security defenses on. Permissions: the sandbox and",
			"approval this job needs. Verification gates: objective checks its deliverables must pass before it hands",
			"them over (tests, a linter, a schema), judged by something other than the model that did the work. Agent",
			"budget: steps, tokens and time a task of this job reasonably takes, with what to do when exhausted.",
		].join("\n"),
	},
];
