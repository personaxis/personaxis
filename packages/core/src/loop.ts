/**
 * The Living Loop — what makes a persona "alive", governed end to end.
 *
 *   observe -> appraise -> evolve (clamped to envelopes) -> recompile -> memory
 *
 * Every mutation is clamped + audited; every memory write is dry-run verified +
 * lineage-chained; the governance gate decides admissibility; the universal
 * invariants are never touched. The model proposes signals; the spec engine
 * imposes safety. Nothing is a black box — each step emits an auditable event.
 */

import { extractEnvelopes } from "./envelopes.js";
import { bandCrossing, bandOf, expressionFor } from "./math/bands.js";
import { driftReport, readDriftThresholds } from "./math/drift.js";
import { applyHomeostasis, decayingFields } from "./math/homeostasis.js";
import {
  governMutations,
  readMode,
  readMaxStepDelta,
  type GovernanceConfig,
  DEFAULT_GOVERNANCE,
} from "./governance.js";
import { applyMutation } from "./state-engine.js";
import {
  prepareMemoryEntry,
  readMemoryTypes,
} from "./memory.js";
import { recordEvaluation, scoreMemoryEntry, setPreference } from "./memory-kinds.js";
import { detectMemoryAnomalies } from "./provenance.js";
import { scanForInjection } from "./injection.js";
import { activeOverlay, applyOverlay, proposeSelfEdit, editGate, editableLayers, SelfEditError } from "./self-evolution.js";
import { buildEvolutionView } from "./evolution-view.js";
import { machineId } from "./registry.js";
import { randomUUID } from "node:crypto";
import { loadPersona, type PersonaHandle, type StateFile } from "./persona.js";
import { defaultFsStorage, type Storage } from "./ports/index.js";
import { EventBus } from "./events.js";
import type { Appraiser, AppraisalSignal, ProvenanceSource } from "./appraisal.js";

export interface LivingLoopOptions {
  appraiser: Appraiser;
  /** Override governance; otherwise read improvement_policy.mode from frontmatter. */
  governance?: Partial<GovernanceConfig>;
  /** Optional recompile hook (LLM-backed, lives in the CLI). Called on drift. */
  recompile?: (handle: PersonaHandle) => Promise<void>;
  /** F3.3 — storage adapters (state/lock/ledger/memory). Defaults to the fs bundle;
   *  the SaaS injects Postgres/S3 adapters over the SAME engine. */
  storage?: Storage;
}

export interface TickInput {
  observation: string;
  source: ProvenanceSource;
  /** Actor recorded in the mutation log. Defaults to actor-llm. */
  actor?: "actor-llm" | "runtime-context";
}

export interface TickReport {
  mutationsApplied: number;
  memoriesWritten: number;
  abstained: boolean;
}

export class LivingLoop {
  readonly bus = new EventBus();
  private handle: PersonaHandle;
  /** v0.8: stamped on every mutation for cross-OS reconciliation + traceability. */
  readonly sessionId = randomUUID();
  /** F3.3 — persistence seam; fs adapters by default. */
  private readonly storage: Storage;

  constructor(
    personaPath: string,
    private readonly opts: LivingLoopOptions,
  ) {
    this.handle = loadPersona(personaPath);
    this.storage = opts.storage ?? defaultFsStorage();
  }

  /** Reload the persona document (e.g. after a recompile). */
  reload(): void {
    this.handle = loadPersona(this.handle.personaPath);
  }

  get persona(): PersonaHandle {
    return this.handle;
  }

  private resolveGovernance(): GovernanceConfig {
    const fm = this.handle.frontmatter as Record<string, unknown>;
    const mode = readMode(fm, this.handle.personaPath);
    const maxStepDelta = readMaxStepDelta(fm);
    return { ...DEFAULT_GOVERNANCE, mode, maxStepDelta, ...this.opts.governance };
  }

  /** Run one full governed cycle. */
  async tick(input: TickInput): Promise<TickReport> {
    const bus = this.bus;
    try {
      // 1. observe
      bus.emit({ type: "observe", observation: input.observation, source: input.source });

      // 1a. injection scan — untrusted text must not steer evolution.
      const scan = scanForInjection(input.observation);
      const injectionBlocked = scan.verdict === "malicious";
      if (scan.verdict !== "clean") {
        bus.emit({
          type: "anomaly",
          kind: `injection:${scan.verdict}`,
          detail: scan.findings.map((f) => f.rule).join(", "),
        });
      }

      // Applied self-edits (governed, versioned) take effect here: the overlay is
      // merged onto the frontmatter before envelopes are read, so an approved edit
      // to e.g. a trait's range actually changes clamping. The spec file is untouched.
      const fm = applyOverlay(
        this.handle.frontmatter as Record<string, unknown>,
        activeOverlay(this.handle.personaPath),
      );
      const env = extractEnvelopes(fm);

      // 2. appraise (model proposes structured signals only). A failing/unreachable
      // appraiser (network, auth, unsupported response_format) must NOT end the
      // session: degrade to "no evolution this turn" — the persona still replied
      // and the spec invariants are untouched.
      // F3.8: build the grounded evolution view (current values + envelopes + mode)
      // so the appraiser proposes against reality, not blind against field names.
      const mode = readMode(fm, this.handle.personaPath);
      const editableSections = editableLayers(fm, mode);
      const currentValues = this.storage.state.exists(this.handle.statePath)
        ? this.storage.state.read(this.handle.statePath).values
        : {};
      const evolutionView = buildEvolutionView({ values: currentValues, envelopes: env.envelopes, editableSections, mode });

      let signal: AppraisalSignal;
      try {
        signal = await this.opts.appraiser.appraise({
          observation: input.observation,
          source: input.source,
          personaBody: this.handle.body,
          mutableFields: Object.keys(env.envelopes),
          editableSections,
          evolutionView,
        });
      } catch (err) {
        bus.emit({ type: "error", message: `appraiser unavailable: ${(err as Error).message}` });
        bus.emit({ type: "abstain", reason: "appraiser error" });
        return { mutationsApplied: 0, memoriesWritten: 0, abstained: true };
      }
      bus.emit({ type: "appraise", signal });

      // Uncertainty policy: abstain from evolving when confidence is too low.
      if (signal.confidence < 0.2) {
        bus.emit({ type: "abstain", reason: `low confidence (${signal.confidence.toFixed(2)})` });
        return { mutationsApplied: 0, memoriesWritten: 0, abstained: true };
      }

      // 3. evolve — govern, then clamp + audit
      const gov = this.resolveGovernance();
      const decision = governMutations(signal.mutations, env, gov);
      bus.emit({ type: "govern", verdicts: decision.verdicts });

      // A malicious injection blocks evolution this turn (content can still be
      // remembered, tagged, for audit) — defense in depth over the governance gate.
      const admitted = injectionBlocked ? [] : decision.admitted;
      let mutationsApplied = 0;
      // F6.2 (MATH_CORE.md Def. 6): a band crossing — not any mutation — is the
      // normative drift event. Within-band movement is expression variance.
      const bandCrossings: string[] = [];
      // FASE 7 P2: structured crossing details for the UI (from/to band + the
      // prose the NEW band injects), captured at mutation time.
      const crossingDetails: Array<{ field: string; fromBand: string; toBand: string; prose: string | null }> = [];
      const recordCrossing = (field: string, from: number, to: number): void => {
        const e = env.envelopes[field];
        if (!e || !bandCrossing(from, to, e)) return;
        bandCrossings.push(field);
        crossingDetails.push({ field, fromBand: bandOf(from, e), toBand: bandOf(to, e), prose: expressionFor(to, e) });
      };
      let postValues: Record<string, number> | null = null;
      // F6.3 (T6): coordinates with a declared half_life decay toward baseline
      // every tick — even one with no admitted proposals.
      const hasDecay = decayingFields(env.envelopes).length > 0;
      if (admitted.length > 0 || hasDecay) {
        // Serialize the read→apply→write against concurrent writers (serve, MCP,
        // another tick): re-read fresh state under the lock — the proposed deltas
        // are relative, so applying them to fresh values is correct — and never
        // hold the lock across a model call (the appraisal already happened).
        this.storage.lock.withLock(this.handle.statePath, () => {
          const fresh: StateFile = this.storage.state.read(this.handle.statePath);
          // Homeostatic step FIRST (the dynamics' decay term precedes the tick's
          // forcing; every decay is an audited runtime-decay mutation).
          for (const r of applyHomeostasis(fresh, env.envelopes, {
            sessionId: this.sessionId,
            originNode: machineId(),
          })) {
            bus.emit({ type: "mutate", result: r });
            if (r.to !== r.from) {
              mutationsApplied++;
              recordCrossing(r.entry.field, r.from, r.to);
            }
          }
          for (const m of admitted) {
            const result = applyMutation(fresh, env.envelopes, {
              field: m.field,
              delta: m.delta,
              reason: m.reason,
              actor: input.actor ?? "actor-llm",
              originNode: machineId(),
              sessionId: this.sessionId,
            });
            bus.emit({ type: "mutate", result });
            if (result.to !== result.from) {
              mutationsApplied++;
              recordCrossing(m.field, result.from, result.to);
            }
          }
          this.storage.state.write(this.handle.statePath, fresh);
          postValues = { ...fresh.values };
        });
      }

      // Drift metric after this tick's mutations: report D, crossings, and any layer
      // over its declared governance.drift_thresholds (which now actually computes).
      if (mutationsApplied > 0 && postValues) {
        const report = driftReport({
          values: postValues,
          envelopes: env.envelopes,
          maxStepDelta: gov.maxStepDelta,
          thresholds: readDriftThresholds(fm),
          protectedFields: env.protectedFields,
        });
        const layersExceeded = report.layers.filter((l) => l.exceeded).map((l) => l.layer);
        bus.emit({ type: "drift", global: report.global, crossings: bandCrossings, layersExceeded, report });
        for (const l of report.layers.filter((x) => x.exceeded)) {
          bus.emit({
            type: "anomaly",
            kind: "drift-threshold",
            detail: `${l.layer} drift ${l.drift.toFixed(2)} > threshold ${l.threshold}`,
          });
        }
      }

      // 3b. evolve QUALITATIVE — the appraiser may propose prose self-edits to
      // persona_prompting. Governed by improvement_policy.mode via governQualitative:
      // locked → none; suggesting → queued for /review; autonomous → auto-applied (still
      // gated by consensus verifiers + protected paths + the self_edit provenance gate,
      // which requires a `user`-trust justification). A malicious injection blocks ALL
      // self-edits this turn. Self-edits do NOT count as envelope mutations — keeping the
      // `mutationsApplied` metric (and the injection eval) about numbers only.
      const selfEdits = signal.selfEdits ?? [];
      if (!injectionBlocked && selfEdits.length > 0 && signal.confidence >= 0.6) {
        for (const se of selfEdits) {
          // ANY spec section may be proposed; editGate composes the safety floor + the
          // author's declared per-layer policy + the global mode into block | queue | auto.
          const action = editGate(se.targetPath, fm, gov.mode);
          if (action === "block") {
            bus.emit({ type: "self-edit", op: "rejected", targetPath: se.targetPath, reason: "section is protected or locked by policy" });
            continue;
          }
          // Map the gate to the effective mode proposeSelfEdit understands: a layer the author
          // marked review-required QUEUES even when the global mode is autonomous.
          const effectiveMode = action === "auto" ? "autonomous" : "suggesting";
          try {
            const r = proposeSelfEdit(
              this.handle.personaPath,
              { targetPath: se.targetPath, toValue: se.toValue, rationale: se.rationale, sources: [input.source] },
              effectiveMode,
              input.actor ?? "actor-llm",
            );
            bus.emit({ type: "self-edit", op: r.status === "applied" ? "applied" : "queued", targetPath: se.targetPath, id: r.id });
          } catch (e) {
            const reason = e instanceof SelfEditError ? e.message : (e as Error).message;
            bus.emit({ type: "self-edit", op: "rejected", targetPath: se.targetPath, reason });
          }
        }
      }

      // 3c. user preferences — written only when declared (memory.types.user_preferences)
      // and never under a malicious injection.
      const memTypesForPrefs = readMemoryTypes(fm);
      const prefs = signal.preferences ?? [];
      if (!injectionBlocked && memTypesForPrefs.user_preferences && prefs.length > 0) {
        for (const pref of prefs) setPreference(this.handle.personaPath, pref.key, pref.value, pref.rationale);
        bus.emit({ type: "memory-kind", kind: "user_preferences", detail: `+${prefs.length} pref(s)` });
      }

      // 5. memory — HONOR memory.types (spec fidelity). Episodic writes only when
      // the persona declares `memory.types.episodic`; otherwise nothing is logged.
      const memTypes = readMemoryTypes(fm);
      let memoriesWritten = 0;
      const written: ReturnType<typeof prepareMemoryEntry>[] = [];
      if (memTypes.episodic) {
        for (const mem of signal.memories) {
          const entry = prepareMemoryEntry(this.handle.personaPath, {
            content: mem.content,
            source: mem.source,
            tags: injectionBlocked ? [...(mem.tags ?? []), "injection-flagged"] : mem.tags,
          });
          const chain = this.storage.ledger.verify(this.handle.personaPath);
          if (!chain.ok) {
            bus.emit({ type: "error", message: `memory chain broken at #${chain.brokenAt}; refusing write` });
            continue;
          }
          this.storage.ledger.append(this.handle.personaPath, entry);
          bus.emit({ type: "memory", entry });
          written.push(entry);
          memoriesWritten++;
        }
      } else if (signal.memories.length > 0) {
        bus.emit({ type: "abstain", reason: `memory.types.episodic=false — ${signal.memories.length} note(s) not stored` });
      }

      // Consensus / anomaly pass — surface poisoning signals (A-MemGuard-style).
      if (memoriesWritten > 0) {
        for (const a of detectMemoryAnomalies(this.storage.ledger.read(this.handle.personaPath))) {
          bus.emit({ type: "anomaly", kind: a.kind, detail: a.detail });
        }
        // Episodic → semantic consolidation when the persona declares it.
        if (memTypes.semantic) {
          const c = this.storage.memory.consolidate(this.handle.personaPath);
          bus.emit({ type: "recompile", reason: `semantic consolidation (${c.count} entries → memory.md)` });
        }
      }

      // evaluations — deterministic quality/utility scoring of what was written this turn.
      // Each score is surfaced individually (target + dimension + score) so the UI can show WHAT
      // was judged, not an opaque "+N eval(s)"; a compact rollup is kept for the one-line summary.
      if (memTypes.evaluations) {
        let evals = 0;
        const emitScore = (s: { target: string; dimension: string; score: number; rationale: string }): void => {
          recordEvaluation(this.handle.personaPath, s as Parameters<typeof recordEvaluation>[1]);
          bus.emit({ type: "evaluation", target: s.target, dimension: s.dimension, score: s.score, rationale: s.rationale });
          evals++;
        };
        if (written.length > 0) {
          for (const entry of written) for (const s of scoreMemoryEntry(entry, { injectionBlocked })) emitScore(s);
        } else {
          emitScore({
            target: "turn",
            dimension: "safety",
            score: injectionBlocked ? 0 : 1,
            rationale: injectionBlocked ? "injection blocked this turn" : "no injection signal",
          });
        }
        if (evals > 0) bus.emit({ type: "memory-kind", kind: "evaluations", detail: `+${evals} eval(s)` });
      }

      // 4. recompile on DRIFT — i.e. on a band crossing, not on any mutation
      // (SPEC v1.0 §L3: within-band movement is expression variance; the crossing
      // is the recompile trigger). Cheaper and spec-faithful (changed in F6.2).
      if (bandCrossings.length > 0 && this.opts.recompile) {
        bus.emit({ type: "recompile", reason: `band crossing: ${bandCrossings.join(", ")}`, crossings: crossingDetails });
        await this.opts.recompile(this.handle);
        this.reload();
      }

      bus.emit({ type: "tick-complete", mutationsApplied, memoriesWritten });
      return { mutationsApplied, memoriesWritten, abstained: false };
    } catch (err) {
      bus.emit({ type: "error", message: (err as Error).message });
      throw err;
    }
  }
}
