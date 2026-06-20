import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TemplateDescriptor {
  name: string;
  filename: string;
  description: string;
  kind: "AgentPersona" | "UserPersona" | "Baseline";
}

const TEMPLATES: TemplateDescriptor[] = [
  {
    name: "agent",
    filename: "personaxis_template.md",
    description: "Canonical pedagogical scaffold for .personaxis/personaxis.md — every field annotated with tier (MUST/SHOULD/MAY), type, and universal status. Use for authoring the quantitative spec, not for runtime.",
    kind: "AgentPersona",
  },
  {
    name: "compiled",
    filename: "PERSONA_template.md",
    description: "Canonical template for the compiled PERSONA.md / <slug>.md document (qualitative, generated via `personaxis compile` and hand-editable).",
    kind: "AgentPersona",
  },
];

function resolveTemplatePath(filename: string): string {
  // dist/commands/template.js → ../../templates/<filename>
  return resolve(__dirname, "..", "..", "templates", filename);
}

function loadTemplate(name: string): { descriptor: TemplateDescriptor; content: string } | undefined {
  const descriptor = TEMPLATES.find((t) => t.name === name);
  if (!descriptor) return undefined;
  const path = resolveTemplatePath(descriptor.filename);
  if (!existsSync(path)) return undefined;
  return { descriptor, content: readFileSync(path, "utf-8") };
}

const listCommand = new Command("list")
  .description("List available pedagogical templates")
  .action(() => {
    console.log("");
    console.log(chalk.bold("Pedagogical templates"));
    console.log("");
    for (const t of TEMPLATES) {
      console.log(`  ${chalk.cyan(t.name.padEnd(10))} ${chalk.dim(`(${t.kind})`)} ${t.description}`);
    }
    console.log("");
    console.log(chalk.dim("Inspect a template:"), chalk.cyan("personaxis template show <name>"));
    console.log(chalk.dim("Download a template:"), chalk.cyan("personaxis template get <name> [--out path]"));
    console.log("");
  });

const showCommand = new Command("show")
  .description("Print a pedagogical template to stdout")
  .argument("<name>", `Template name. Available: ${TEMPLATES.map((t) => t.name).join(", ")}`)
  .action((name: string) => {
    const t = loadTemplate(name);
    if (!t) {
      console.error(chalk.red("Unknown template:"), name);
      console.error(chalk.dim("Available:"), TEMPLATES.map((t) => t.name).join(", "));
      process.exit(1);
    }
    process.stdout.write(t.content);
  });

const getCommand = new Command("get")
  .description("Download a pedagogical template to disk for authoring")
  .argument("<name>", `Template name. Available: ${TEMPLATES.map((t) => t.name).join(", ")}`)
  .option("-o, --out <path>", "Destination path (defaults to ./<template filename>)")
  .option("-f, --force", "Overwrite existing file")
  .action((name: string, opts: { out?: string; force?: boolean }) => {
    const t = loadTemplate(name);
    if (!t) {
      console.error(chalk.red("Unknown template:"), name);
      console.error(chalk.dim("Available:"), TEMPLATES.map((t) => t.name).join(", "));
      process.exit(1);
    }

    const dest = resolve(opts.out ?? `./${t.descriptor.filename}`);
    if (existsSync(dest) && !opts.force) {
      console.error(chalk.yellow("Already exists:"), dest);
      console.error(chalk.dim("Use --force to overwrite."));
      process.exit(1);
    }

    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, t.content, "utf-8");

    const destLabel = opts.out ?? t.descriptor.filename;

    console.log("");
    console.log(chalk.green("✓"), chalk.bold(t.descriptor.filename), chalk.dim("→"), dest);
    console.log("");

    if (t.descriptor.name === "agent") {
      console.log(chalk.dim("  This is the pedagogical scaffold for .personaxis/personaxis.md (full comments,"));
      console.log(chalk.dim("  tier annotations, validator rules, examples). Fill it in, then validate:"));
      console.log("");
      console.log(chalk.cyan(`  personaxis validate ${destLabel}`));
      console.log("");
      console.log(chalk.dim("  Once it passes, compile the qualitative PERSONA.md / <slug>.md from it:"));
      console.log(chalk.cyan(`  personaxis compile --root`));
      console.log("");
    } else {
      console.log(chalk.dim("  This is the canonical template for the compiled PERSONA.md / <slug>.md"));
      console.log(chalk.dim("  document. Use it as a reference for section structure when hand-editing"));
      console.log(chalk.dim("  a compiled persona, or as the basis for a placement adapter."));
      console.log("");
    }
  });

export const templateCommand = new Command("template")
  .description("Manage pedagogical personaxis.md / PERSONA.md templates (for authoring, not runtime)")
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(getCommand);
