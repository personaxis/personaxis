# `personaxis credential`

Store API credentials in the OS secure store (Windows Credential Manager, macOS
Keychain, libsecret). The value is read from stdin, never from argv (no shell history leak).

```bash
personaxis credential set ANTHROPIC_API_KEY      # prompts on stdin
personaxis credential get ANTHROPIC_API_KEY      # masked preview, never the value; exit 1 if unset
```

A stored credential substitutes the env var of the same name during model resolution, so no
`export` is needed: an exported variable still wins over the stored value. `personaxis model set
key ...` is the config-file alternative.
