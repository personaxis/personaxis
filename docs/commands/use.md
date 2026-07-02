# `personaxis use` — **deprecated**

> ⚠️ **Deprecated.** `use` scaffolds + compiles a template in one step using **pre-v0.7 compilers**
> (the old field-mapping placement, before the LLM-compiled qualitative document). It only knows the
> `marketing-guru` template and the `claude-code`/`codex` targets. **Use the modern flow instead:**

```bash
# instead of:  personaxis use marketing-guru --name X --target claude-code
personaxis init                                   # scaffold .personaxis/personaxis.md (fill it in)
personaxis compile --root --platform claude-code  # compile to the host (claude-code|codex|openclaw|hermes)
```

The modern flow gives you the full v0.10 spec, the governed compile, per-host placement (including
`openclaw`/`hermes` → `SOUL.md`), and the whole [integrations](../integrations/README.md) story. `use`
remains only for backward compatibility and will be removed.
