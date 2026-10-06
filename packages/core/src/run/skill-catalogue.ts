/**
 * Which skills exist, where they came from, and who is allowed to change them.
 *
 * A catalogue rather than a loader, because the loading already has an owner and the
 * question this answers is a different one: given everything on disk and everything a
 * workspace pushed, **what is offered right now and why is the rest not**.
 *
 * Three things the study found, each of which the previous shape could not express.
 *
 * ## Precedence is the product, and it needs a boundary
 *
 * A skill vendored inside a repository should win inside that repository. That is the
 * whole reason a project tier exists, and it is also a supply-chain path: cd into a
 * repository and its skills are suddenly in front of the model. The reference gates it
 * on the project root being trusted, scans each one, and quarantines a dangerous
 * verdict **fail-closed**, so a missing or broken scanner means the skill does not load
 * rather than that it loads unscanned.
 *
 * Ours already has the trust half, and it is stronger: the scope is the directories the
 * operator named at that keyboard, so a repository outside it does not exist. What we
 * did not have is the scan, and this is where its verdict is read.
 *
 * ## Relevance is not compatibility, and neither is permission
 *
 * They separate two axes: where a skill can run, and when it is worth showing. The
 * second only hides it from the index, and an explicit request loads it anyway, because
 * asking for something explicitly is consenting to it.
 *
 * We have a third, and it is ours: **should this persona have it at all**. A skill can
 * be runnable, relevant, and still outside what the persona declared itself to be.
 * Neither reference can ask that.
 *
 * ## Provenance decides who may rewrite a skill
 *
 * Their guard is the best postmortem in either repository. It keyed on whether a
 * telemetry record existed, and the successful write it authorised **created** that
 * record, so a local skill passed once and was refused from then on. Their own words:
 * allowed exactly once is not a policy, it is a race with your own bookkeeping.
 *
 * The correction generalises past skills: a missing record and a record that explicitly
 * names no owner must resolve **identically**, and both closed. Ours has an advantage
 * they do not, which is that provenance comes from the chained record rather than from
 * a file the write itself creates, so that class cannot occur here at all.
 */

/** Where a skill came from. Order is precedence, most specific first. */
export type Tier = "project" | "workspace" | "profile" | "bundled" | "external";

const PRECEDENCE: readonly Tier[] = ["project", "workspace", "profile", "bundled", "external"];

/** What the content scan concluded. Fail-closed: anything but a clean pass quarantines. */
export type ScanVerdict = "clean" | "caution" | "dangerous" | "unscanned";

/** Who created a skill, which is what decides who may rewrite it. */
export type Provenance =
	| { readonly by: "person"; readonly id: string }
	| { readonly by: "persona"; readonly id: string }
	| { readonly by: "vendor" }
	/** Genuinely unknown. Resolves exactly like an explicit absence of an owner. */
	| { readonly by: "unknown" };

export interface SkillEntry {
	readonly name: string;
	readonly tier: Tier;
	readonly scan: ScanVerdict;
	readonly provenance: Provenance;
	/** Platforms it can run on. Empty means anywhere. */
	readonly platforms?: readonly string[];
	/** Contexts it is worth offering in. Empty means always. */
	readonly environments?: readonly string[];
}

/** Why a skill is not being offered. Each case names itself; none is a bare false. */
export type Withheld =
	| { readonly why: "quarantined"; readonly verdict: ScanVerdict }
	| { readonly why: "wrong_platform"; readonly platform: string }
	| { readonly why: "not_relevant"; readonly environment: string }
	| { readonly why: "shadowed"; readonly by: Tier }
	| { readonly why: "outside_envelope"; readonly reason: string };

export interface CatalogueView {
	/** What is offered, in precedence order. */
	readonly offered: readonly SkillEntry[];
	/** What is not, and why. The reason is the useful half. */
	readonly withheld: readonly { readonly name: string; readonly reason: Withheld }[];
}

export interface CatalogueContext {
	readonly platform: string;
	readonly environments: readonly string[];
	/**
	 * Whether this persona may have a skill at all, and why not when it may not.
	 *
	 * The third axis, and the one nobody else has. Absent means the question is not
	 * being asked, which is not the same as every skill being fine.
	 */
	readonly withinEnvelope?: (skill: SkillEntry) => { ok: true } | { ok: false; reason: string };
}

/** Whether a scan verdict lets a skill load. Anything but clean or caution does not. */
function loadable(scan: ScanVerdict): boolean {
	// `caution` loads, matching what they do for prose-level keyword hits, because a
	// quarantine that fires on every mention of a dangerous word quarantines everything.
	// `unscanned` does not, which is the fail-closed half: content from a repository
	// with no completed scan is not content anybody vouched for.
	return scan === "clean" || scan === "caution";
}

/**
 * Works out what is on offer.
 *
 * First-wins over the precedence order, so a project skill shadows a bundled one of the
 * same name, and the shadowed one is reported as shadowed rather than dropped: a name
 * silently resolving somewhere else is exactly the surprise a precedence rule exists to
 * make explicit.
 */
export function catalogue(entries: readonly SkillEntry[], context: CatalogueContext): CatalogueView {
	const ordered = [...entries].sort(
		(left, right) => PRECEDENCE.indexOf(left.tier) - PRECEDENCE.indexOf(right.tier),
	);

	const offered: SkillEntry[] = [];
	const withheld: { name: string; reason: Withheld }[] = [];
	const taken = new Map<string, Tier>();

	for (const entry of ordered) {
		const shadowedBy = taken.get(entry.name);
		if (shadowedBy !== undefined) {
			withheld.push({ name: entry.name, reason: { why: "shadowed", by: shadowedBy } });
			continue;
		}

		if (!loadable(entry.scan)) {
			withheld.push({ name: entry.name, reason: { why: "quarantined", verdict: entry.scan } });
			taken.set(entry.name, entry.tier);
			continue;
		}

		if (entry.platforms?.length && !entry.platforms.includes(context.platform)) {
			withheld.push({
				name: entry.name,
				reason: { why: "wrong_platform", platform: context.platform },
			});
			taken.set(entry.name, entry.tier);
			continue;
		}

		const envelope = context.withinEnvelope?.(entry);
		if (envelope && !envelope.ok) {
			withheld.push({
				name: entry.name,
				reason: { why: "outside_envelope", reason: envelope.reason },
			});
			taken.set(entry.name, entry.tier);
			continue;
		}

		if (
			entry.environments?.length &&
			!entry.environments.some((environment) => context.environments.includes(environment))
		) {
			withheld.push({
				name: entry.name,
				reason: { why: "not_relevant", environment: context.environments.join(", ") },
			});
			taken.set(entry.name, entry.tier);
			continue;
		}

		offered.push(entry);
		taken.set(entry.name, entry.tier);
	}

	return { offered, withheld };
}

/**
 * Whether a skill withheld from the index may still be loaded on request.
 *
 * Relevance is a filter on noise, so asking for something explicitly is consenting to
 * it and it loads. Everything else is a real limit and stays one: a quarantined skill,
 * one for another platform, or one outside what the persona declared, does not become
 * available because somebody typed its name.
 */
export function loadableOnRequest(reason: Withheld): boolean {
	return reason.why === "not_relevant" || reason.why === "shadowed";
}

/**
 * Whether an autonomous process may rewrite a skill.
 *
 * Only what the persona itself created. A missing owner and an explicitly unknown one
 * resolve identically and both refuse, which is the generalised form of the bug that
 * let a write through exactly once.
 */
export function mayRewrite(entry: SkillEntry, persona: string): boolean {
	return entry.provenance.by === "persona" && entry.provenance.id === persona;
}
