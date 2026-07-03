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
 * All engine logic lives in @personaxis/core — this file owns ONLY the CLI
 * surface. That means `state mutate` goes through the SAME governance gate,
 * clamp, audit trail, atomic write, and lock as the Living Loop, MCP, HTTP
 * and SDK: unknown fields are rejected, traits backing hard-enforced virtues
 * are immutable for every actor, non-human actors are subject to the
 * improvement mode + max_step_delta drift bound, and a governance refusal is
 * itself recorded in mutation_log (governance_blocked: true).
 */

import { Command } from "commander";
import { existsSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import chalk from "chalk";
import {
  loadPersona,
  ensureState,
  readState,
  writeState,
  withStateLock,
  extractEnvelopes,
  applyMutation,
  governMutations,
  readMode,
  readMaxStepDelta,
  machineId,
  type MutationLogEntry,
} from "@personaxis/core";

// ─── Path resolution ───────────────────────────────────────────────────────

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

// ─── state init ────────────────────────────────────────────────────────────

const initSubcommand = new Command("init")
  .description("Create a state.json beside PERSONA.md seeded from envelope means.")
  .option("-f, --file <path>", "Path to PERSONA.md (default: ./PERSONA.md)")
  .option("--force", "Overwrite if state.json already exists")
  .action((options: { file?: string; force?: boolean }) => {
    try {
      const { personaPath, statePath } = resolvePersonaAndState(options.file);
      if (existsSync(statePath)) {
        if (!options.force) {
          console.error(
            chalk.red("Error:"),
            `state.json already exists at ${statePath}. Use --force to overwrite.`,
          );
          process.exit(1);
        }
        unlinkSync(statePath);
      }
      const handle = loadPersona(personaPath);
      const state = ensureState(handle);
      console.log(
        chalk.green("✓"),
        `state.json initialized with ${Object.keys(state.values).length} values at ${statePath}`,
      );
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }
  });

// ─── state mutate ──────────────────────────────────────────────────────────

const mutateSubcommand = new Command("mutate")
  .description(
    "Adjust a current value in state.json by a delta — governed, clamped to the " +
      "envelope declared in PERSONA.md, and audited. Mirrors adjust_persona_state.",
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
        const handle = loadPersona(personaPath);
        const fm = handle.frontmatter as Record<string, unknown>;
        const env = extractEnvelopes(fm);

        if (!(options.field in env.envelopes)) {
          console.error(
            chalk.red("Error:"),
            `No envelope declared for '${options.field}' in PERSONA.md. ` +
              `Mutable fields: ${Object.keys(env.envelopes).join(", ")}`,
          );
          process.exit(2);
        }

        const delta = Number(options.delta);
        if (!Number.isFinite(delta)) {
          console.error(chalk.red("Error:"), `Invalid --delta value: ${options.delta}`);
          process.exit(2);
        }

        const actor = (options.actor as MutationLogEntry["actor"]) ?? "human-operator";
        const decision = governMutations(
          [{ field: options.field, delta, reason: options.reason }],
          env,
          {
            mode: readMode(fm),
            maxStepDelta: readMaxStepDelta(fm),
            humanDirected: actor === "human-operator",
          },
        );

        const admitted = decision.admitted[0];
        const rejected = decision.rejected[0];

        const result = withStateLock(statePath, () => {
          const state = readState(statePath);
          const r = applyMutation(state, env.envelopes, {
            field: options.field,
            delta: admitted ? admitted.delta : delta,
            reason: admitted ? admitted.reason : options.reason,
            actor,
            toolCallId: options.toolCallId,
            governanceBlocked: !admitted,
            originNode: machineId(),
          });
          writeState(statePath, state);
          return r;
        });

        if (rejected) {
          // The refusal is itself in the audit trail (governance_blocked: true).
          console.error(
            chalk.red("✗ governance:"),
            `mutation of ${chalk.bold(options.field)} rejected — ${rejected.reason}. ` +
              `The blocked attempt was recorded in mutation_log.`,
          );
          process.exit(2);
        }

        console.log(
          chalk.green("✓"),
          `${chalk.bold(options.field)}: ${result.from} → ${result.to} ` +
            (result.clamped
              ? chalk.yellow(
                  `(clamped to [${env.envelopes[options.field].min}, ${env.envelopes[options.field].max}])`,
                )
              : ""),
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
