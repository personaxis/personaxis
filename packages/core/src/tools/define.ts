/**
 * `defineTool` (J.1): register a tool from ONE declaration, with the handler's argument
 * type derived from the very JSON Schema the model sees.
 *
 * Why this shape, and not Zod. A prior deliberate decision (FR.7, see `registry.ts`) makes
 * the JSON Schema the single schema source and rejects a parallel Zod declaration; schemas
 * are flat by design (primitive props only). That already prevents schema-vs-schema drift.
 * The gap it left is on the HANDLER side: `execute(args: Record<string, unknown>)` has no
 * compile-time link to the schema, so reading `args.path` when the schema declared `file`
 * fails silently. `defineTool` closes exactly that gap: `InferArgs<S>` maps the flat schema
 * to a TypeScript type, so `gate`/`execute` receive typed args, checked by `tsc`, while the
 * schema stays the single runtime source (`validateToolArgs` still validates against it).
 *
 * No new runtime dependency, no reversal of FR.7: the schema is still the source of truth;
 * the type is a projection of it.
 */

import type { CommandVerdict, Policy } from "../sandbox.js";
import type { ToolSpec, ToolCategory } from "./registry.js";

/** The primitive JSON types a flat tool schema may use (FR.7: primitives only). */
type FlatJsonType = "string" | "number" | "boolean";

/** One property of a flat schema. `enum` narrows a string to its literal union. */
export interface FlatProp {
  type: FlatJsonType;
  description?: string;
  enum?: readonly string[];
}

/** A flat argument schema: an object of primitive props, no nesting (FR.7). */
export interface FlatSchema {
  type: "object";
  properties: Record<string, FlatProp>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

/** TS type for a single prop: an `enum` becomes its literal union, else the primitive. */
type TsOf<P extends FlatProp> = P extends { enum: readonly (infer E)[] }
  ? E
  : P["type"] extends "string"
    ? string
    : P["type"] extends "number"
      ? number
      : P["type"] extends "boolean"
        ? boolean
        : never;

/** The keys listed in `required`, intersected with the actual property keys. */
type RequiredKeys<S extends FlatSchema> = S["required"] extends readonly (infer K)[]
  ? K & keyof S["properties"]
  : never;

/**
 * The argument object a handler receives, derived from the schema: required props are
 * present, the rest optional. This is the projection that gives handlers their types.
 */
export type InferArgs<S extends FlatSchema> = {
  [K in RequiredKeys<S>]: TsOf<S["properties"][K]>;
} & {
  [K in Exclude<keyof S["properties"], RequiredKeys<S>>]?: TsOf<S["properties"][K]>;
};

/** What an author writes. Identical to ToolSpec, but `gate`/`execute` see typed args. */
export interface ToolDefinition<S extends FlatSchema> {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: S;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  gate(args: InferArgs<S>, policy: Policy): CommandVerdict;
  execute(args: InferArgs<S>, policy: Policy): Promise<string>;
}

/**
 * Build a `ToolSpec` from a typed definition. The returned spec is exactly what the registry
 * and the agent loop already consume: the typing lives at authoring time, and the runtime
 * object is unchanged, so `defineTool` is additive over the existing hand-written `TOOLS[]`.
 *
 * `const S` preserves the schema's literal types (property names, enums), which is what makes
 * `InferArgs` precise rather than widened to `Record<string, unknown>`.
 */
export function defineTool<const S extends FlatSchema>(def: ToolDefinition<S>): ToolSpec {
  return {
    name: def.name,
    description: def.description,
    category: def.category,
    parameters: def.parameters as Record<string, unknown>,
    isReadOnly: def.isReadOnly,
    isConcurrencySafe: def.isConcurrencySafe,
    // The registry calls these with untyped args (validated first by validateToolArgs);
    // the cast is the single boundary where the runtime's untyped shape meets the type.
    gate: (args, policy) => def.gate(args as InferArgs<S>, policy),
    execute: (args, policy) => def.execute(args as InferArgs<S>, policy),
  };
}
