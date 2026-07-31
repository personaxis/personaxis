# `personaxis sign` / `verify` / `attest`

The local trust seam. `sign`/`verify` attest the spec's **bytes**; `attest` attests the
**behavior** around them. The hosted attestation service (the platform) extends this same seam
with cryptographic signing, revocation, and a public verification endpoint; nothing here requires
an account or a network.

## `personaxis sign`

Writes `personaxis.sig.json` next to the persona: the spec's SHA-256 content hash, the
deterministic sigil fingerprint, `canonical_id`, `spec_version`, and the signing time.

```bash
personaxis sign [--persona <path>] [--print]
```

## `personaxis verify`

Recomputes the hash and reports tamper-evidence.

| Exit | Meaning |
|---|---|
| 0 | verified, bytes match the signature |
| 1 | mismatch, the spec changed since signing |
| 2 | error (no signature, unreadable persona) |

## `personaxis attest`

Mints `personaxis.attest.json`, the **behavioral credential**: the same content signature PLUS a
snapshot of the persona's governed behavior, with an expiry.

```bash
personaxis attest [--persona <path>] [--ttl <hours>] [--print]   # mint (default ttl 24h)
personaxis attest --check [--persona <path>]                     # is it still live?
personaxis attest --format vc                                    # W3C Verifiable Credential 2.0, to stdout
personaxis attest --format a2a                                   # A2A Agent Card extension entry, to stdout
```

### Interop formats (V4.1): the credential rides the stack's own rails

- `--format vc` emits the attestation as a **W3C Verifiable Credential (Data Model 2.0)**:
  `@context` `https://www.w3.org/ns/credentials/v2`, type `PersonaBehavioralAttestation`,
  `validFrom`/`validUntil` from the local expiry, and the claims under `credentialSubject`.
  The LOCAL mint is self-issued with a re-derivable integrity proof (the same surface
  `attest --check` verifies); the hosted attestation service issues it with a KMS-signed
  Data Integrity proof and a public verification endpoint.
- `--format a2a` emits an **A2A Agent Card extension** entry (drop it into your card's
  `capabilities.extensions[]`), so any host that parses signed Agent Cards can carry the
  behavioral attestation without knowing personaxis.

What the credential claims:

- **signature**: the spec bytes it covers (SHA-256 + sigil fingerprint).
- **drift**: global `D` and every layer against the persona's own
  `governance.drift_thresholds`, and whether all are within bounds.
- **chain**: the tamper-evident memory chain is intact, its length and head hash.
- **mutations**: how many audited state mutations exist.
- **freshness**: `attested_at` / `expires_at`. A credential is only worth anything live; an
  evolved persona must re-attest.

`attest` refuses to mint over a persona that fails validation (exit 2): a credential over an
invalid spec would be worthless.

### `attest --check`

Re-derives **every claim now** (nothing is trusted from the file except the signed hash) and
prints one `✓/✗` line per claim:

```
  ✓ signature  content sha256 matches
  ✓ drift      D 0.012 within all thresholds
  ✓ chain      intact (42 entries)
  ✓ freshness  expires 2026-07-18T12:00:00.000Z
⛨ ATTESTATION LIVE  Nyx
```

| Exit | Meaning |
|---|---|
| 0 | live: bytes match, drift within thresholds, chain intact, not expired |
| 1 | not live: tampered, over thresholds, chain broken, or expired |
| 2 | error (no attestation, invalid persona, unreadable files) |

CI gate example:

```bash
personaxis attest --check || exit 1   # block a deploy when the persona is not provably in-bounds
```
