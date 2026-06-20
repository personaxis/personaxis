import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import chalk from "chalk";
import { loadPersonaFile, resolvePersonaSourcePath, getPersonaName } from "../load.js";
import { validatePersona, exitCodeFor } from "../schema.js";
import { runCompile } from "./compile.js";
import { runDecompile } from "./decompile.js";
import { hashContent, loadManifest } from "../manifest.js";
import { buildResourceBundle } from "../resource-bundle.js";
import type { ProviderName } from "../providers/index.js";

const DEFAULT_BASE_URL = "https://personaxis.com";

function getApiKey(): string {
  const key = process.env.PERSONAXIS_API_KEY;
  if (!key) {
    console.error(chalk.red("PERSONAXIS_API_KEY is not set."));
    console.error(chalk.dim("Create a key in the dashboard: https://personaxis.com/[org]/settings/api-keys"));
    process.exit(1);
  }
  return key;
}

function getBaseUrl(): string {
  return (process.env.PERSONAXIS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function readSibling(baseDir: string, name: string): string | undefined {
  const p = join(baseDir, name);
  return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
}

interface PushVersionResponse {
  semver: string;
  url: string;
}

export interface RunPushOptions {
  slug?: string;
  root?: boolean;
  provider?: ProviderName;
}

export async function runPush(opts: RunPushOptions): Promise<void> {
  const isSubagent = !!opts.slug && !opts.root;
  const slug = isSubagent ? (opts.slug as string) : undefined;

  let sourcePath: string;
  try {
    sourcePath = resolvePersonaSourcePath(slug);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    process.exit(1);
  }

  const baseDir = dirname(sourcePath);
  const compiledPath = resolve(isSubagent ? `.claude/agents/${slug}.md` : "PERSONA.md");

  // 1. validate
  let loaded = loadPersonaFile(sourcePath);
  let validation = validatePersona(loaded.data);
  if (!validation.valid) {
    console.error(chalk.red("✗"), `${relative(process.cwd(), sourcePath)} failed validation (${validation.status}). Aborting push.`);
    process.exit(exitCodeFor(validation.status));
  }
  console.log(chalk.green("✓"), "validate", chalk.dim(`(${validation.status})`));

  // 2. decompile if the compiled doc was hand-edited since the last compile/decompile
  const manifest = loadManifest(baseDir);
  const compiledExists = existsSync(compiledPath);
  const compiledHash = compiledExists ? hashContent(readFileSync(compiledPath, "utf-8")) : undefined;

  if (compiledExists && manifest && compiledHash !== manifest.compiledMdHash) {
    console.log(chalk.dim("→"), `${relative(process.cwd(), compiledPath)} was hand-edited since the last sync. Running decompile...`);
    await runDecompile({ slug, root: opts.root, provider: opts.provider });

    loaded = loadPersonaFile(sourcePath);
    validation = validatePersona(loaded.data);
    if (!validation.valid) {
      console.error(chalk.red("✗"), `decompile produced an invalid personaxis.md (${validation.status}). Aborting push.`);
      process.exit(exitCodeFor(validation.status));
    }
  } else if (!compiledExists) {
    console.log(chalk.dim("→"), `${relative(process.cwd(), compiledPath)} not found. Running compile...`);
  }

  // 3. (re)compile so the uploaded pair is always consistent
  await runCompile({ slug, root: opts.root, provider: opts.provider });

  // 4. bundle supporting folders
  const resourceBundle = buildResourceBundle(baseDir);

  // 5. upload
  const personaSlug = getPersonaName(loaded.data);
  const personaxisSpec = readFileSync(sourcePath, "utf-8");
  const compiledMd = readFileSync(compiledPath, "utf-8");
  const policyYaml = readSibling(baseDir, "policy.yaml");
  const stateJson = readSibling(baseDir, "state.json");
  const updatedManifest = loadManifest(baseDir);

  const key = getApiKey();
  const base = getBaseUrl();
  const res = await fetch(`${base}/api/v1/registry/personas/${encodeURIComponent(personaSlug)}/versions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "personaxis-cli/0.7.0",
    },
    body: JSON.stringify({
      personaxisSpec,
      compiledMd,
      compiledPath: relative(process.cwd(), compiledPath).replace(/\\/g, "/"),
      policyYaml,
      stateJson,
      resourceBundle: resourceBundle.toString("base64"),
      lastSpecOp: updatedManifest?.lastOp,
      lastSpecModel: updatedManifest?.model,
      lastSpecSource: updatedManifest?.source,
    }),
  });

  if (!res.ok) {
    let msg = `push failed with ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      if (j.error?.message) msg = `${j.error.code ?? "ERROR"}: ${j.error.message}`;
    } catch {
      /* keep default */
    }
    console.error(chalk.red("✗"), msg);
    process.exit(1);
  }

  const body = (await res.json()) as PushVersionResponse;
  console.log(chalk.green("✓"), chalk.bold(personaSlug), chalk.dim(`v${body.semver}`), chalk.dim("→"), body.url);
}

export const pushCommand = new Command("push")
  .description("Validate, sync personaxis.md <-> PERSONA.md/<slug>.md, and publish a new persona version")
  .argument("[slug]", "Subagent slug to push (defaults to the root persona)")
  .option("--root", "Push the root persona. Default when [slug] is omitted.")
  .option("--provider <name>", "Override the configured provider for compile/decompile (local | byok | agent | remote)")
  .action(async (slug: string | undefined, opts: { root?: boolean; provider?: string }) => {
    await runPush({ slug, root: opts.root, provider: opts.provider as ProviderName | undefined });
  });
