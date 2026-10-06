# @personaxis/evals

The conformance suite for the Personaxis engine. It runs the real engine against scenarios that
assert the properties the product depends on: the clamp holds, the gate blocks, the memory chain
is tamper-evident, budgets stop a runaway loop, an unverified finish is caught, and secrets never
reach the record. It is deterministic and needs no API key, so it can gate CI.

```bash
npx @personaxis/evals                       # 19 scenarios, a console report
npx @personaxis/evals --json --out report.json
npx @personaxis/evals --compare report.json # fail on any regression against a saved report
```

Each scenario carries a conformance level (C0, C1, C2) and a category (spec fidelity, governance,
security). The process exits non-zero when a scenario fails.

| Flag | Effect |
|---|---|
| `--json`, `--markdown` | the report format on stdout |
| `--out <file>` | write the report to a file (JSON, or Markdown with `--markdown`) |
| `--compare <report.json>` | compare against an earlier report |

As a library: `runScenarios()`, `SCENARIOS`, `compareReports()`.

MIT licensed.
