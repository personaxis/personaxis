# `personaxis verify`

Verify a persona against its signature (tamper-evidence). Exit codes: `0` verified, `1`
mismatch (the spec changed since `sign`), `2` error.

```bash
personaxis verify
personaxis verify --persona <path> --sig <signature file>
```

`--persona` picks the persona (default: resolved from the current folder) and `--sig` the
signature file (default: `personaxis.sig.json` next to the persona).

Pairs with `personaxis sign` (writes the signature) and `personaxis attest` (the behavioral
credential). CI-friendly: the exit code is the verdict.
