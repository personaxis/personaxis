# @personaxis/spec

The [personaxis.md](https://github.com/personaxis/persona.md) specification as a package: the
canonical JSON Schemas, the validator, and the universal invariants every persona must hold. The
CLI, the MCP server and the SDK all validate through it, so a document that passes here passes
everywhere.

```bash
npm i @personaxis/spec
```

```ts
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { validatePersona, exitCodeFor } from "@personaxis/spec";

const { data } = matter(readFileSync(".personaxis/personaxis.md", "utf8"));
const result = validatePersona(data);

for (const issue of [...result.errors, ...result.warnings]) {
	console.log(`${issue.category} ${issue.field}: ${issue.message}\n  fix: ${issue.fix}`);
}
process.exitCode = exitCodeFor(result.status);
```

`validatePersona` reads the version a document declares: spec 1.x is checked against the current
schema, and 0.3 to 0.10 against the frozen legacy one. Every issue carries a `fix`, the concrete
edit that resolves it.

| Status | Exit code | Meaning |
|---|---|---|
| `PASS` | 0 | every required field present, every universal satisfied |
| `PASS_WITH_WARNINGS` | 0 | valid, with recommended fields missing |
| `FAIL_SCHEMA` | 1 | a required field is absent or has the wrong type |
| `FAIL_POLICY` | 2 | a universal policy invariant is violated |
| `FAIL_CONCEPTUAL` | 3 | a prohibited claim or a wrong universal constant |

Also exported: the raw schemas (`personaSchema`, `personaSchemaLegacy`, `policySchema`,
`stateSchema`, `memorySchema`) and the compiled Ajv validators (`validate`, `validateLegacy`).

The normative text is [SPEC.md](https://github.com/personaxis/persona.md/blob/main/docs/SPEC.md).

MIT licensed.
