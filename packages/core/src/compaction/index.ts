/**
 * Compaction that respects the envelope.
 *
 * Most of the algorithm is the reference's and is taken whole. Two things are ours and
 * both come out of having a declared envelope: what is protected is read from the
 * layers rather than from a position, and protection says what survives rather than how
 * much, so a protected region that grows is an anomaly rather than a cupboard.
 *
 * And a compaction is an entry in the record, never an edit of it.
 */

export {
	plan,
	summaryAcceptable,
	type Anomaly,
	type CompactionPlan,
	type CompactionResult,
	type Envelope,
	type Pressure,
	type Unit,
} from "./service.js";

export {
	compactionAuthor,
	compactionEntry,
	driftAcross,
	type DriftDelta,
} from "./measured.js";
