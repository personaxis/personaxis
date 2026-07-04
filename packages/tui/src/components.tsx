/**
 * Ink 7 components (FR.3). `visual.ts` stays the single source of the brand
 * identity — its functions are pure `(theme, values, frame) → string`, so each
 * component is a thin wrapper: ZERO visual change from the pre-Ink dashboard.
 */

import React, { useEffect, useState } from "react";
import { Box, Text, Static } from "ink";
import {
  loadPersona,
  readState,
  extractEnvelopes,
  verifyMemoryChain,
  readMemory,
  personaTheme,
  displayName,
  type PersonaTheme,
} from "@personaxis/core";
import { sigilLines, auraBar, envelopeBars } from "./visual.js";

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
}

interface DashFrame {
  name: string;
  theme: PersonaTheme;
  values: Record<string, number>;
  envelopes: Parameters<typeof envelopeBars>[2];
  mutations: number;
  memories: number;
  chainOk: boolean;
}

function readFrame(personaPath: string): DashFrame {
  const handle = loadPersona(personaPath);
  const state = readState(handle.statePath);
  return {
    name: displayName(handle.frontmatter),
    theme: personaTheme(handle.frontmatter),
    values: state.values,
    envelopes: extractEnvelopes(handle.frontmatter).envelopes,
    mutations: state.mutation_log.length,
    memories: readMemory(handle.personaPath).length,
    chainOk: verifyMemoryChain(handle.personaPath).ok,
  };
}

/**
 * The live dashboard as an Ink app. Reads state.json each frame (same contract
 * as the pre-Ink loop), so evolution in ANOTHER process (REPL, MCP, HTTP)
 * shows up live.
 */
export function Dashboard(props: DashboardProps): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  const [data, setData] = useState<DashFrame>(() => readFrame(props.personaPath));

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
      <Sigil theme={data.theme} values={data.values} frame={frame} />
      <Text> </Text>
      <EnvelopeBars theme={data.theme} values={data.values} envelopes={data.envelopes} />
      <Text> </Text>
      <Text dimColor>
        {`mutations ${data.mutations}  ·  memory ${data.memories}  ·  chain `}
        {data.chainOk ? <Text color="green">intact</Text> : <Text color="red">BROKEN</Text>}
        {`  ·  frame ${frame}`}
      </Text>
    </Box>
  );
}
