# `personaxis sign`

Write a local integrity record for the persona: the SHA-256 of its spec plus its sigil
fingerprint, in `personaxis.sig.json`. `personaxis verify` recomputes the hash later. The record
carries no cryptographic key, so it shows that the file changed, not who changed it.

```bash
personaxis sign
personaxis verify        # exit 0 verified · 1 mismatch · 2 error
```

This is the integrity half: the file has not changed since it was signed. The behavioral
credential on top of it is `personaxis attest` (drift within thresholds, an intact memory chain
and an expiry). See [attest](./attest.md). `--persona <path>` picks another persona and
`--print` writes the record to stdout instead of a file.
