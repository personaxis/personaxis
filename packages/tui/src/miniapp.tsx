/**
 * Miniapp building blocks (V5.P1.1): the pieces every full-height REPL view
 * (Settings, Persona, Audit, Skills, Resume, ...) is assembled from, so the
 * whole app shares ONE navigation language:
 *
 *   NavBar     horizontal tabs (Settings-style):  Status  [Config]  Usage  Stats
 *   SubNavBar  a second, lighter tab row (e.g. Stats > Overview | Models)
 *   Table      aligned key/value or columnar rows with an optional cursor
 *
 * All presentational; the host view owns state and keyboard handling.
 */

import React from "react";
import { Box, Text } from "ink";

export interface NavBarProps {
  tabs: string[];
  active: number;
  /** Dim variant for sub-navigation rows. */
  subtle?: boolean;
}

/** Horizontal tab row; the active tab renders inverse (or bold when subtle). */
export function NavBar({ tabs, active, subtle = false }: NavBarProps): React.JSX.Element {
  return (
    <Box gap={1} marginBottom={subtle ? 0 : 1}>
      {tabs.map((t, i) =>
        i === active ? (
          <Text key={t} inverse={!subtle} bold color={subtle ? "cyan" : undefined}>
            {` ${t} `}
          </Text>
        ) : (
          <Text key={t} dimColor>
            {` ${t} `}
          </Text>
        ),
      )}
    </Box>
  );
}

export function SubNavBar(props: Omit<NavBarProps, "subtle">): React.JSX.Element {
  return <NavBar {...props} subtle />;
}

export interface TableRow {
  cells: string[];
  /** Render dim (secondary information). */
  dim?: boolean;
  /** Color name for the first cell (e.g. "green" for ✓ rows). */
  color?: string;
}

export interface TableProps {
  rows: TableRow[];
  /** Column minimum widths; cells pad to these (last column free-flows). */
  widths?: number[];
  /** Index of the row the cursor sits on (renders ❯ + inverse); -1 for none. */
  cursor?: number;
  indent?: number;
}

/** Aligned rows with an optional selection cursor. */
export function Table({ rows, widths = [], cursor = -1, indent = 2 }: TableProps): React.JSX.Element {
  const pad = " ".repeat(indent);
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => {
        const line = r.cells
          .map((c, j) => (j < r.cells.length - 1 ? c.padEnd(widths[j] ?? c.length + 2) : c))
          .join(" ");
        const selected = i === cursor;
        return (
          <Text key={i} inverse={selected} dimColor={r.dim && !selected} color={selected ? undefined : (r.color as never)}>
            {pad}
            {selected ? "❯ " : "  "}
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
