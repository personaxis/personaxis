/**
 * `personaxis onboard --host <host>`, one command to wire a host end to end.
 *
 * Does the whole quickstart in one step so setup is turnkey, not a checklist:
 *   1. check a model is configured (resolveModel), tell the user how if not,
 *   2. compile the identity for the host (PERSONA.md + @-injection, or SOUL.md for openclaw/Hermes),
 *   3. install the end-of-turn hook (per-turn learning on your model),
 *   4. print the remaining manual step (put the API key in the env named by apiKeyEnv).
 *
 * Idempotent and safe to re-run. Nothing writes the API key to a file.
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { resolveModel, describeModel } from "@personaxis/core";
import { runCompile } from "./compile.js";
import { installHook, HOSTS, type Host } from "./hooks.js";
import type { PlacementPlatform } from "../targets/placement.js";

const SOUL_HOSTS = new Set<Host>(["openclaw", "hermes"]);

export const onboardCommand = new Command("onboard")
  .description(`Wire a coding-agent host end to end (config check → compile → hook). Hosts: ${HOSTS.join(" | ")}.`)
  .option("--host <host>", `Host to wire: ${HOSTS.join(" | ")}`, "claude-code")
  .option("-g, --global", "Install the hook to the user config instead of the project (claude-code/codex)", false)
  .option("--provider <name>", "Compile provider override (local | byok | agent | remote)")
  .action(async (opts: { host: string; global?: boolean; provider?: string }) => {
    if (!(HOSTS as readonly string[]).includes(opts.host)) {
      console.error(chalk.red("Error:"), `unknown host "${opts.host}". Use: ${HOSTS.join(" | ")}`);
      process.exit(1);
    }
    const host = opts.host as Host;

    // 0. Need a persona to compile.
    const persona = join(process.cwd(), ".personaxis", "personaxis.md");
    if (!existsSync(persona)) {
      console.error(chalk.red("Error:"), "no persona here. Run `personaxis init` first (creates .personaxis/personaxis.md).");
      process.exit(1);
    }

    console.log(chalk.bold.cyan(`\n  Onboarding ${host}\n`));

    // 1. Model.
    const model = resolveModel({ cwd: process.cwd() });
    if (model) {
      console.log(chalk.green("  ✓ model:"), chalk.dim(describeModel({ cwd: process.cwd() })));
    } else {
      console.log(chalk.yellow("  ! no model configured, set one (once, global):"));
      console.log(chalk.dim("      personaxis config set --global local.endpoint <openai-compatible-url>"));
      console.log(chalk.dim("      personaxis config set --global local.model <model-name>"));
      console.log(chalk.dim("      personaxis config set --global local.apiKeyEnv <ENV_VAR_WITH_YOUR_KEY>"));
      console.log(chalk.dim("    (the hook falls back to the offline heuristic until a model + key are set.)"));
    }

    // 2. Compile the identity for this host.
    try {
      const platform = SOUL_HOSTS.has(host) ? (host as PlacementPlatform) : undefined;
      await runCompile({ root: true, provider: opts.provider as never, ...(platform ? { platform } : {}) });
      console.log(chalk.green("  ✓ compiled identity"), chalk.dim(SOUL_HOSTS.has(host) ? "(SOUL.md)" : "(PERSONA.md + @-reference)"));
    } catch (e) {
      console.log(chalk.yellow("  ! compile deferred:"), (e as Error).message);
      console.log(chalk.dim("    (configure a model/provider, then re-run onboard, the hook still installs below.)"));
    }

    // 3. Install the hook.
    const res = installHook(host, Boolean(opts.global));
    console.log(res.already ? chalk.dim("  · hook already installed at ") + chalk.cyan(res.path) : chalk.green("  ✓ hook installed at ") + chalk.cyan(res.path));

    // 4. What's left for the user.
    console.log(chalk.bold("\n  Next:"));
    console.log(chalk.dim("  • Put your API key in the env var named by `apiKeyEnv` (never in a file):"));
    console.log(chalk.dim("      export COHERE_API_KEY=...   (or your provider's key env), then restart the host"));
    if (SOUL_HOSTS.has(host)) {
      if (host === "openclaw") console.log(chalk.dim("  • openclaw: run `openclaw hooks enable personaxis-observe`"));
      if (host === "hermes") console.log(chalk.dim("  • Hermes: point your profile at .hermes/SOUL.md (or copy to ~/.hermes/SOUL.md)"));
    }
    console.log(chalk.dim("  • Verify:  personaxis observe --observation \"hello\" --json   → { \"ok\": true }\n"));
  });
