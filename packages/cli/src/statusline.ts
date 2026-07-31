/**
 * Configurable statusline (V2-F3.D20). A user template like
 * "{persona} · {model} · drift {drift} · {tokens} tok" is rendered by filling
 * `{key}` placeholders from the live vars; a missing key becomes empty. Pure and
 * side-effect-free (the Ink wiring that feeds it live vars is the REPL's job).
 */

export type StatuslineVars = Record<string, string | number | undefined>;

export function renderStatusline(template: string, vars: StatuslineVars): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}
