/**
 * Persistent tool permissions (V2-F3.B9). Config-level allow/deny rules that
 * survive the session, the Claude-Code `settings.json` equivalent: a `deny`
 * match blocks a tool before the human is ever asked, an `allow` match
 * auto-approves it, everything else falls back to interactive approval.
 *
 * Patterns are globs (only `*` is special) matched case-insensitively against
 * the tool `name`, `name detail`, and `name:detail`, so `bash`, `bash git *`,
 * and `bash:rm *` all work. Deny always wins over allow.
 */

export interface PermissionRules {
  allow?: string[];
  deny?: string[];
}

export type PermissionDecision = "allow" | "deny" | undefined;

function globToRe(pattern: string): RegExp {
  const esc = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

/** Extract a matchable command/path string from a tool call's args. */
export function callDetail(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  const strings = Object.values(args).filter((v): v is string => typeof v === "string");
  return strings.join(" ");
}

export function matchPermission(name: string, detail: string, rules: PermissionRules = {}): PermissionDecision {
  const targets = [name, detail ? `${name} ${detail}` : name, detail ? `${name}:${detail}` : name];
  const hit = (patterns?: string[]): boolean =>
    (patterns ?? []).some((p) => {
      if (!p.trim()) return false;
      const re = globToRe(p);
      return targets.some((t) => re.test(t));
    });
  if (hit(rules.deny)) return "deny";
  if (hit(rules.allow)) return "allow";
  return undefined;
}
