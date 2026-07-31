# `personaxis sign`

Write a local integrity attestation for the persona: content hash + sigil, signed, that
`personaxis verify` (and the hosted verifier) check later.

```bash
personaxis sign
personaxis verify        # exit 0 verified · 1 mismatch · 2 error
```

This is the integrity HALF of the trust story (the file has not been tampered with). The
behavioral credential on top of it is `personaxis attest` (drift within thresholds +
tamper-evident chain + expiry). See `attest.md`.
