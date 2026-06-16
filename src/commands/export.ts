import { Command } from "commander";
import { writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import chalk from "chalk";
import matter from "gray-matter";
import { loadPersonaFile } from "../load.js";
import { cleanPersonaData, serializeYaml } from "../clean.js";

const FORMATS = ["json", "md", "yaml"] as const;
type ExportFormat = (typeof FORMATS)[number];

function stripPedagogicalBody(body: string): string {
  // Remove the long top HTML comment block ("MARKDOWN BODY — human-readable...") and
  // any standalone inline HTML comments. Keeps real prose under each ## heading.
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .reduce<string[]>((acc, line) => {
      // collapse runs of 3+ blank lines into a single blank line
      if (line === "" && acc.length > 0 && acc[acc.length - 1] === "") return acc;
      acc.push(line);
      return acc;
    }, [])
    .join("\n")
    .trim() + "\n";
}

export const exportCommand = new Command("export")
  .description("Export PERSONA.md to a clean format (semantic content only, no pedagogical comments or empty fields)")
  .argument("[file]", "Path to PERSONA.md (defaults to ./PERSONA.md)")
  .requiredOption("--format <format>", `Export format: ${FORMATS.join(" | ")}`)
  .option("-o, --out <path>", "Write to a file instead of stdout")
  .action((file: string | undefined, opts: { format: string; out?: string }) => {
    const fmt = opts.format as ExportFormat;
    if (!FORMATS.includes(fmt)) {
      console.error(chalk.red("Unknown format:"), fmt);
      console.error(chalk.dim("Valid formats:"), FORMATS.join(", "));
      process.exit(1);
    }

    let loaded;
    try {
      loaded = loadPersonaFile(file);
    } catch (err) {
      console.error(chalk.red("Error:"), (err as Error).message);
      process.exit(1);
    }

    const cleaned = cleanPersonaData(loaded.data);
    let output: string;

    if (fmt === "json") {
      output = JSON.stringify(cleaned, null, 2) + "\n";
    } else if (fmt === "yaml") {
      const body = serializeYaml(cleaned).trimStart();
      output = body + "\n";
    } else {
      // md — frontmatter + body, both cleaned
      const raw = readFileSync(loaded.path, "utf-8");
      const parsed = matter(raw);
      const cleanBody = stripPedagogicalBody(parsed.content);
      const yaml = serializeYaml(cleaned).trimStart();
      output = `---\n${yaml}\n---\n\n${cleanBody}`;
    }

    if (opts.out) {
      const dest = resolve(opts.out);
      writeFileSync(dest, output, "utf-8");
      console.log(chalk.green("✓"), "Exported", chalk.dim("→"), dest);
    } else {
      process.stdout.write(output);
    }
  });
