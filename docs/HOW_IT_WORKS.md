# Personaxis — qué es y cómo funciona

> Documento de referencia funcional. Para el detalle de implementación por fase ver
> [`plan/`](../plan/MASTER_CHECKLIST.md); para el fundamento académico ver
> [`plan/14-apa-report/REPORT.md`](../plan/14-apa-report/REPORT.md).

## 1. Qué es (y cómo se llama)

**Personaxis** es la *toolchain de personas de IA vivas y gobernadas*. No es un agente que
compite con Claude Code, Codex o Hermes: es la capa de **identidad viva, portable y
auditable** que se les puede dar — o que puede correr sola sobre un modelo local.

Nombres:
- **Producto / repo:** `personaxis` (la carpeta `cli` se renombrará a `personaxis`).
- **Binario del CLI:** `personaxis`.
- **Binario de la TUI:** `personaxis-dash`.
- **Binario del servidor MCP:** `personaxis-mcp`.
- **Paquetes npm (monorepo):** `@personaxis/core` (motor), `@personaxis/cli`,
  `@personaxis/mcp`, `@personaxis/tui`.

La idea central: una persona puede **adaptarse** al usuario y al contexto sin dejar de ser
segura, porque **toda evolución es clampeada, auditada y reversible**, y los **invariantes
universales del spec son inviolables**. Esa gobernanza —no la auto-mejora cruda— es el
diferenciador.

## 2. El modelo de tres artefactos

Una persona se describe con tres archivos (spec `personaxis.md` v0.7):

| Artefacto | Qué es | Mutabilidad |
|---|---|---|
| `.personaxis/personaxis.md` | Identidad **cuantitativa**: 10 capas, *envelopes* `{mean, range}`, invariantes | Inmutable (salvo flujo gobernado) |
| `PERSONA.md` / `.claude/agents/<slug>.md` | Identidad **cualitativa** compilada (prosa) — slot #1 del system prompt | Generada (`compile`); editable a mano (`decompile`) |
| `state.json` | Estado **mutable** de runtime: valores actuales + `mutation_log` | Muta vía la herramienta `adjust_persona_state`, clampeado a los envelopes |

Las 10 capas: identity, character, personality, values_and_drives, affect, cognition,
memory, metacognition, reflexive_self_regulation, persona. Cada campo mutable (traits,
affect, mood) declara un *envelope* `mean + [min,max]`; el valor actual vive en `state.json`
y **nunca** puede salir de su rango.

## 3. El Living Loop (lo que la hace "viva")

Arrancas el REPL con solo `personaxis` (sin subcomando). Conversas en lenguaje natural o
usas `/comandos`. Cada turno alimenta un **lazo gobernado**:

```
observe   → captura una señal (input del usuario, salida de tool, reflexión)  [con procedencia]
   ↓        + escaneo de inyección (texto malicioso no dirige la evolución)
appraise  → el modelo propone SOLO señales estructuradas (JSON-schema), no mutaciones crudas
   ↓
evolve    → el código del spec aplica el delta CLAMPEADO al envelope + gate de gobernanza
   ↓        + entrada inmutable en mutation_log
recompile → si hubo drift, sincroniza el doc compilado del host (live-sync) + marcador .live.json
   ↓
memory    → escribe a memoria episódica (append-only, encadenada por hash) tras verificar la cadena
```

**División de seguridad:** el modelo (incluso uno pequeño ≤4B) solo *propone*; el código y el
spec *imponen* la seguridad. Por eso es viable en modelos chicos y seguro a la vez.

El modo de evolución lo decide `improvement_policy.mode` del spec:
- `locked` (por defecto): el lazo aprecia y recuerda, pero las mutaciones de envelope son
  solo dirigidas por humano.
- `suggesting`: el actor propone auto-ediciones que entran a una cola de aprobación humana.
- `autonomous` (solo sandbox): aplica directo, acotado por invariantes + verificadores.

## 4. Gobernanza y seguridad (el *moat*)

- **Envelopes + clamping:** ningún valor sale de su rango declarado.
- **Invariantes universales (12):** el validador los enforce; un `personaxis.md` que falle no
  compila. Salidas con 5 exit codes.
- **Memoria gobernada:** episódica *append-only* con **procedencia** (user/tool/internal/
  synthesis) y **cadena de hashes** (detecta manipulación). Borrado por petición vía *tombstone*
  (no reescribe la historia; la cesura es auditable).
- **Defensas de inyección/envenenamiento:** escáner de inyección por capas (normalización
  Unicode, zero-width, bidi, homóglifos; decodificación base64/hex; reglas ponderadas);
  detección de anomalías con consenso multi-path; *gates de acción sensible* por procedencia.
- **Auto-evolución gobernada:** `propose/apply/revert`, protección de campos invariantes, minteo
  de versión, y **consenso multiagente** (quórum de verificadores) antes de aplicar.
- **Sandbox de comandos:** motor de política de dos ejes (approval × sandbox) → `allow|ask|deny`,
  con wrapper nativo best-effort (Seatbelt/bubblewrap). Un comando `deny` no corre.

## 5. Comandos (referencia)

**El vivo:**
- `personaxis` — abre el **REPL** (sesión viva). Dentro: `/state`, `/evolve <texto>`, `/audit`,
  `/memory`, `/sigil`, `/persona`, `/overseer`, `/goal`, `/loop`, `/model`, `/help`, `/exit`.
- `personaxis sigil [--persona <path>]` — sigilo ascii único de la persona + panel de envelopes.
- `personaxis-dash [--persona <path>]` — TUI viva que respira con el estado.

**Orquestación / entorno:**
- `personaxis overseer show|register|collection` — la vista maestra: todas las personas,
  proyectos y colecciones (en `~/.personaxis`).
- `personaxis orchestrate "<tarea>" [--run]` — enruta una tarea a la persona mejor calificada
  (blackboard por capacidad); `--run` ejecuta un ciclo del lazo en la asignada.
- `personaxis sync <other-state.json> --persona <path>` — reconcilia el `state.json` de otra
  máquina sin clobber (merge auditado).

**Interop:**
- `personaxis serve --persona <path>` — servidor HTTP + `agents.md` (para agentes que no hablan MCP).
- `personaxis-mcp` — servidor MCP (stdio) con 12 herramientas de persona.

**Spec (motor existente):** `init`, `validate`, `lint`, `compile`, `decompile`, `state`,
`migrate`, `push`, `pull`, `skills`, `template`, `diff`, `export`, `spec`, `use`, `list`, `config`.

## 6. Reuso de personas (global + overlay)

Una persona vive **global** en `~/.personaxis/personas/<slug>` (identidad + memoria acumulada).
Cada proyecto monta un **overlay** con su propio `state.json` y memoria de proyecto. Así puedes:
- **reusar** la misma persona con memoria acumulada entre proyectos, o
- instanciarla **fresca** por proyecto.

**Teams/Collections** agrupan personas y proyectos. El **user-clone** (tu gemelo digital) es una
persona versionada en git que puede vivir en Windows/Linux/macOS a la vez; el `sync` reconcilia
estado por-máquina sin que una sobrescriba a otra (identidad inmutable, solo estado/memoria
divergen y se mergean con auditoría).

## 7. Interoperar con agentes grandes (3 vías)

1. **MCP** (`personaxis-mcp`): herramientas como `persona_compiled`, `persona_state`,
   `adjust_persona_state`, `persona_observe`, `persona_audit`, `persona_propose_edit`,
   `skill_review`, `scan_text`, `evaluate_command`… El host (Claude Code/Codex) trae el modelo
   potente; personaxis aporta la identidad viva.
2. **`agents.md` + HTTP** (`personaxis serve`): contrato de bajo contexto para agentes que no
   hablan MCP (patrón Hugging Face Spaces).
3. **Subagente nativo**: `compile` a `.claude/agents/<slug>.md`, `.codex/agents/<slug>.toml`,
   `SOUL.md`; **live-sync** actualiza el doc del host cuando la persona evoluciona.

## 8. Arquitectura (monorepo)

```
personaxis/                      ← UNA sola repo (hoy carpeta "cli")
└── packages/
    ├── core/  @personaxis/core  → motor: envelopes, state-engine, governance, memoria,
    │                               Living Loop, appraisers, sigil, blackboard, sync,
    │                               live-sync, skills, injection, sandbox, registry
    ├── cli/   @personaxis/cli   → REPL + comandos (sobre core)
    ├── mcp/   @personaxis/mcp   → servidor MCP (sobre core)
    └── tui/   @personaxis/tui   → dashboard ascii (sobre core)
```

El **motor nunca imprime**: emite eventos; las UIs (REPL/TUI/MCP/HTTP) los renderizan. Esto
permite reusar un solo core en cada punto de entrada (patrón submit/event de Codex).

## 9. Empaquetado y plataformas

TypeScript en todas partes. Dos canales de distribución:
- **npm** (`npm i -g @personaxis/persona.md`) — requiere Node ≥20.
- **Binario único** por plataforma vía `bun compile` (`pnpm run package`) — sin runtime; los
  assets (schemas/templates/versión) se **embeben** en build, así el binario es autocontenido.

## 10. Cómo correrlo

```bash
pnpm install && pnpm run build && pnpm run test
node packages/cli/dist/index.js                 # REPL vivo (usa .personaxis/personaxis.md)
node packages/cli/dist/index.js sigil            # sigilo + panel
node packages/cli/dist/index.js overseer show    # vista maestra
node packages/cli/dist/index.js serve --persona .personaxis/personaxis.md   # HTTP + agents.md
node packages/tui/dist/index.js --persona .personaxis/personaxis.md         # dashboard
```

Modelo local para el paso de *appraise* (decodificación restringida mantiene seguro a un ≤4B):

```bash
export PERSONAXIS_ENDPOINT=http://localhost:11434/v1   # Ollama / llama.cpp
export PERSONAXIS_MODEL=qwen3:4b
```
