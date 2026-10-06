# `personaxis template`

Pedagogical templates: ready-made `personaxis.md` scaffolds you can read or start from.

```bash
personaxis template list                     # available templates
personaxis template show <name>              # print one to stdout
personaxis template get <name> -o .personaxis/personaxis.md   # write it to disk (-f to overwrite)
```

Templates are teaching material: every field carries its tier (MUST/SHOULD/MAY) and consumer
comments. To build a persona from evidence instead, use [`personaxis create`](./create.md), which
also compiles it.
