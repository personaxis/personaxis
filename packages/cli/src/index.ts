#!/usr/bin/env node
import { program } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";
import { initCommand } from "./commands/init.js";
import { validateCommand } from "./commands/validate.js";
import { compileCommand } from "./commands/compile.js";
import { useCommand } from "./commands/use.js";
import { listCommand, templatesCommand } from "./commands/list.js";
import { lintCommand } from "./commands/lint.js";
import { diffCommand } from "./commands/diff.js";
import { exportCommand } from "./commands/export.js";
import { specCommand } from "./commands/spec.js";
import { templateCommand } from "./commands/template.js";
import { pullCommand } from "./commands/pull.js";
import { runtimeCommand } from "./commands/runtime.js";
import { stateCommand } from "./commands/state.js";
import { migrateCommand } from "./commands/migrate.js";
import { configCommand } from "./commands/config.js";
import { decompileCommand } from "./commands/decompile.js";
import { pushCommand } from "./commands/push.js";
import { skillsCommand } from "./commands/skills.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8")
) as { version: string };

program
  .name("personaxis")
  .description("Define, validate, and compile AI agent personas")
  .version(pkg.version);

program.addCommand(initCommand);
program.addCommand(validateCommand);
program.addCommand(lintCommand);
program.addCommand(compileCommand);
program.addCommand(exportCommand);
program.addCommand(diffCommand);
program.addCommand(specCommand);
program.addCommand(useCommand);
program.addCommand(listCommand);
program.addCommand(templatesCommand);
program.addCommand(templateCommand);
program.addCommand(pullCommand);
program.addCommand(runtimeCommand);
program.addCommand(stateCommand);
program.addCommand(migrateCommand);
program.addCommand(configCommand);
program.addCommand(decompileCommand);
program.addCommand(pushCommand);
program.addCommand(skillsCommand);

program.parse();
