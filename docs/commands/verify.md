# `personaxis verify`

Verify a persona against its signature (tamper-evidence). Exit codes: `0` verified, `1`
mismatch (the spec changed since `sign`), `2` error.

```bash
personaxis verify
```

Pairs with `personaxis sign` (writes the signature) and `personaxis attest` (the behavioral
credential). CI-friendly: the exit code is the verdict.
