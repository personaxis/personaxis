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
  `@personaxis/mcp`, `@personaxis/sdk` (embeber en un backend), `@personaxis/tui`.

> **¿Cómo se usa en la práctica?** Hay dos modos (compañero de desarrollo local vs persona en runtime
> dentro de una app) y cuatro superficies (librería/SDK · HTTP `serve` · MCP · daemon `watch`). El
> "siempre vivo" se logra con **hooks** del host que disparan `personaxis observe` en TU modelo por
> turno (sin gastar tokens del host). Ver [architecture/deployment.md](./architecture/deployment.md),
> [configuration.md](./configuration.md) y [CONCEPTS_FAQ.md](./CONCEPTS_FAQ.md).

La idea central: una persona puede **adaptarse** al usuario y al contexto sin dejar de ser
segura, porque **toda evolución es clampeada, auditada y reversible**, y los **invariantes
universales del spec son inviolables**. Esa gobernanza —no la auto-mejora cruda— es el
diferenciador.

## 2. El modelo de tres artefactos

Una persona se describe con tres archivos (spec `personaxis.md` v1.1):

| Artefacto | Qué es | Mutabilidad |
|---|---|---|
| `.personaxis/personaxis.md` | Identidad **cuantitativa**: 10 capas, *envelopes* `{mean, range}`, invariantes | Inmutable (salvo flujo gobernado) |
| `PERSONA.md` / `.claude/agents/<slug>.md` | Identidad **cualitativa** compilada (prosa) — slot #1 del system prompt | Generada (`compile`); editable a mano (`decompile`) |
| `state.json` | Estado **mutable** de runtime: valores actuales + `mutation_log` | Muta vía la herramienta `adjust_persona_state`, clampeado a los envelopes |

Las 10 capas: identity, character, personality, values_and_drives, affect, cognition,
memory, metacognition, self_regulation, persona. Cada campo mutable (traits,
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
recompile → SOLO si una coordenada CRUZÓ de banda de comportamiento (lo normativo, spec §15):
   ↓        movimiento dentro de banda = varianza de expresión, no recompila; el cruce
   ↓        reescribe el doc compilado (live-sync) + marcador .live.json + evento `drift`
   ↓
memory    → escribe a memoria episódica (append-only, encadenada por hash) tras verificar la cadena
```

**División de seguridad:** el modelo (incluso uno pequeño ≤4B) solo *propone*; el código y el
spec *imponen* la seguridad. Por eso es viable en modelos chicos y seguro a la vez.

### El Agent Loop (ejecutar tareas, no solo evolucionar)

Junto al Living Loop (que evoluciona la **identidad**) corre el **Agent Loop** (que ejecuta
**tareas**). En el REPL no hay comando aparte: **al hablar en lenguaje natural**, la persona
conversa Y usa herramientas en un solo lazo gobernado:

```
tarea → [ el modelo propone una tool (run_command / read_file / write_file / edit_file / list_dir)
          → GATE del sandbox (allow | ask | deny) → (si ask) aprobación humana → ejecuta → observa ]*
        → finish
```

El modelo **solo propone** la tool-call; el **sandbox decide** (un `deny` nunca corre), las acciones
riesgosas **piden aprobación** (`shift+tab` cicla la postura: `read-only → workspace-write →
danger-full-access`), y **toda salida de tool se escanea por inyección** antes de volver al modelo.
Usa function-calling nativo del proveedor con fallback a JSON restringido (provider-agnostic). El mismo
agente se expone por MCP (`agent_run`) y HTTP (`POST /persona/agent`).

El modo de evolución lo decide `improvement_policy.mode` del spec:
- `locked` (por defecto): el lazo aprecia y recuerda, pero las mutaciones de envelope son
  solo dirigidas por humano.
- `suggesting`: el actor propone auto-ediciones que entran a una cola de aprobación humana.
- `autonomous` (solo sandbox): aplica directo, acotado por invariantes + verificadores.

## 4. Gobernanza y seguridad (el *moat*)

- **Garantías matemáticas machine-checked (v1.1):** los envelopes forman una caja compacta B;
  el clamp es la proyección Π_B. Teoremas T1–T6 ([`MATH_CORE.md`](./MATH_CORE.md)): ninguna
  secuencia adversaria escapa de B (T1), paso acotado (T2), cruzar una banda de comportamiento
  cuesta un mínimo demostrable de entradas de auditoría hash-encadenadas (T3), replay
  determinista + tamper localizado (T4/T5), homeostasis opt-in con drift estacionario acotado
  (T6). Verificado contra 2.3M de casos adversarios generados, 0 contraejemplos
  ([`GUARANTEES.md`](./GUARANTEES.md)). `personaxis proof` lo muestra en vivo; `state drift`
  computa dónde está la persona vs `governance.drift_thresholds` (gate de CI, exit 2).
- **Envelopes + clamping:** ningún valor sale de su rango declarado.
- **Invariantes universales (12):** el validador los enforce; un `personaxis.md` que falle no
  compila. Salidas con 5 exit codes.
- **Memoria gobernada:** episódica *append-only* con **procedencia** (user/tool/internal/
  synthesis) y **cadena de hashes** (detecta manipulación). Borrado por petición vía *tombstone*
  (no reescribe la historia; la cesura es auditable). El runtime **respeta `memory.types`** del spec:
  con `episodic: false` no escribe nada; con `semantic: true` consolida a `memory.md`. Los **seis
  tipos** están implementados y cada productor honra su flag (episodic, semantic, procedural,
  autobiographical, user_preferences, evaluations).
- **Defensas de inyección/envenenamiento:** escáner de inyección por capas (normalización
  Unicode, zero-width, bidi, homóglifos; decodificación base64/hex; reglas ponderadas);
  detección de anomalías con consenso multi-path; *gates de acción sensible* por procedencia.
- **Auto-evolución gobernada:** `propose/apply/revert`, protección de campos invariantes, minteo
  de versión, y **consenso multiagente** (quórum de verificadores) antes de aplicar.
- **Sandbox de comandos:** motor de política de dos ejes (approval × sandbox) → `allow|ask|deny`,
  con wrapper nativo best-effort (Seatbelt/bubblewrap). Un comando `deny` no corre.

## 5. Comandos (referencia)

**El vivo:**
- `personaxis` — abre el **REPL** (sesión viva). En un TTY es una **app de pantalla completa**
  (alternate-screen, sin dejar historial de frames): menú `/` en vivo y `shift+tab` para ciclar la
  postura del sandbox. Comandos: `/persona`, `/state`, `/improve`, `/review`, `/compile`, `/audit`,
  `/memory`, `/sessions`, `/resume`, `/compact`, `/goal`, `/loop` (corre ticks gobernados), `/mode`,
  `/model`, `/drift` (reporte u/banda/costo T3), `/arbitrate` (conflictos de valores),
  `/replay` (historia animada + veredicto T4), `/overseer`, `/help`, `/exit` (el sigil está dentro de `/persona`; no hay `/do` ni
  `/evolve` — hablar ya usa herramientas y evoluciona cada turno). (En pipe/CI cae a un lector simple.)
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
- `personaxis-mcp` — servidor MCP (stdio) con 16 herramientas de persona.

**Génesis y prueba (v1.1):**
- `personaxis create [slug]` — crea una persona desde cero: entrevista psicométrica,
  `--from-prompt`, `--from-project`, `--from-import` (character cards V2/V3, system prompts),
  `--from-transcript`. Válida por construcción + creation report con procedencia por número.
- `personaxis proof [--quick]` — demo offline de las garantías (tormenta adversaria, tamper,
  replay, costo de cruce certificado).
- `personaxis state drift` · `personaxis jacobian` · `personaxis arbitrate` — reporte de drift
  (gate CI), sensibilidad exacta del compile (números decorativos), arbitraje determinista.

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

## 7b. Identidad visual (diferenciada por spec)

Cada persona **se ve y se comporta distinto en la terminal**, derivado determinísticamente de su
`personaxis.md` (no es un spinner genérico). El `PersonaTheme` (`@personaxis/core`) mapea:

- **affect.valence → tono** de la paleta (frío ↔ cálido); **arousal → brillo**.
- **extraversion → ritmo/amplitud** del "respirar"; **openness → drift** (cuánto explora el sigilo
  entre frames); **emotionality → jitter**; **conscientiousness → simetría** (nítido ↔ orgánico).
- identidad → **glifos** y semilla estable; **voz** → `terse | balanced | expansive` (estilo de salida).

Toda la animación vive en **una sola sede**: `@personaxis/tui/visual` (logo animado, "despertar" de
la persona, sigilo temático animado, aura viva, floreos por evento, estilo de voz). La usan el REPL,
el comando `sigil` y el dashboard. Las animaciones solo corren en TTY; en pipe/CI hay fallback estático.
Dos personas distintas → sigilo, paleta, glifos y voz visiblemente distintos.

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

## 10. Flujos de trabajo (end-to-end)

> **Idea clave:** Personaxis es el *alma + memoria + conciencia* de la persona. Puede operar de dos
> formas: (a) **como capa** bajo un agente host (Claude Code, Codex) que trae el modelo potente, o
> (b) **como agente independiente** que ejecuta tareas él mismo vía el Agent Loop (hablando en
> lenguaje natural), gobernado por el sandbox. En ambos casos la identidad es persistente, la
> evolución acotada y toda acción auditada.

### Flujo A — Solo (personaxis sin un agente grande)

Útil cuando quieres una **identidad gobernada + memoria persistente + evolución acotada**, no un
reemplazo de Claude Code.

1. **Autoría:** `personaxis init` (o `pull`) → `personaxis validate` (pasa los 12 invariantes) →
   `personaxis compile` (genera `PERSONA.md`).
2. **Vida:** `personaxis` abre el REPL. Con un modelo local/BYOK (`PERSONAXIS_ENDPOINT`+`MODEL`),
   hablas con la persona: en cada turno **observa → aprecia → evoluciona (acotado) → recuerda**.
   Sin modelo, usa el appraiser heurístico (modo demo/offline).
3. **Auditoría y reuso:** `/audit` (ver el trail), `overseer show` (todo el entorno),
   `sync` (reconciliar entre máquinas).

Lo que **sí** hace solo: define/valida/compila la persona, corre el lazo gobernado (reacciones +
memoria + evolución acotada), sirve esa identidad, **y ejecuta tareas reales** al hablar — el
**Agent Loop** corre comandos y edita archivos, cada acción gateada por el sandbox de la persona
(`ask`/`deny`), con la salida escaneada y auditada. Necesita un modelo con tool-calling
(`PERSONAXIS_ENDPOINT`+`MODEL`). En postura `read-only` solo lee; en `workspace-write` actúa dentro
del proyecto pidiendo aprobación para lo riesgoso.

### Flujo B — Como capa bajo un agente potente (caso principal)

El host trae el modelo potente y el loop de tool-use; personaxis aporta identidad viva + gobernanza.

**B1 — Subagente nativo (sin MCP):**
```bash
personaxis compile --platform claude-code   # escribe .claude/agents/<slug>.md + baseline en CLAUDE.md
```
Claude Code adopta ese archivo como system-prompt del subagente → **el agente ES la persona**.
Cuando la persona evoluciona, `live-sync` reescribe el bloque LIVE-STATE del archivo y el host lo ve.

**B2 — MCP (runtime, más rico):** registras `personaxis-mcp` en el host. Secuencia típica de sesión:
1. **Inicio:** el host llama `persona_compiled` → carga la identidad (slot #1 del prompt).
2. **Durante el trabajo, el host llama a personaxis como "conciencia":**
   - `persona_observe` → un tick gobernado del lazo (la persona reacciona/evoluciona, acotada).
   - `adjust_persona_state` → ajusta mood/affect (clampeado + auditado).
   - `scan_text` → antes de confiar en contenido externo (defensa de inyección).
   - `evaluate_command` → antes de correr un comando (política sandbox: allow/ask/deny).
   - `skill_review` → antes de usar una skill (supply-chain).
   - `persona_propose_edit` → proponer una auto-edición del spec (gobernada por consenso).
3. **Cierre:** `persona_audit` (integridad de cadena + anomalías). **Estado y memoria persisten**;
   la próxima sesión, `persona_state`/`persona_compiled` restauran quién es.

**B3 — agents.md/HTTP:** las mismas operaciones por `curl` (`personaxis serve`) para agentes que
no hablan MCP.

### ¿Por qué un agente potente la usaría?
- **Identidad persistente y portable** entre sesiones, proyectos y máquinas (no re-explicas quién es).
- **Evolución gobernada y auditable**: se adapta al usuario sin derivar de forma insegura (moat de
  cumplimiento/seguridad).
- **Memoria con procedencia** + defensas anti-envenenamiento (Zombie Agents).
- **Segunda opinión de seguridad model-agnostic**: `scan_text`, `evaluate_command`, `skill_review`
  funcionan igual sin importar qué modelo use el host.

### Multi-persona (overseer)
`personaxis orchestrate "<tarea>"` enruta la tarea a la persona mejor calificada por capacidad
(blackboard). En B2, un orquestador host puede pedir a personaxis el ranking y luego delegar el
trabajo real a esa persona/subagente.

## 11. Cómo correrlo

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
