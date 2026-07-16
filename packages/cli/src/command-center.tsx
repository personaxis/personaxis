/**
 * The Command Center (V2-F2): ONE stateful fullscreen Ink app hosting every
 * interactive surface as navigable sections: Model (config), State, Drift,
 * Audit, Memory, Proposals, Fleet. Rendered on the ALTERNATE SCREEN buffer
 * (tui/fullscreen), so opening, navigating and leaving it never prints a
 * single line into the terminal scrollback, the professional-TUI standard
 * (k9s / lazygit) David asked for.
 *
 * One root useInput owns navigation (this kills the double-enter the old
 * sequential-render config UI had); text fields yield the keyboard while
 * active. Business logic is REUSED, never re-implemented: the pure config
 * builders (config-wizard.ts), the engine readers (core), and the existing
 * DriftView component.
 */

import React, { useMemo, useState } from "react";
import { useApp, useInput, Box, Text } from "ink";
import {
  loadPersona,
  readState,
  extractEnvelopes,
  personaTheme,
  displayName,
  verifyMemoryChain,
  proposals,
  applySelfEdit,
  rejectSelfEdit,
  readMemory,
  readMemoryTypes,
  readSemanticMemory,
  readProcedural,
  readAutobiographical,
  readPreferences,
  readEvaluations,
  describeModel,
  type PersonaFrontmatter,
} from "@personaxis/core";
import { DriftView } from "@personaxis/tui/ink";
import { envelopeBars, sigilLines } from "@personaxis/tui/visual";
import { AppFrame, SelectList, Field, Toast, type ListItem, type KeyHint } from "@personaxis/tui/ui";
import { runFullscreen } from "@personaxis/tui/fullscreen";
import { loadConfig, saveConfig, configPath, type PersonaxisConfig } from "./config.js";
import {
  buildProfileFromAnswers,
  upsertProfile,
  setDefaultProfile,
  assignProfileToPersona,
  removeProfile,
  profileNames,
  type ProfileAnswers,
  type ProviderKind,
} from "./config-wizard.js";

// ── Sections ──────────────────────────────────────────────────────────────────

export type CenterSection = "home" | "model" | "state" | "drift" | "audit" | "memory" | "proposals" | "fleet";

const SECTIONS: ListItem[] = [
  { value: "model", title: "Model", desc: "providers, named profiles, default + per-persona assignment" },
  { value: "state", title: "State", desc: "live envelopes, current values, mutation count" },
  { value: "drift", title: "Drift", desc: "u per coordinate, bands, steps-to-cross (T3)" },
  { value: "audit", title: "Audit", desc: "mutation log, memory-chain integrity, self-edit ledger" },
  { value: "memory", title: "Memory", desc: "the six kinds: profile, episodic, semantic, procedural, autobiographical, evaluations" },
  { value: "proposals", title: "Proposals", desc: "queued self-edits: approve or reject" },
  { value: "fleet", title: "Fleet", desc: "every persona here: who is awake, drift, model (full status lands in F4)" },
];

const PROVIDERS: ListItem[] = [
  { value: "local", title: "Local / OpenAI-compatible", desc: "Ollama, LM Studio, or any OpenAI-compatible URL. No key needed." },
  { value: "openai", title: "OpenAI", desc: "your OpenAI account; reasons live + compiles (OPENAI_API_KEY)" },
  { value: "anthropic", title: "Anthropic", desc: "your Claude account; reasons live + compiles (ANTHROPIC_API_KEY)" },
  { value: "huggingface", title: "HuggingFace", desc: "the inference router; any hosted OSS model (HF_TOKEN)" },
  { value: "cohere", title: "Cohere", desc: "Cohere's compatibility API (COHERE_API_KEY)" },
  { value: "remote", title: "Personaxis hosted", desc: "our managed models (paid)" },
  { value: "agent", title: "Coding agent", desc: "no key; hands compile prompts to Claude Code / Codex" },
];

// ── The model wizard as data (one stateful form, not sequential renders) ─────

interface StepText {
  kind: "text";
  id: string;
  label: string;
  help?: string;
  def?: string;
  secret?: boolean;
}
interface StepSelect {
  kind: "select";
  id: string;
  label: string;
  items: ListItem[];
}
type Step = StepText | StepSelect;

function stepsFor(kind: ProviderKind): Step[] {
  const name: Step = { kind: "text", id: "name", label: "Profile name", help: "how you will refer to this model (e.g. /config, config use <name>)", def: kind === "remote" ? "personaxis" : kind };
  const makeDefault: Step = {
    kind: "select",
    id: "makeDefault",
    label: "Use it as the default model?",
    items: [
      { value: "yes", title: "Yes, make it the default", desc: "every persona without its own assignment uses it" },
      { value: "no", title: "No, just save it", desc: "assign it later (Model › assign to persona)" },
    ],
  };
  switch (kind) {
    case "local":
      return [
        { kind: "text", id: "endpoint", label: "Endpoint URL", help: "the server's OpenAI-compatible base URL", def: "http://localhost:11434/v1" },
        { kind: "text", id: "model", label: "Model name", help: "as the server knows it", def: "llama3.1" },
        {
          kind: "select",
          id: "keyMode",
          label: "How should personaxis get the API key?",
          items: [
            { value: "none", title: "No key", desc: "a local server with no auth (Ollama, LM Studio)" },
            { value: "env", title: "From an environment variable", desc: "you export e.g. MY_KEY in your shell; the key never touches a file" },
            { value: "inline", title: "Paste it now", desc: "stored in your private ~/.personaxis/config.json (user-only file)" },
          ],
        },
        { kind: "text", id: "keyEnv", label: "Env var name holding the key", def: "MY_API_KEY" },
        { kind: "text", id: "keyInline", label: "Paste the API key", secret: true },
        name,
        makeDefault,
      ];
    case "openai":
      return [
        { kind: "text", id: "model", label: "Model name", def: "gpt-4o-mini" },
        { kind: "text", id: "keyEnv", label: "Env var holding your OpenAI key", help: "export it in your shell; never stored in a file", def: "OPENAI_API_KEY" },
        name,
        makeDefault,
      ];
    case "anthropic":
      return [
        { kind: "text", id: "model", label: "Model name", def: "claude-sonnet-4-6" },
        { kind: "text", id: "keyEnv", label: "Env var holding your Anthropic key", def: "ANTHROPIC_API_KEY" },
        name,
        makeDefault,
      ];
    case "huggingface":
      return [
        { kind: "text", id: "model", label: "Model id", help: "e.g. meta-llama/Llama-3.1-8B-Instruct", def: "meta-llama/Llama-3.1-8B-Instruct" },
        { kind: "text", id: "keyEnv", label: "Env var holding your HF token", def: "HF_TOKEN" },
        name,
        makeDefault,
      ];
    case "cohere":
      return [
        { kind: "text", id: "model", label: "Model name", def: "command-r-plus" },
        { kind: "text", id: "keyEnv", label: "Env var holding your Cohere key", def: "COHERE_API_KEY" },
        name,
        makeDefault,
      ];
    case "remote":
      return [
        { kind: "text", id: "apiBase", label: "Personaxis API base", def: "https://api.personaxis.com" },
        { kind: "text", id: "model", label: "Model (blank = server default)", def: "" },
        name,
        makeDefault,
      ];
    case "agent":
      return [name, makeDefault];
  }
}

/**
 * Skip the key steps the chosen keyMode makes irrelevant. Only the LOCAL wizard
 * has a keyMode step, so the skip applies ONLY when keyMode was answered; for
 * cloud providers (no keyMode) keyEnv is a required step and must never be
 * skipped (the bug that dropped OpenAI's env-var step).
 */
function nextStepIndex(steps: Step[], from: number, answers: Record<string, string>): number {
  let i = from + 1;
  while (i < steps.length) {
    const s = steps[i];
    if (s.id === "keyEnv" && answers.keyMode !== undefined && answers.keyMode !== "env") i++;
    else if (s.id === "keyInline" && answers.keyMode !== undefined && answers.keyMode !== "inline") i++;
    else break;
  }
  return i;
}

// ── Data helpers (lazy reads, best-effort) ────────────────────────────────────

function profileItems(cfg: PersonaxisConfig): ListItem[] {
  return profileNames(cfg).map((n) => {
    const p = cfg.profiles?.[n];
    const where = p?.endpoint ?? p?.apiBase ?? p?.apiProvider ?? "";
    return {
      value: n,
      title: n,
      badge: cfg.defaultProfile === n ? "(default)" : undefined,
      desc: `${p?.provider ?? "local"} · ${p?.model ?? "(server default)"}${where ? ` @ ${where}` : ""}`,
    };
  });
}

// ── The app ───────────────────────────────────────────────────────────────────

export interface CommandCenterProps {
  personaPath?: string;
  personas?: string[];
  cwd: string;
  initialSection?: CenterSection;
}

type ModelView = "menu" | "provider" | "form" | "profiles" | "pick-default" | "pick-persona" | "pick-profile" | "pick-remove" | "show";

export function CommandCenter(props: CommandCenterProps): React.JSX.Element {
  const { exit } = useApp();
  const [section, setSection] = useState<CenterSection>(props.initialSection ?? "home");
  const [cursor, setCursor] = useState(0);
  const [toast, setToast] = useState<{ kind: "ok" | "warn" | "error" | "info"; text: string } | null>(null);

  // Model section state.
  const [modelView, setModelView] = useState<ModelView>(props.initialSection === "model" ? "menu" : "menu");
  const [wizKind, setWizKind] = useState<ProviderKind>("local");
  const [wizSteps, setWizSteps] = useState<Step[]>([]);
  const [wizIndex, setWizIndex] = useState(0);
  const [wizAnswers, setWizAnswers] = useState<Record<string, string>>({});
  const [wizInput, setWizInput] = useState("");
  const [pendingPersona, setPendingPersona] = useState<string | null>(null);

  // Memory section state.
  const [memoryKind, setMemoryKind] = useState<string | null>(null);

  const cfg = useMemo(() => loadConfig("global"), [section, modelView, toast]);
  const p = props.personaPath;

  const back = (): void => {
    setToast(null);
    setCursor(0);
    if (section === "model" && modelView !== "menu") {
      if (modelView === "form" && wizIndex > 0) {
        setWizIndex((i) => Math.max(0, i - 1));
        return;
      }
      setModelView(modelView === "provider" || modelView === "form" ? "menu" : "menu");
      return;
    }
    if (section === "memory" && memoryKind) {
      setMemoryKind(null);
      return;
    }
    if (section === "home") exit();
    else setSection("home");
  };

  const finishWizard = (answers: Record<string, string>): void => {
    const a: ProfileAnswers = {
      kind: wizKind,
      endpoint: answers.endpoint,
      model: answers.model,
      apiBase: answers.apiBase,
      keyMode: (answers.keyMode as ProfileAnswers["keyMode"]) ?? undefined,
      keyEnv: answers.keyEnv,
      keyInline: answers.keyInline,
    };
    const name = (answers.name ?? "").trim() || wizKind;
    let next = upsertProfile(loadConfig("global"), name, buildProfileFromAnswers(a));
    if (answers.makeDefault !== "no") next = setDefaultProfile(next, name);
    saveConfig(next, "global");
    const keyEnv = a.keyMode === "env" || (wizKind !== "local" && wizKind !== "remote" && wizKind !== "agent") ? (answers.keyEnv ?? "") : "";
    setToast({ kind: "ok", text: `saved "${name}" → ${configPath("global")}${keyEnv ? `   (remember: export ${keyEnv}=...)` : ""}` });
    setModelView("profiles");
    setCursor(0);
  };

  // The single root key handler. Text fields yield: while a text step is active,
  // only Esc is claimed here (TextInput owns characters + Enter).
  const textActive = section === "model" && modelView === "form" && wizSteps[wizIndex]?.kind === "text";
  useInput((input, key) => {
    if (key.escape) return back();
    if (textActive) return;
    if (input === "q" && section === "home") return exit();

    const listLen = activeListLength();
    if (key.upArrow) return setCursor((c) => (c + Math.max(1, listLen) - 1) % Math.max(1, listLen));
    if (key.downArrow) return setCursor((c) => (c + 1) % Math.max(1, listLen));
    if (key.tab && section !== "home") {
      // Cycle sections without going home first.
      const order = SECTIONS.map((s) => s.value as CenterSection);
      const at = order.indexOf(section);
      setSection(order[(at + 1) % order.length]);
      setCursor(0);
      return;
    }
    const n = Number.parseInt(input, 10);
    if (Number.isInteger(n) && n >= 1 && n <= listLen) {
      setCursor(n - 1);
      return activate(n - 1);
    }
    if (key.return) return activate(cursor);

    // Proposals: approve / reject in place.
    if (section === "proposals" && p) {
      const pending = proposals(p).filter((x) => x.status === "pending");
      const target = pending[Math.min(cursor, pending.length - 1)];
      if (!target) return;
      if (input === "a") {
        try {
          const r = applySelfEdit(p, target.id, "user");
          setToast({ kind: "ok", text: `applied ${target.id} → v${r.version}` });
        } catch (e) {
          setToast({ kind: "error", text: (e as Error).message });
        }
      } else if (input === "r") {
        rejectSelfEdit(p, target.id, "user");
        setToast({ kind: "warn", text: `rejected ${target.id}` });
      }
    }
  });

  function activeListLength(): number {
    if (section === "home") return SECTIONS.length;
    if (section === "model") {
      if (modelView === "menu") return modelMenu().length;
      if (modelView === "provider") return PROVIDERS.length;
      if (modelView === "form") return wizSteps[wizIndex]?.kind === "select" ? (wizSteps[wizIndex] as StepSelect).items.length : 0;
      if (modelView === "profiles" || modelView === "pick-default" || modelView === "pick-profile" || modelView === "pick-remove") return profileItems(cfg).length;
      if (modelView === "pick-persona") return (props.personas ?? []).length;
      return 0;
    }
    if (section === "memory" && !memoryKind) return memoryKinds().length;
    if (section === "proposals" && p) return proposals(p).filter((x) => x.status === "pending").length;
    return 0;
  }

  function modelMenu(): ListItem[] {
    return [
      { value: "add", title: "Add a model", desc: "define a new profile (any provider)" },
      { value: "default", title: "Set the default model", desc: `active now: ${describeModel({ cwd: props.cwd })}` },
      { value: "assign", title: "Assign a model to a persona", desc: "a per-persona override beats the default" },
      { value: "profiles", title: "Profiles", desc: `${profileNames(cfg).length} saved · ${configPath("global")}` },
      { value: "remove", title: "Remove a profile", desc: "also cleans default/persona references" },
    ];
  }

  function memoryKinds(): ListItem[] {
    if (!p) return [];
    const types = readMemoryTypes(loadPersonaFm(p));
    const prefs = Object.entries(readPreferences(p));
    const profile = prefs.filter(([k]) => k.startsWith("user."));
    return [
      { value: "profile", title: "User profile", desc: `${profile.length} stable fact(s), always loaded first`, badge: undefined },
      { value: "episodic", title: "Episodic", desc: `${readMemory(p).length} chained entr(ies)${types.episodic ? "" : " · OFF"}`, badge: undefined },
      { value: "semantic", title: "Semantic (memory.md)", desc: `${readSemanticMemory(p) ? "consolidated, salience-ranked" : "(empty)"}${types.semantic ? "" : " · OFF"}` },
      { value: "procedural", title: "Procedural", desc: `${readProcedural(p).length} how-to(s)${types.procedural ? "" : " · OFF"}` },
      { value: "autobiographical", title: "Autobiographical", desc: `${readAutobiographical(p).length} milestone(s)${types.autobiographical ? "" : " · OFF"}` },
      { value: "preferences", title: "Preferences", desc: `${prefs.length - profile.length} plain preference(s)` },
      { value: "evaluations", title: "Evaluations", desc: `${readEvaluations(p).length} score(s)${types.evaluations ? "" : " · OFF"}` },
    ];
  }

  function activate(index: number): void {
    setToast(null);
    if (section === "home") {
      setSection(SECTIONS[index].value as CenterSection);
      setCursor(0);
      return;
    }
    if (section === "model") {
      // A form select step is handled first: its items are the STEP's items, not
      // one of the profile/menu lists (the fall-through that dropped the choice).
      if (modelView === "form") {
        const step = wizSteps[wizIndex];
        if (step?.kind === "select") advanceWizard(step.id, step.items[index]?.value ?? step.items[0].value);
        return;
      }
      const items =
        modelView === "menu"
          ? modelMenu()
          : modelView === "provider"
            ? PROVIDERS
            : modelView === "pick-persona"
              ? (props.personas ?? []).map((s) => ({ value: s, title: s }))
              : profileItems(cfg);
      const pick = items[index]?.value;
      if (!pick) return;
      if (modelView === "menu") {
        if (pick === "add") setModelView("provider");
        else if (pick === "default") setModelView("pick-default");
        else if (pick === "assign") {
          if (!(props.personas ?? []).length) setToast({ kind: "info", text: "no sub-personas here; the default profile applies to the root persona" });
          else setModelView("pick-persona");
        } else if (pick === "profiles") setModelView("profiles");
        else if (pick === "remove") setModelView("pick-remove");
        setCursor(0);
        return;
      }
      if (modelView === "provider") {
        const kind = pick as ProviderKind;
        setWizKind(kind);
        setWizSteps(stepsFor(kind));
        setWizIndex(0);
        setWizAnswers({});
        setWizInput("");
        setCursor(0); // a select step later reads cursor; start it clean
        setModelView("form");
        return;
      }
      if (modelView === "pick-default") {
        saveConfig(setDefaultProfile(loadConfig("global"), pick), "global");
        setToast({ kind: "ok", text: `default model → "${pick}"` });
        setModelView("menu");
        return;
      }
      if (modelView === "pick-persona") {
        setPendingPersona(pick);
        setModelView("pick-profile");
        setCursor(0);
        return;
      }
      if (modelView === "pick-profile" && pendingPersona) {
        saveConfig(assignProfileToPersona(loadConfig("global"), pendingPersona, pick), "global");
        setToast({ kind: "ok", text: `${pendingPersona} → "${pick}"` });
        setPendingPersona(null);
        setModelView("menu");
        return;
      }
      if (modelView === "pick-remove") {
        saveConfig(removeProfile(loadConfig("global"), pick), "global");
        setToast({ kind: "warn", text: `removed "${pick}" (references cleaned)` });
        setModelView("menu");
        return;
      }
      return;
    }
    if (section === "memory" && !memoryKind) {
      setMemoryKind(memoryKinds()[index]?.value ?? null);
      setCursor(0);
    }
  }

  function advanceWizard(id: string, value: string): void {
    const answers = { ...wizAnswers, [id]: value };
    setWizAnswers(answers);
    const next = nextStepIndex(wizSteps, wizIndex, answers);
    if (next >= wizSteps.length) return finishWizard(answers);
    setWizIndex(next);
    setWizInput("");
    setCursor(0);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const hints: KeyHint[] =
    section === "home"
      ? [
          { key: "↑/↓", label: "move" },
          { key: "enter", label: "open" },
          { key: "1-7", label: "jump" },
          { key: "q/esc", label: "quit" },
        ]
      : [
          { key: "↑/↓", label: "move" },
          { key: "enter", label: "select" },
          { key: "tab", label: "next section" },
          { key: "esc", label: "back" },
          ...(section === "proposals" ? [{ key: "a/r", label: "approve/reject" }] : []),
        ];

  const crumb =
    section === "home"
      ? undefined
      : section === "model" && modelView !== "menu"
        ? `Model › ${modelView === "form" ? `${wizKind} profile` : modelView.replace("pick-", "")}`
        : section === "memory" && memoryKind
          ? `Memory › ${memoryKind}`
          : SECTIONS.find((s) => s.value === section)?.title;

  return (
    <AppFrame title="command center" breadcrumb={crumb} hints={hints}>
      {toast ? <Toast kind={toast.kind} text={toast.text} /> : null}
      {section === "home" ? (
        <SelectList items={SECTIONS} index={cursor} />
      ) : section === "model" ? (
        <ModelSection
          view={modelView}
          cursor={cursor}
          cfg={cfg}
          personas={props.personas ?? []}
          steps={wizSteps}
          stepIndex={wizIndex}
          input={wizInput}
          answers={wizAnswers}
          menu={modelMenu()}
          onInput={setWizInput}
          onSubmitText={(v) => {
            const step = wizSteps[wizIndex] as StepText;
            advanceWizard(step.id, v.trim() || step.def || "");
          }}
        />
      ) : section === "drift" && p ? (
        <DriftView personaPath={p} report={null} active={false} onBack={back} />
      ) : section === "state" && p ? (
        <StateSection personaPath={p} />
      ) : section === "audit" && p ? (
        <AuditSection personaPath={p} />
      ) : section === "memory" && p ? (
        <MemorySection personaPath={p} kind={memoryKind} kinds={memoryKinds()} cursor={cursor} />
      ) : section === "proposals" && p ? (
        <ProposalsSection personaPath={p} cursor={cursor} />
      ) : section === "fleet" ? (
        <FleetSection personaPath={p} personas={props.personas ?? []} />
      ) : (
        <Text dimColor>{"  no persona here (run `personaxis init` or enter a project with .personaxis/)"}</Text>
      )}
    </AppFrame>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

function loadPersonaFm(personaPath: string): PersonaFrontmatter {
  try {
    return loadPersona(personaPath).frontmatter;
  } catch {
    return {} as PersonaFrontmatter;
  }
}

function ModelSection(props: {
  view: ModelView;
  cursor: number;
  cfg: PersonaxisConfig;
  personas: string[];
  steps: Step[];
  stepIndex: number;
  input: string;
  answers: Record<string, string>;
  menu: ListItem[];
  onInput: (v: string) => void;
  onSubmitText: (v: string) => void;
}): React.JSX.Element {
  const { view } = props;
  if (view === "menu") return <SelectList items={props.menu} index={props.cursor} />;
  if (view === "provider") return <SelectList items={PROVIDERS} index={props.cursor} />;
  if (view === "form") {
    const step = props.steps[props.stepIndex];
    const done = props.steps.slice(0, props.stepIndex).filter((s) => props.answers[s.id] !== undefined);
    return (
      <Box flexDirection="column">
        {done.length ? (
          <Box flexDirection="column" marginBottom={1}>
            {done.map((s) => (
              <Text key={s.id} dimColor>{`  ✓ ${s.label}: ${s.id.toLowerCase().includes("inline") ? "***" : props.answers[s.id] || "(default)"}`}</Text>
            ))}
          </Box>
        ) : null}
        {step.kind === "text" ? (
          <Field
            label={step.label}
            help={step.help}
            placeholder={step.def}
            value={props.input}
            active
            secret={step.secret}
            onChange={props.onInput}
            onSubmit={props.onSubmitText}
          />
        ) : (
          <Box flexDirection="column">
            <Text bold>{"  " + step.label}</Text>
            <SelectList items={step.items} index={props.cursor} />
          </Box>
        )}
      </Box>
    );
  }
  // profiles / pick-default / pick-profile / pick-remove / pick-persona
  if (view === "pick-persona") {
    return <SelectList items={props.personas.map((s) => ({ value: s, title: s }))} index={props.cursor} dense />;
  }
  const items = profileItems(props.cfg);
  return items.length ? (
    <SelectList items={items} index={props.cursor} />
  ) : (
    <Text dimColor>{"  no profiles yet. Esc back, then 'Add a model'."}</Text>
  );
}

function StateSection(props: { personaPath: string }): React.JSX.Element {
  try {
    const handle = loadPersona(props.personaPath);
    const fm = handle.frontmatter;
    const st = readState(handle.statePath);
    const env = extractEnvelopes(fm);
    const theme = personaTheme(fm);
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{displayName(fm)}</Text>
          <Text dimColor>{`  ·  ${Object.keys(st.values).length} live value(s)  ·  ${st.mutation_log.length} mutation(s)`}</Text>
        </Text>
        <Text> </Text>
        <Text>{sigilLines(theme, st.values, 0).join("\n")}</Text>
        <Text> </Text>
        <Text>{envelopeBars(theme, st.values, env.envelopes)}</Text>
      </Box>
    );
  } catch (e) {
    return <Text dimColor>{`  state unavailable: ${(e as Error).message}`}</Text>;
  }
}

function AuditSection(props: { personaPath: string }): React.JSX.Element {
  try {
    const st = readState(loadPersona(props.personaPath).statePath);
    const chain = verifyMemoryChain(props.personaPath);
    const ledger = proposals(props.personaPath);
    return (
      <Box flexDirection="column">
        <Text>
          {"memory chain: "}
          {chain.ok ? <Text color="green">intact ✓</Text> : <Text color="red">{`broken at #${chain.brokenAt}`}</Text>}
          <Text dimColor>{`   ·   self-edits: ${ledger.length} (${ledger.filter((x) => x.status === "pending").length} pending)`}</Text>
        </Text>
        <Text> </Text>
        <Text bold>{"Mutation log (last 12)"}</Text>
        {st.mutation_log.slice(-12).map((m, i) => (
          <Text key={i} dimColor>{`  ${m.ts}  ${m.field}: ${m.from} → ${m.to}${m.clamped ? "  clamped" : ""}`}</Text>
        ))}
        {st.mutation_log.length === 0 ? <Text dimColor>{"  (no mutations yet)"}</Text> : null}
      </Box>
    );
  } catch (e) {
    return <Text dimColor>{`  audit unavailable: ${(e as Error).message}`}</Text>;
  }
}

function MemorySection(props: { personaPath: string; kind: string | null; kinds: ListItem[]; cursor: number }): React.JSX.Element {
  const p = props.personaPath;
  if (!props.kind) return <SelectList items={props.kinds} index={props.cursor} />;
  const rows: string[] = (() => {
    switch (props.kind) {
      case "profile":
        return Object.entries(readPreferences(p))
          .filter(([k]) => k.startsWith("user."))
          .map(([k, v]) => `${k.slice(5)} = ${v.value}   (${v.ts.slice(0, 10)})`);
      case "episodic":
        return readMemory(p).slice(-40).map((m) => `${m.ts.slice(0, 19)} [${m.source}] ${m.content.slice(0, 90)}`);
      case "semantic":
        return readSemanticMemory(p).split("\n").filter(Boolean);
      case "procedural":
        return readProcedural(p).map((x) => `${x.task} → ${x.procedure.slice(0, 70)}`);
      case "autobiographical":
        return readAutobiographical(p).map((x) => `${x.ts.slice(0, 10)}  ${x.event}${x.detail ? `: ${x.detail}` : ""}`);
      case "preferences":
        return Object.entries(readPreferences(p))
          .filter(([k]) => !k.startsWith("user."))
          .map(([k, v]) => `${k} = ${v.value}`);
      case "evaluations":
        return readEvaluations(p).slice(-40).map((e) => `${e.target} ${e.dimension} ${e.score.toFixed(2)}  ${e.rationale.slice(0, 50)}`);
      default:
        return [];
    }
  })();
  return (
    <Box flexDirection="column">
      {rows.length ? rows.slice(-30).map((r, i) => <Text key={i} dimColor={!r.startsWith("#")}>{`  ${r}`}</Text>) : <Text dimColor>{"  (empty)"}</Text>}
    </Box>
  );
}

function ProposalsSection(props: { personaPath: string; cursor: number }): React.JSX.Element {
  const pending = proposals(props.personaPath).filter((x) => x.status === "pending");
  if (!pending.length) return <Text dimColor>{"  no pending self-edits. The persona proposes; you decide (a approve · r reject)."}</Text>;
  return (
    <SelectList
      items={pending.map((x) => ({
        value: x.id,
        title: `${x.id}  ${x.targetPath}`,
        desc: `${JSON.stringify(x.toValue).slice(0, 80)}  ·  ${x.rationale.slice(0, 60)}`,
      }))}
      index={props.cursor}
    />
  );
}

function FleetSection(props: { personaPath?: string; personas: string[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{"Personas in this project"}</Text>
      <Text dimColor>{props.personaPath ? `  root: ${props.personaPath}` : "  (no root persona)"}</Text>
      {props.personas.length ? (
        props.personas.map((s) => <Text key={s}>{`  @${s}`}</Text>)
      ) : (
        <Text dimColor>{"  no sub-personas"}</Text>
      )}
      <Text> </Text>
      <Text dimColor>{"  live status (awake/idle, drift, model, active task) lands with `personaxis ps` (V2-F4)."}</Text>
    </Box>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runCommandCenter(opts: {
  personaPath?: string;
  personas?: string[];
  cwd?: string;
  section?: CenterSection;
}): Promise<void> {
  await runFullscreen(
    <CommandCenter
      personaPath={opts.personaPath}
      personas={opts.personas}
      cwd={opts.cwd ?? process.cwd()}
      initialSection={opts.section ?? "home"}
    />,
  );
}
