import { Command } from "commander";
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import chalk from "chalk";
import matter from "gray-matter";
import { confirm } from "@inquirer/prompts";
import { loadPersonaFile, resolvePersonaSourcePath } from "../load.js";
import { resolveDeclaredSkills, writeSkillsManifest, type DeclaredSkill, type SkillStatus } from "../targets/skills.js";

interface SkillsManifestFile {
  skills: { name: string; kind: DeclaredSkill["kind"]; ref?: string; status: SkillStatus }[];
}

function resolveBaseDir(target: string | undefined, root: boolean | undefined): string {
  const isSubagent = !!target && !root;
  const slug = isSubagent ? target : undefined;

  let sourcePath: string;
  try {
    sourcePath = resolvePersonaSourcePath(slug);
  } catch (err) {
    console.error(chalk.red("Error:"), (err as Error).message);
    process.exit(1);
  }

  return dirname(sourcePath);
}

async function runSkillsList(target: string | undefined, opts: { root?: boolean }): Promise<void> {
  const baseDir = resolveBaseDir(target, opts.root);
  const manifestPath = join(baseDir, "skills-manifest.json");

  let entries: SkillsManifestFile["skills"];
  if (existsSync(manifestPath)) {
    entries = (JSON.parse(readFileSync(manifestPath, "utf-8")) as SkillsManifestFile).skills;
  } else {
    const sourcePath = resolvePersonaSourcePath(target && !opts.root ? target : undefined);
    const loaded = loadPersonaFile(sourcePath);
    const declared = resolveDeclaredSkills(loaded.data, baseDir);
    writeSkillsManifest(declared, baseDir);
    entries = declared.map((skill) =>
      skill.kind === "local"
        ? { name: skill.name, kind: skill.kind, status: skill.missing ? "missing-local" : "materialized" }
        : { name: skill.name, kind: skill.kind, ref: skill.ref, status: "reference-only" },
    );
  }

  if (!entries.length) {
    console.log(chalk.dim("No skills declared in extensions.skills."));
    return;
  }

  const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
  const kindWidth = Math.max(4, ...entries.map((e) => e.kind.length));
  const statusWidth = Math.max(6, ...entries.map((e) => e.status.length));

  console.log(chalk.bold("name".padEnd(nameWidth)), chalk.bold("kind".padEnd(kindWidth)), chalk.bold("status".padEnd(statusWidth)), chalk.bold("ref"));
  for (const entry of entries) {
    const statusColor = entry.status === "missing-local" ? chalk.yellow : entry.status === "materialized" ? chalk.green : chalk.dim;
    console.log(
      entry.name.padEnd(nameWidth),
      entry.kind.padEnd(kindWidth),
      statusColor(entry.status.padEnd(statusWidth)),
      chalk.dim(entry.ref ?? ""),
    );
  }
}

function validateSkillMd(skillMdPath: string, expectedName: string): string[] {
  const errors: string[] = [];

  if (!existsSync(skillMdPath)) {
    errors.push("SKILL.md not found");
    return errors;
  }

  const { data } = matter(readFileSync(skillMdPath, "utf-8"));
  const name = typeof data.name === "string" ? data.name : undefined;
  const description = typeof data.description === "string" ? data.description : undefined;

  if (!name) errors.push("SKILL.md frontmatter is missing required field `name`");
  if (!description) errors.push("SKILL.md frontmatter is missing required field `description`");
  if (name && name !== expectedName) errors.push(`SKILL.md frontmatter \`name: ${name}\` does not match folder name \`${expectedName}\``);
  if (name && /--/.test(name)) errors.push(`SKILL.md frontmatter \`name: ${name}\` must not contain consecutive hyphens`);

  return errors;
}

async function runSkillsPull(target: string | undefined, name: string, opts: { root?: boolean; yes?: boolean }): Promise<void> {
  const isSubagent = !!target && !opts.root;
  const slug = isSubagent ? target : undefined;
  const baseDir = resolveBaseDir(target, opts.root);

  const sourcePath = resolvePersonaSourcePath(slug);
  const loaded = loadPersonaFile(sourcePath);
  const declared = resolveDeclaredSkills(loaded.data, baseDir);

  const skill = declared.find((s) => s.name === name);
  if (!skill) {
    console.error(chalk.red("Error:"), `no skill named "${name}" declared in extensions.skills`);
    process.exit(1);
  }
  if (skill.kind !== "github") {
    console.error(chalk.red("Error:"), `"${name}" is a ${skill.kind} entry. personaxis skills pull only supports github: entries.`);
    if (skill.kind === "registry") {
      console.error(chalk.dim("  registry (@org/name@version) entries have no unified pull standard yet."));
    }
    process.exit(1);
  }

  const ref = skill.ref as string;
  const segments = ref.split("/");
  if (segments.length < 2) {
    console.error(chalk.red("Error:"), `invalid github ref "${ref}" (expected org/repo[/path])`);
    process.exit(1);
  }
  const [org, repo, ...pathSegments] = segments;
  const subpath = pathSegments.join("/");
  const repoUrl = `https://github.com/${org}/${repo}.git`;

  const tmpDir = mkdtempSync(join(tmpdir(), "personaxis-skill-"));
  try {
    console.log(chalk.dim(`→ cloning ${org}/${repo} (sparse)...`));
    execSync(`git clone --depth 1 --filter=blob:none --sparse --quiet ${repoUrl} .`, { cwd: tmpDir, stdio: "pipe" });
    if (subpath) {
      execSync(`git sparse-checkout set ${JSON.stringify(subpath)}`, { cwd: tmpDir, stdio: "pipe" });
    }

    const sourceDir = subpath ? join(tmpDir, subpath) : tmpDir;
    const skillMdPath = join(sourceDir, "SKILL.md");
    const errors = validateSkillMd(skillMdPath, name);

    if (errors.length) {
      console.error(chalk.red("✗"), `${ref}/SKILL.md failed agentskills.io validation:`);
      for (const err of errors) console.error(chalk.dim("  -"), err);
      process.exit(1);
    }

    const destDir = join(baseDir, "skills", name);
    cpSync(sourceDir, destDir, { recursive: true, force: true, filter: (src) => !src.includes(`${join(sourceDir, ".git")}`) });

    console.log(chalk.green("✓"), `${name}`, chalk.dim("→"), `${join(baseDir, "skills", name).replace(/\\/g, "/")}/`);

    const newEntry = `./skills/${name}`;
    const proceed = opts.yes
      ? true
      : await confirm({
          message: `Rewrite extensions.skills entry "github:${ref}" -> "${newEntry}" in ${sourcePath}?`,
          default: true,
        });

    if (proceed) {
      const raw = readFileSync(sourcePath, "utf-8");
      const parsed = matter(raw);
      const skillsList = Array.isArray(parsed.data.extensions?.skills) ? (parsed.data.extensions.skills as string[]) : [];
      const idx = skillsList.findIndex((entry) => entry === `github:${ref}`);
      if (idx === -1) {
        console.log(chalk.yellow("!"), `could not find "github:${ref}" in extensions.skills to rewrite`);
      } else {
        skillsList[idx] = newEntry;
        parsed.data.extensions.skills = skillsList;
        writeFileSync(sourcePath, matter.stringify(parsed.content, parsed.data).trimEnd() + "\n", "utf-8");
        console.log(chalk.green("✓"), `extensions.skills updated in ${sourcePath}`);
      }
    } else {
      console.log(chalk.dim(`  extensions.skills left as "github:${ref}". Run`), chalk.cyan("personaxis compile"), chalk.dim("to materialize from ./skills/" + name + " manually."));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export const skillsCommand = new Command("skills")
  .description("Inspect and pull skills declared in extensions.skills");

skillsCommand
  .command("list")
  .description("List skills declared in extensions.skills and their materialization status")
  .argument("[slug]", "Subagent slug (defaults to the root persona)")
  .option("--root", "Use the root persona. Default when [slug] is omitted.")
  .action(async (slug: string | undefined, opts: { root?: boolean }) => {
    await runSkillsList(slug, opts);
  });

skillsCommand
  .command("pull")
  .description("Pull a github: skill into ./skills/<name> and optionally rewrite extensions.skills")
  .argument("<name>", "Skill name as declared in extensions.skills")
  .argument("[slug]", "Subagent slug (defaults to the root persona)")
  .option("--root", "Use the root persona. Default when [slug] is omitted.")
  .option("-y, --yes", "Rewrite extensions.skills without prompting")
  .action(async (name: string, slug: string | undefined, opts: { root?: boolean; yes?: boolean }) => {
    await runSkillsPull(slug, name, opts);
  });
