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
import {
  governMutations,
  readMode,
  readMaxStepDelta,
  type GovernanceConfig,
  DEFAULT_GOVERNANCE,
} from "./governance.js";
import { applyMutation } from "./state-engine.js";
import {
  commitMemoryEntry,
  prepareMemoryEntry,
  verifyMemoryChain,
  readMemory,
  readMemoryTypes,
  consolidateSemantic,
} from "./memory.js";
import { detectMemoryAnomalies } from "./provenance.js";
import { scanForInjection } from "./injection.js";
import { activeOverlay, applyOverlay } from "./self-evolution.js";
import { machineId } from "./registry.js";
import { randomUUID } from "node:crypto";
import { loadPersona, readState, writeState, type PersonaHandle, type StateFile } from "./persona.js";
import { EventBus } from "./events.js";
import type { Appraiser, AppraisalSignal, ProvenanceSource } from "./appraisal.js";

export interface LivingLoopOptions {
  appraiser: Appraiser;
  /** Override governance; otherwise read improvement_policy.mode from frontmatter. */
  governance?: Partial<GovernanceConfig>;
  /** Optional recompile hook (LLM-backed, lives in the CLI). Called on drift. */
  recompile?: (handle: PersonaHandle) => Promise<void>;
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

  constructor(
    personaPath: string,
    private readonly opts: LivingLoopOptions,
  ) {
    this.handle = loadPersona(personaPath);
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
    const mode = readMode(fm);
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
      const state: StateFile = readState(this.handle.statePath);

      // 2. appraise (model proposes structured signals only). A failing/unreachable
      // appraiser (network, auth, unsupported response_format) must NOT end the
      // session: degrade to "no evolution this turn" — the persona still replied
      // and the spec invariants are untouched.
      let signal: AppraisalSignal;
      try {
        signal = await this.opts.appraiser.appraise({
          observation: input.observation,
          source: input.source,
          personaBody: this.handle.body,
          mutableFields: Object.keys(env.envelopes),
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
      for (const m of admitted) {
        const result = applyMutation(state, env.envelopes, {
          field: m.field,
          delta: m.delta,
          reason: m.reason,
          actor: input.actor ?? "actor-llm",
          originNode: machineId(),
          sessionId: this.sessionId,
        });
        bus.emit({ type: "mutate", result });
        if (result.to !== result.from) mutationsApplied++;
      }
      if (admitted.length > 0) writeState(this.handle.statePath, state);

      // 5. memory — HONOR memory.types (spec fidelity). Episodic writes only when
      // the persona declares `memory.types.episodic`; otherwise nothing is logged.
      const memTypes = readMemoryTypes(fm);
      let memoriesWritten = 0;
      if (memTypes.episodic) {
        for (const mem of signal.memories) {
          const entry = prepareMemoryEntry(this.handle.personaPath, {
            content: mem.content,
            source: mem.source,
            tags: injectionBlocked ? [...(mem.tags ?? []), "injection-flagged"] : mem.tags,
          });
          const chain = verifyMemoryChain(this.handle.personaPath);
          if (!chain.ok) {
            bus.emit({ type: "error", message: `memory chain broken at #${chain.brokenAt}; refusing write` });
            continue;
          }
          commitMemoryEntry(this.handle.personaPath, entry);
          bus.emit({ type: "memory", entry });
          memoriesWritten++;
        }
      } else if (signal.memories.length > 0) {
        bus.emit({ type: "abstain", reason: `memory.types.episodic=false — ${signal.memories.length} note(s) not stored` });
      }

      // Consensus / anomaly pass — surface poisoning signals (A-MemGuard-style).
      if (memoriesWritten > 0) {
        for (const a of detectMemoryAnomalies(readMemory(this.handle.personaPath))) {
          bus.emit({ type: "anomaly", kind: a.kind, detail: a.detail });
        }
        // Episodic → semantic consolidation when the persona declares it.
        if (memTypes.semantic) {
          const c = consolidateSemantic(this.handle.personaPath);
          bus.emit({ type: "recompile", reason: `semantic consolidation (${c.count} entries → memory.md)` });
        }
      }

      // 4. recompile on drift (after state changes so the doc reflects them)
      if (mutationsApplied > 0 && this.opts.recompile) {
        bus.emit({ type: "recompile", reason: `${mutationsApplied} envelope mutation(s) applied` });
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
