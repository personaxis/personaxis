# `personaxis trace`

Inspect the causal trace of a persona's runtime, the JSONL/OTLP spans emitted by the Living
Loop and Agent Loop (observe → appraise → govern → mutate → memory; tool proposals/verdicts;
verification gates).

## Usage
```bash
personaxis trace <file> [--json]
```

`<file>` is a `trace-*.jsonl` file; `--json` prints the parsed spans as JSON. Tracing config
(jsonl/otlp endpoint, sample rate, redaction) lives in the spec's `observability` block.
