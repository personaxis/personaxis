/**
 * The DOCTOR miniapp (V7.B4 + V7.C1b).
 *
 * `/doctor` used to print one flat panel for the main persona, with the sub-persona
 * reachable only by typing `@slug` after the command. A health check you have to
 * already know the syntax of is a health check nobody runs on their sub-personas,
 * which is exactly where problems hide (a sub with no compiled document is invisible
 * to its host agent, and nothing else in the app says so).
 *
 * So Doctor is a view on the same tabbed host as the rest: `p` cycles personas, and
 * the checks re-run against whichever one is selected. The offline checks are all
 * synchronous, which is what makes this possible; the provider ping stays on the
 * command (`/doctor net`) because a view that redraws every second must never open
 * a socket per frame.
 */

import chalk from "chalk";
import { doctorChecksOffline } from "../doctor-checks.js";
import { slugAddressFromPath } from "../../load.js";
import type { Ctx } from "../types.js";
import { scopedProvider } from "./scoped.js";
import type { TabbedProvider, TabLine } from "./tabbed.js";

export const DOCTOR_TABS = ["Health"] as const;

/** The rendered check list for one persona, with the header that says what this is. */
export function doctorLines(ctx: Ctx): TabLine[] {
  const who = slugAddressFromPath(ctx.handle.personaPath) || "main";
  const report = doctorChecksOffline(ctx.handle.personaPath);
  const verdict =
    report.failures > 0
      ? chalk.red(`${report.failures} thing(s) to fix`)
      : report.warnings > 0
        ? chalk.yellow(`${report.warnings} thing(s) worth a look`)
        : chalk.green("nothing wrong");

  // The two hints live ABOVE the findings, not after them: a long check list
  // pushes anything below it out of the viewport, and "how do I also test the
  // provider" is precisely what someone reads this screen to find out.
  return [
    chalk.dim("  what this is: everything that can be checked WITHOUT a model or a network,"),
    chalk.dim("  for the persona selected above. Every finding carries the edit that resolves it."),
    chalk.dim("  `/doctor net` adds one provider ping · outside: `personaxis doctor [@slug] [net]`"),
    "",
    `  ${chalk.bold(who)} · ${verdict}`,
    "",
    ...report.lines,
  ];
}

/** Doctor as a scoped miniapp: one persona at a time, `p` to switch. */
export function doctorProvider(ctx: Ctx): TabbedProvider {
  return scopedProvider(ctx, (c) => ({
    title: "Doctor",
    tabs: [...DOCTOR_TABS],
    lines: () => doctorLines(c),
  }));
}
