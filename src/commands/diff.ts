import { Command } from "commander";
import { readFileSync } from "fs";
import chalk from "chalk";
import matter from "gray-matter";

const REQUIRED_LAYERS = [
  "identity", "character", "personality", "values_and_drives", "affect",
  "cognition", "memory", "metacognition", "reflexive_self_regulation", "persona",
  "metadata", "governance", "security",
];

function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj === null || obj === undefined) return result;
  if (typeof obj !== "object") {
    if (prefix) result[prefix] = obj;
    return result;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < (obj as unknown[]).length; i++) {
      Object.assign(result, flatten((obj as unknown[])[i], `${prefix}[${i}]`));
    }
    return result;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    Object.assign(result, flatten(v, path));
  }
  return result;
}

function loadFlat(filePath: string): { flat: Record<string, unknown>; data: Record<string, unknown> } {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  return { flat: flatten(data), data };
}

export const diffCommand = new Command("diff")
  .description("Compare two PERSONA.md files and report field-level changes")
  .argument("<before>", "Path to the original PERSONA.md")
  .argument("<after>", "Path to the updated PERSONA.md")
  .option("--format <format>", "Output format: text (default) or json", "text")
  .action((beforePath: string, afterPath: string, opts: { format: string }) => {
    let before: ReturnType<typeof loadFlat>;
    let after: ReturnType<typeof loadFlat>;

    try {
      before = loadFlat(beforePath);
    } catch (e) {
      console.error(chalk.red("Error reading before file:"), (e as Error).message);
      process.exit(1);
    }
    try {
      after = loadFlat(afterPath);
    } catch (e) {
      console.error(chalk.red("Error reading after file:"), (e as Error).message);
      process.exit(1);
    }

    const beforeKeys = new Set(Object.keys(before.flat));
    const afterKeys = new Set(Object.keys(after.flat));
    const allKeys = new Set([...beforeKeys, ...afterKeys]);

    const added: string[] = [];
    const removed: string[] = [];
    const modified: Array<{ path: string; from: unknown; to: unknown }> = [];

    for (const key of allKeys) {
      const inBefore = beforeKeys.has(key);
      const inAfter = afterKeys.has(key);
      if (!inBefore) { added.push(key); continue; }
      if (!inAfter) { removed.push(key); continue; }
      if (JSON.stringify(before.flat[key]) !== JSON.stringify(after.flat[key])) {
        modified.push({ path: key, from: before.flat[key], to: after.flat[key] });
      }
    }

    // Breaking change: required layer removed or identity fields gone
    const breakingRemoved = removed.filter((k) => {
      const top = k.split(".")[0].split("[")[0];
      return REQUIRED_LAYERS.includes(top);
    });
    const hasBreaking = breakingRemoved.length > 0;

    if (opts.format === "json") {
      process.stdout.write(
        JSON.stringify(
          {
            added,
            removed,
            modified: modified.map((m) => ({ path: m.path, from: String(m.from), to: String(m.to) })),
            breaking: hasBreaking,
            breakingFields: breakingRemoved,
          },
          null,
          2
        ) + "\n"
      );
      process.exit(hasBreaking ? 1 : 0);
    }

    const label = `${beforePath} → ${afterPath}`;
    console.log("");
    console.log(chalk.bold(`Diff: ${label}`));
    console.log("");

    if (added.length === 0 && removed.length === 0 && modified.length === 0) {
      console.log(chalk.dim("  No changes."));
    } else {
      for (const k of added) {
        console.log(`  ${chalk.green("added    ")} ${chalk.cyan(k)}`);
      }
      for (const k of removed) {
        const tag = breakingRemoved.includes(k) ? chalk.red("removed  ") : chalk.red("removed  ");
        console.log(`  ${tag} ${chalk.cyan(k)}`);
      }
      for (const m of modified) {
        console.log(`  ${chalk.yellow("modified ")} ${chalk.cyan(m.path.padEnd(40))} ${chalk.dim(String(m.from))} ${chalk.dim("→")} ${String(m.to)}`);
      }
    }

    console.log("");

    if (hasBreaking) {
      console.log(chalk.red(`  Breaking: ${breakingRemoved.length} required field${breakingRemoved.length !== 1 ? "s" : ""} removed (${breakingRemoved.join(", ")})`));
    } else {
      console.log(chalk.dim("  No breaking changes."));
    }

    console.log("");
    process.exit(hasBreaking ? 1 : 0);
  });
