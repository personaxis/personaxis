# `personaxis credential`

Store and check API credentials in the OS secure store (Windows Credential Manager, macOS
Keychain, libsecret). The value is read from stdin, never from argv (no shell history leak).

```bash
personaxis credential set ANTHROPIC_API_KEY      # prompts on stdin
personaxis credential check ANTHROPIC_API_KEY    # masked preview, never the value
```

A stored credential substitutes the env var of the same name during model resolution, so no
`export` is needed. See also: `personaxis model set key ...` (config-file storage, 0600).
