/**
 * Ink 7 components (FR.3). `visual.ts` stays the single source of the brand
 * identity — its functions are pure `(theme, values, frame) → string`, so each
 * component is a thin wrapper: ZERO visual change from the pre-Ink dashboard.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import {
  loadPersona,
  readState,
  extractEnvelopes,
  verifyMemoryChain,
  readMemory,
  personaTheme,
  displayName,
  driftReport,
  readMaxStepDelta,
  type PersonaTheme,
  type CoordinateDrift,
} from "@personaxis/core";
import { sigilLines, auraBar, envelopeBars, envelopeRow, sparkline } from "./visual.js";

// ── brand components (pure wrappers over visual.ts) ─────────────────────────

export function Sigil(props: { theme: PersonaTheme; values: Record<string, number>; frame?: number }): React.JSX.Element {
  return <Text>{sigilLines(props.theme, props.values, props.frame ?? 0).join("\n")}</Text>;
}

export function AuraBar(props: { theme: PersonaTheme; values: Record<string, number>; frame?: number }): React.JSX.Element {
  return <Text>{auraBar(props.theme, props.values, props.frame ?? 0)}</Text>;
}

export function EnvelopeBars(props: {
  theme: PersonaTheme;
  values: Record<string, number>;
  envelopes: Parameters<typeof envelopeBars>[2];
}): React.JSX.Element {
  return <Text>{envelopeBars(props.theme, props.values, props.envelopes)}</Text>;
}

// ── transcript (the streaming architecture) ─────────────────────────────────

export interface TranscriptProps {
  /** Committed lines — rendered ONCE into native scrollback via <Static>. */
  committed: string[];
  /** The bounded live region (in-flight tokens, spinner line, dials). */
  live?: string;
}

/**
 * `<Static>` for the terminated transcript (never re-rendered — the Ink-
 * documented mitigation for long histories) + a bounded live region below.
 * The CommitQueue decides WHEN a line moves from live to committed.
 */
export function Transcript(props: TranscriptProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Static items={props.committed}>{(line, i) => <Text key={i}>{line}</Text>}</Static>
      {props.live ? <Text>{props.live}</Text> : null}
    </Box>
  );
}

// ── the living dashboard ─────────────────────────────────────────────────────

export interface DashboardProps {
  personaPath: string;
  intervalMs?: number;
  /** Stop after N frames (tests/demos); omit to run until unmount. */
  maxFrames?: number;
  /** F6.7b: keyboard drill-down (↑/↓ select · Enter inspect · Esc back · q quit). */
  interactive?: boolean;
}

interface LogEntry {
  ts?: string;
  field?: string;
  from?: number;
  to?: number;
  actor?: string;
  clamped?: boolean;
  blocked?: boolean;
  reason?: string;
}

interface DashFrame {
  name: string;
  theme: PersonaTheme;
  values: Record<string, number>;
  envelopes: ReturnType<typeof extractEnvelopes>["envelopes"];
  drift: CoordinateDrift[];
  log: LogEntry[];
  mutations: number;
  memories: number;
  chainOk: boolean;
}

function readFrame(personaPath: string): DashFrame {
  const handle = loadPersona(personaPath);
  const state = readState(handle.statePath);
  const lookup = extractEnvelopes(handle.frontmatter);
  const report = driftReport({
    values: state.values,
    envelopes: lookup.envelopes,
    maxStepDelta: readMaxStepDelta(handle.frontmatter),
    protectedFields: lookup.protectedFields,
  });
  return {
    name: displayName(handle.frontmatter),
    theme: personaTheme(handle.frontmatter),
    values: state.values,
    envelopes: lookup.envelopes,
    drift: report.coordinates,
    log: state.mutation_log as LogEntry[],
    mutations: state.mutation_log.length,
    memories: readMemory(handle.personaPath).length,
    chainOk: verifyMemoryChain(handle.personaPath).ok,
  };
}

/** The drill-down detail for one coordinate (F6.7b). Pure render helper. */
export function CoordinateDetail(props: { frame: DashFrame; field: string }): React.JSX.Element {
  const { frame, field } = props;
  const e = frame.envelopes[field];
  const d = frame.drift.find((c) => c.field === field);
  const history = frame.log.filter((l) => l.field === field && typeof l.to === "number");
  const series = [e?.mean ?? 0, ...history.map((l) => l.to as number)];
  const recent = history.slice(-5).reverse();
  return (
    <Box flexDirection="column">
      <Text bold color="cyanBright">
        {field}
      </Text>
      {e && d ? (
        <>
          <Text>
            {"  value "}
            <Text bold>{d.value.toFixed(3)}</Text>
            <Text dimColor>{`  ·  u ${d.u >= 0 ? "+" : ""}${d.u.toFixed(2)}  ·  band `}</Text>
            <Text bold>{d.band}</Text>
            <Text dimColor>{`  ·  envelope [${e.min}, ${e.max}] mean ${e.mean}`}</Text>
          </Text>
          <Text>
            {"  next band: "}
            {d.protected ? (
              <Text color="magenta">immutable: backs a hard virtue; no runtime actor may move it (T3 = ∞)</Text>
            ) : d.decayAssisted ? (
              <Text dimColor>recovery exit: homeostatic decay can cross it; every decay step is an audited runtime-decay entry (adversarial floor ≥{String(d.minStepsToCross)})</Text>
            ) : (
              <Text>
                <Text bold>{String(d.minStepsToCross)}</Text>
                <Text dimColor> audited step(s) minimum: every one a chained mutation_log entry (T3)</Text>
              </Text>
            )}
          </Text>
          <Text>
            {"  history  "}
            <Text color="cyan">{sparkline(series, e.min, e.max)}</Text>
            <Text dimColor>{`  ${String(history.length)} mutation(s)`}</Text>
          </Text>
        </>
      ) : (
        <Text dimColor>{"  no envelope declared for this key"}</Text>
      )}
      {recent.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {recent.map((l, i) => (
            <Text key={i} dimColor>
              {"  "}
              {(l.ts ?? "").slice(0, 19).replace("T", " ")} {(l.from ?? 0).toFixed(3)}→{(l.to ?? 0).toFixed(3)} [{l.actor ?? "?"}]{l.clamped ? " clamped" : ""}
              {l.blocked ? " blocked" : ""} {l.reason ? `— ${l.reason.slice(0, 40)}` : ""}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>{"\n  Esc back · q quit"}</Text>
    </Box>
  );
}

/**
 * FASE 7 P2 — the drift drill-down as an EMBEDDABLE view (the REPL mounts it
 * full-height; `personaxis dash` keeps its own Dashboard shell). Keys: ↑/↓
 * select a coordinate, Enter opens its detail, Esc walks detail -> list ->
 * `onBack()`. `report` (from the loop's drift event) supplies u/band/T3 rows
 * without touching disk; the frame re-read only feeds the sparkline/log detail.
 */
export function DriftView(props: {
  personaPath: string;
  report: CoordinateDriftReport | null;
  active: boolean;
  onBack: () => void;
}): React.JSX.Element {
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);
  const [frame, setFrame] = useState<DashFrame | null>(null);

  // One frame read on mount / detail open (sparkline + log need the file).
  useEffect(() => {
    if (!props.personaPath) return;
    try {
      setFrame(readFrame(props.personaPath));
    } catch {
      setFrame(null);
    }
  }, [props.personaPath, detail]);

  const coords = props.report?.coordinates ?? frame?.drift ?? [];

  useInput(
    (_ch, key) => {
      if (key.escape) {
        if (detail) setDetail(null);
        else props.onBack();
        return;
      }
      if (detail) {
        if (key.return) setDetail(null);
        return;
      }
      if (key.upArrow) setCursor((c) => (c + coords.length - 1) % Math.max(1, coords.length));
      else if (key.downArrow) setCursor((c) => (c + 1) % Math.max(1, coords.length));
      else if (key.return && coords.length) setDetail(coords[Math.min(cursor, coords.length - 1)].field);
    },
    { isActive: props.active },
  );

  if (detail && frame) {
    return (
      <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
        <CoordinateDetail frame={frame} field={detail} />
      </Box>
    );
  }

  const gaugeWidth = 24;
  const global = props.report?.global ?? 0;
  const filled = Math.round(Math.min(1, global) * gaugeWidth);
  const over = (props.report?.layers ?? []).filter((l) => l.exceeded);
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Text bold>
        {"drift  "}
        <Text color={over.length ? "red" : "cyanBright"}>{"▰".repeat(filled)}</Text>
        <Text dimColor>{"▱".repeat(gaugeWidth - filled)}</Text>
        {`  D ${global.toFixed(2)}`}
        {over.length ? <Text color="red">{`  ⚠ ${over.map((l) => l.layer).join(", ")}`}</Text> : <Text dimColor>{"  within all thresholds"}</Text>}
      </Text>
      <Text> </Text>
      {coords.length === 0 ? (
        <Text dimColor>{"  no drift data yet — say something and the loop will report after its tick"}</Text>
      ) : (
        coords.map((c, i) => {
          const selected = i === Math.min(cursor, coords.length - 1);
          const dir = c.u > 0 ? "+" : c.u < 0 ? "−" : " ";
          const cost = c.protected
            ? "immutable"
            : c.decayAssisted
              ? "recovery exit (decay-assisted, audited)"
              : `≥${c.minStepsToCross} step(s) to cross`;
          return (
            <Text key={c.field} color={selected ? "cyanBright" : undefined} dimColor={!selected}>
              {selected ? "▸ " : "  "}
              {c.field.padEnd(38)} u {dir}
              {Math.abs(c.u).toFixed(2)} {c.band.padEnd(8)} {cost}
            </Text>
          );
        })
      )}
      <Text> </Text>
      <Text dimColor>{"  ↑/↓ select · Enter inspect · Esc back"}</Text>
    </Box>
  );
}

interface CoordinateDriftReport {
  global: number;
  coordinates: CoordinateDrift[];
  layers: Array<{ layer: string; drift: number; threshold?: number; exceeded: boolean }>;
}

/**
 * The live dashboard as an Ink app. Reads state.json each frame (same contract
 * as the pre-Ink loop), so evolution in ANOTHER process (REPL, MCP, HTTP)
 * shows up live.
 */
export function Dashboard(props: DashboardProps): React.JSX.Element {
  const { exit } = useApp();
  const [frame, setFrame] = useState(0);
  const [data, setData] = useState<DashFrame>(() => readFrame(props.personaPath));
  const [cursor, setCursor] = useState(0);
  const [detail, setDetail] = useState<string | null>(null);

  const coords = Object.keys(data.values).filter((k) => data.envelopes[k]);

  useInput(
    (input, key) => {
      if (input === "q") return exit();
      if (detail) {
        if (key.escape || key.return) setDetail(null);
        return;
      }
      if (key.upArrow) return setCursor((c) => (c + coords.length - 1) % Math.max(1, coords.length));
      if (key.downArrow) return setCursor((c) => (c + 1) % Math.max(1, coords.length));
      if (key.return && coords.length) return setDetail(coords[Math.min(cursor, coords.length - 1)]);
    },
    { isActive: props.interactive === true },
  );

  useEffect(() => {
    if (props.maxFrames !== undefined && frame >= props.maxFrames) return;
    const t = setTimeout(() => {
      setFrame((f) => f + 1);
      try {
        setData(readFrame(props.personaPath));
      } catch {
        /* a mid-write read races with another process — keep the last frame */
      }
    }, props.intervalMs ?? 500);
    return () => clearTimeout(t);
  }, [frame, props.personaPath, props.intervalMs, props.maxFrames]);

  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Box>
        <Text bold color="cyanBright">
          {data.name}
        </Text>
        <Text dimColor>
          {"  ·  sigil #"}
          {data.theme.seed.toString(16)}
          {"  ·  "}
        </Text>
        <AuraBar theme={data.theme} values={data.values} frame={frame} />
      </Box>
      <Text> </Text>
      {detail ? (
        <CoordinateDetail frame={data} field={detail} />
      ) : (
        <>
          <Sigil theme={data.theme} values={data.values} frame={frame} />
          <Text> </Text>
          {props.interactive ? (
            <Text>
              {coords
                .map((k, i) => envelopeRow(data.theme, k, data.values[k], data.envelopes[k], 18, i === Math.min(cursor, coords.length - 1)))
                .join("\n")}
            </Text>
          ) : (
            <EnvelopeBars theme={data.theme} values={data.values} envelopes={data.envelopes} />
          )}
        </>
      )}
      <Text> </Text>
      <Text dimColor>
        {`mutations ${data.mutations}  ·  memory ${data.memories}  ·  chain `}
        {data.chainOk ? <Text color="green">intact</Text> : <Text color="red">BROKEN</Text>}
        {`  ·  frame ${frame}`}
        {props.interactive && !detail ? "  ·  ↑/↓ select · Enter inspect · q quit" : ""}
      </Text>
    </Box>
  );
}
