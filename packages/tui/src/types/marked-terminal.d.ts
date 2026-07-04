// marked-terminal ships no types; the surface we use is one factory function.
declare module "marked-terminal" {
  export function markedTerminal(options?: Record<string, unknown>): unknown;
}
