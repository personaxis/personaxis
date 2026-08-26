/**
 * The record.
 *
 * Everything the persona is at any moment is a fold over these entries. A fact that
 * is not here did not happen, and a fact that is here cannot be unhappened, because
 * each entry commits to the one before it.
 *
 * Runs beside `state-engine.ts`, which still holds the stored copy. The old copy is
 * not retired until deriving has been proved equal to it on real personas, which is
 * what `bridge.ts` is for.
 *
 * ## What to read first
 *
 * `entry.ts` for the vocabulary and the author invariant, which is the rule the study
 * found four times in two codebases. `chain.ts` for why the sequence number and the
 * author are inside the hash. `derive.ts` for why folding is the only way to read
 * state. `journal.ts` for synchronous writes with persistence behind them, and for
 * what happens to a turn that never closed.
 */

export {
	GENESIS,
	authorId,
	isGenesis,
	type Author,
	type DraftEntry,
	type Provenance,
	type ProviderArtifact,
	type RecordBody,
	type RecordEntry,
} from "./entry.js";

export { chain, digestInput, head, verify, type ChainProblem, type ChainVerdict } from "./chain.js";

export { derive, emptyState, type DeriveResult, type DerivedState } from "./derive.js";

export {
	Journal,
	type DrainReport,
	type JournalOptions,
	type RecordSink,
} from "./journal.js";

export {
	compareToStored,
	recordLifecycle,
	replayStateFile,
	type EquivalenceReport,
} from "./bridge.js";
export * from "./project.js";

export {
	RecordDamaged,
	fileSink,
	openRecord,
	readRecord,
	recordPathFor,
} from "./store.js";

export {
	currentValue,
	decide,
	mutate,
	origin,
	type Decision,
	type MoveRequest,
} from "./mutate.js";

export {
	adjust,
	adjustAll,
	adopt,
	type AdjustAllResult,
	type AdjustResult,
	type Move,
} from "./adjust.js";

export {
	MECHANISM,
	UNRECOGNISED,
	actorFor,
	authorOf,
	describeAuthor,
	isWritableAuthor,
	requireActor,
	type Actor,
} from "./actor.js";
