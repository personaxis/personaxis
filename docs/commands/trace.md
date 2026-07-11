# `personaxis trace`

Inspect the causal trace of a persona's runtime, the JSONL/OTLP spans emitted by the Living
Loop and Agent Loop (observe → appraise → govern → mutate → memory; tool proposals/verdicts;
verification gates).

## Usage
```bash
personaxis trace [path]
```

Tracing config (jsonl/otlp endpoint, sample rate, redaction) lives in the spec's
`observability` block; the tracer is `packages/core/src/trace.ts`.
