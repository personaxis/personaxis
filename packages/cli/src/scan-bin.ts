#!/usr/bin/env node
/**
 * `personaxis-scan`, standalone bin for the cross-harness agent-config scanner.
 * The free top-of-funnel wedge: `npx personaxis` ships it, and it runs
 * without a persona, a model, or any setup. Same engine as `personaxis scan`.
 */
import { scanCommand } from "./commands/scan.js";

scanCommand
  .name("personaxis-scan")
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
