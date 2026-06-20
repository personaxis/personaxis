/**
 * `personaxis state` — manage state.json runtime state (v0.6+).
 *
 * Subcommands:
 *   state init    — Create an empty state.json beside a PERSONA.md, seeded
 *                   from envelope means declared in PERSONA.md.
 *   state mutate  — Adjust a current value in state.json by a delta, clamped
 *                   to the envelope declared in PERSONA.md. Mirrors the
 *                   runtime tool `adjust_persona_state(field, delta, reason)`.
 *   state show    — Pretty-print the current state.
 *
 * The mutation logic here is the same the runtime applies in production:
 * envelope lookup, clamping, mutation_log append, governance check stub.
 * Designed to be portable between SDK (this CLI) and the managed runtime.
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import chalk from "chalk";
import { loadPersonaFile } from "../load.js";

// ─── Types ─────────────────────────────────────────────────────────────────

interface StateFile {
  schema_version: "0.6.0";
  persona_id: string;
  persona_version: string;
  session_id?: string;
  values: Record<string, number>;
  active_context?: {
    task_mode: string | null;
    audience: string | null;
    additional_context_flags?: string[];
  };
  memory_anchors_active?: string[];
  mutation_log: MutationLogEntry[];
  last_compiled_at?: string | null;
  last_compiled_hash?: string | null;
}

interface MutationLogEntry {
  ts: string;
  field: string;
  from: number;
  to: number;
  delta_requested: number;
  clamped: boolean;
  reason: string;
  actor:
    | "actor-llm"
    | "runtime-decay"
    | "runtime-context"
    | "human-operator"
    | "judge-correction";
  tool_call_id?: string;
  governance_blocked?: boolean;
}

interface EnvelopeLookup {
  envelopes: Record<string, { mean: number; min: number; max: number }>;
  hardEnforcedVirtues: string[];
}

// ─── Envelope discovery from PERSONA.md ────────────────────────────────────

/**
 * Walk the PERSONA.md frontmatter to extract envelopes for every mutable
 * field (traits, affect, mood). Returns dot-notation keys identical to the
 * keys used in state.json.values.
 */
function extractEnvelopes(personaPath: string): EnvelopeLookup {
  const loaded = loadPersonaFile(personaPath);
  const data = (loaded.data ?? {}) as Record<string, unknown>;
  const envelopes: EnvelopeLookup["envelopes"] = {};
  const hardEnforcedVirtues: string[] = [];

  const personality = data.personality as
    | { traits?: Record<string, { mean?: number; range?: [number, number] }> }
    | undefined;
  if (personality?.traits) {
    for (const [name, t] of Object.entries(personality.traits)) {
      if (typeof t.mean === "number" && Array.isArray(t.range) && t.range.length === 2) {
        envelopes[`traits.${name}`] = { mean: t.mean, min: t.range[0], max: t.range[1] };
      }
    }
  }

  const affect = data.affect as
    | {
        baseline?: {
          core_affect?: Record<string, { mean?: number; range?: [number, number] }>;
          mood?: Record<string, { mean?: number; range?: [number, number] } | string>;
        };
      }
    | undefined;
  if (affect?.baseline?.core_affect) {
    for (const [dim, env] of Object.entries(affect.baseline.core_affect)) {
      if (typeof env.mean === "number" && Array.isArray(env.range) && env.range.length === 2) {
        envelopes[`affect.${dim}`] = { mean: env.mean, min: env.range[0], max: env.range[1] };
      }
    }
  }
  if (affect?.baseline?.mood) {
    for (const [dim, env] of Object.entries(affect.baseline.mood)) {
      if (
        typeof env === "object" &&
        env !== null &&
        typeof (env as { mean?: number }).mean === "number" &&
        Array.isArray((env as { range?: [number, number] }).range)
      ) {
        const e = env as { mean: number; range: [number, number] };
        envelopes[`mood.${dim}`] = { mean: e.mean, min: e.range[0], max: e.range[1] };
      }
    }
  }

  const character = data.character as
    | { virtues?: Record<string, { enforcement?: string }> }
    | undefined;
  if (character?.virtues) {
    for (const [name, v] of Object.entries(character.virtues)) {
      if (v.enforcement === "hard") hardEnforcedVirtues.push(name);
    }
  }

  return { envelopes, hardEnforcedVirtues };
}

// ─── Path resolution helpers ───────────────────────────────────────────────

function resolvePersonaAndState(personaPathArg?: string): {
  personaPath: string;
  statePath: string;
} {
  const personaPath = resolve(personaPathArg ?? "./PERSONA.md");
  if (!existsSync(personaPath)) {
    throw new Error(`PERSONA.md not found at ${personaPath}`);
  }
  const statePath = join(dirname(personaPath), "state.json");
  return { personaPath, statePath };
}

function readState(statePath: string): StateFile {
  if (!existsSync(statePath)) {
    throw new Error(
      `state.json not found at ${statePath}. Run 'personaxis state init' to create it.`,
    );
  }
  return JSON.parse(readFileSync(statePath, "utf-8")) as StateFile;
}

function writeState(statePath: string, state: StateFile): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ─── state init ────────────────────────────────────────────────────────────

const initSubcommand = new Command("init")
  .description("Create a state.json beside PERSONA.md seeded from envelope means.")
  .option("-f, --file <path>", "Path to PERSONA.md (default: ./PERSONA.md)")
  .option("--force", "Overwrite if state.json already exists")
  .action((options: { file?: string; force?: boolean }) => {
    try {
      const { personaPath, statePath } = resolvePersonaAndState(options.file);
      if (existsSync(statePath) && !options.force) {
        console.error(
          chalk.red("Error:"),
          `state.json already exists at ${statePath}. Use --force to overwrite.`,
        );
        process.exit(1);
      }

      const loaded = loadPersonaFile(personaPath);
      const data = (loaded.data ?? {}) as Record<string, unknown>;
      const metadata = (data.metadata ?? {}) as { name?: string; version?: string };

      const { envelopes } = extractEnvelopes(personaPath);
      const values: Record<string, number> = {};
      for (const [key, env] of Object.entries(envelopes)) {
        values[key] = env.mean;
      }

      const state: StateFile = {
        schema_version: "0.6.0",
        persona_id: metadata.name ?? "unknown",
        persona_version: metadata.version ?? "0.0.0",
        values,
        active_context: { task_mode: null, audience: null, additional_context_flags: [] },
        memory_anchors_active: [],
        mutation_log: [],
        last_compiled_at: null,
        last_compiled_hash: null,
      };

      writeState(statePath, state);
      console.log(
        chalk.green("✓"),
        `state.json initialized with ${Object.keys(values).length} values at ${statePath}`,
      );
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── state mutate ──────────────────────────────────────────────────────────

const mutateSubcommand = new Command("mutate")
  .description(
    "Adjust a current value in state.json by a delta, clamped to the envelope " +
      "declared in PERSONA.md. Mirrors the runtime tool adjust_persona_state.",
  )
  .requiredOption("--field <path>", "Dot-notation field path (e.g., 'mood.tone')")
  .requiredOption("--delta <number>", "Delta to apply (positive or negative)")
  .requiredOption("--reason <text>", "Human-readable rationale (required for audit)")
  .option("-f, --file <path>", "Path to PERSONA.md (default: ./PERSONA.md)")
  .option(
    "--actor <kind>",
    "Mutation actor: actor-llm | runtime-decay | runtime-context | human-operator | judge-correction",
    "human-operator",
  )
  .option("--tool-call-id <id>", "Tool call id for traceability (optional)")
  .action(
    (options: {
      field: string;
      delta: string;
      reason: string;
      file?: string;
      actor?: string;
      toolCallId?: string;
    }) => {
      try {
        const { personaPath, statePath } = resolvePersonaAndState(options.file);
        const state = readState(statePath);
        const { envelopes } = extractEnvelopes(personaPath);
        const envelope = envelopes[options.field];

        if (!envelope) {
          console.error(
            chalk.red("Error:"),
            `No envelope declared for '${options.field}' in PERSONA.md. ` +
              `Mutable fields: ${Object.keys(envelopes).join(", ")}`,
          );
          process.exit(2);
        }

        const delta = Number(options.delta);
        if (!Number.isFinite(delta)) {
          console.error(chalk.red("Error:"), `Invalid --delta value: ${options.delta}`);
          process.exit(2);
        }

        const current = state.values[options.field] ?? envelope.mean;
        const requested = current + delta;
        const next = Math.max(envelope.min, Math.min(envelope.max, requested));
        const clamped = next !== requested;

        // Governance stub: detect attempts to push fields tied to hard-enforced
        // virtues out of their declared envelope. The real check lives in the
        // managed runtime; here we just block out-of-envelope writes (which
        // clamping already prevents).
        const governanceBlocked = false;

        const entry: MutationLogEntry = {
          ts: new Date().toISOString(),
          field: options.field,
          from: current,
          to: next,
          delta_requested: delta,
          clamped,
          reason: options.reason,
          actor:
            (options.actor as MutationLogEntry["actor"]) ?? "human-operator",
          tool_call_id: options.toolCallId,
          governance_blocked: governanceBlocked,
        };

        state.values[options.field] = next;
        state.mutation_log = state.mutation_log ?? [];
        state.mutation_log.push(entry);

        writeState(statePath, state);

        console.log(
          chalk.green("✓"),
          `${chalk.bold(options.field)}: ${current} → ${next} ` +
            (clamped ? chalk.yellow(`(clamped to [${envelope.min}, ${envelope.max}])`) : ""),
        );
      } catch (err) {
        console.error(chalk.red("Error:"), (err as Error).message);
        process.exit(1);
      }
    },
  );

// ─── state show ────────────────────────────────────────────────────────────

const showSubcommand = new Command("show")
  .description("Pretty-print the current state.json beside PERSONA.md.")
  .option("-f, --file <path>", "Path to PERSONA.md (default: ./PERSONA.md)")
  .option("--json", "Output raw JSON instead of formatted summary")
  .action((options: { file?: string; json?: boolean }) => {
    try {
      const { statePath } = resolvePersonaAndState(options.file);
      const state = readState(statePath);

      if (options.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      console.log(chalk.bold(`Persona: ${state.persona_id}@${state.persona_version}`));
      console.log(chalk.dim(`Path: ${statePath}`));
      console.log("");
      console.log(chalk.bold("Current values:"));
      for (const [k, v] of Object.entries(state.values)) {
        console.log(`  ${chalk.cyan(k)}: ${v}`);
      }
      console.log("");
      console.log(chalk.bold("Active context:"));
      console.log(`  task_mode: ${state.active_context?.task_mode ?? "(none)"}`);
      console.log(`  audience: ${state.active_context?.audience ?? "(none)"}`);
      console.log("");
      console.log(chalk.bold(`Mutation log: ${state.mutation_log.length} entries`));
      const recent = state.mutation_log.slice(-3);
      for (const e of recent) {
        console.log(
          `  ${chalk.dim(e.ts)} ${e.field}: ${e.from} → ${e.to}` +
            (e.clamped ? chalk.yellow(" (clamped)") : "") +
            (e.governance_blocked ? chalk.red(" (blocked)") : ""),
        );
      }
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── Parent state command ──────────────────────────────────────────────────

export const stateCommand = new Command("state")
  .description("Manage state.json runtime state (v0.6+).")
  .addCommand(initSubcommand)
  .addCommand(mutateSubcommand)
  .addCommand(showSubcommand);
