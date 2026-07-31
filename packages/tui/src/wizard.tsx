/**
 * Genesis interview wizard (F6.7b), the Ink front-end over the PURE interview
 * engine (`@personaxis/core` genesis/interview.ts owns every answer→number
 * mapping; this file owns ONLY the keys and the pixels). The wow is honesty
 * made visible: every answer immediately shows the exact field and named rule
 * it will map to, so "every number earned" is something the user watches
 * happen. Falls back to the CLI's readline path when Ink can't run (no TTY).
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  likertToMean,
  confidenceToHalfWidth,
  rankToWeight,
  type InterviewItem,
  type InterviewAnswers,
} from "@personaxis/core";

const LIKERT_ANCHORS = ["strongly disagree", "disagree", "neutral", "agree", "strongly agree"];

/** One recorded step of the visible evidence trail. */
interface TrailLine {
  id: string;
  text: string;
  skipped: boolean;
}

function progressBar(done: number, total: number, width = 24): string {
  const filled = Math.round((done / Math.max(1, total)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** The mapping preview for the CURRENT selection (mirrors interview.ts rules). */
function preview(item: InterviewItem, sel: { likert: number; choice: number; rank: string[]; text: string }): string {
  switch (item.kind) {
    case "likert":
      return item.id === "t-conf"
        ? `range half-width ±${confidenceToHalfWidth(sel.likert).toFixed(2)}`
        : `mean ${likertToMean(sel.likert).toFixed(2)}`;
    case "rank":
      return sel.rank.length
        ? sel.rank.map((v, i) => `${v}=${rankToWeight(i).toFixed(2)}`).join("  ")
        : "weights 0.95, 0.91, 0.87, … by rank";
    case "choice":
      return item.options?.[sel.choice] ?? "";
    default:
      return sel.text ? "recorded verbatim" : "";
  }
}

/**
 * A short, concrete example for the current question (V7.A4). Item-specific when the
 * bank provides one, otherwise a sensible shape hint per question kind.
 */
function exampleFor(item: InterviewItem): string {
  const own = (item as { example?: string }).example;
  if (own) return own;
  switch (item.kind) {
    case "likert":
      return "4 = agree · press 1-5 or use ←/→";
    case "choice":
      return "pick with ↑/↓, confirm with Enter";
    case "rank":
      return "Enter picks the next most important, u undoes, d finishes";
    default:
      return "a phrase or two, in your own words";
  }
}

export interface InterviewWizardProps {
  items: InterviewItem[];
  onDone: (answers: InterviewAnswers) => void;
  /** Called after every recorded answer, so a caller can persist progress as it happens. */
  onProgress?: (answers: InterviewAnswers) => void;
}

export function InterviewWizard(props: InterviewWizardProps): React.JSX.Element {
  const { exit } = useApp();
  const [idx, setIdx] = useState(0);
  const [answers] = useState<InterviewAnswers>({});
  const [trail, setTrail] = useState<TrailLine[]>([]);
  const [likert, setLikert] = useState(3);
  const [choice, setChoice] = useState(0);
  const [rankPicked, setRankPicked] = useState<string[]>([]);
  const [rankCursor, setRankCursor] = useState(0);
  const [text, setText] = useState("");
  const [finished, setFinished] = useState(false);
  // V7.A4: leaving is a decision, never a slip. Esc asks; it no longer skips.
  const [confirmQuit, setConfirmQuit] = useState(false);
  /**
   * V7.A4: keystrokes already sitting in the buffer when the wizard mounts (the Enter
   * that launched `/create`, a stray key from the parent process) used to be consumed
   * by the first question, which is why "cualquier tecla" seemed to advance it and why
   * typing needed an extra Enter first. We ignore input for the first beat.
   */
  const [armed, setArmed] = useState(process.env.PERSONAXIS_NO_ANIM === "1");
  useEffect(() => {
    if (armed) return; // deterministic runs (tests/CI) have no stray buffer to drain
    const t = setTimeout(() => setArmed(true), 120);
    return () => clearTimeout(t);
  }, [armed]);

  const item = props.items[idx];
  const sel = { likert, choice, rank: rankPicked, text };

  const resetFields = (): void => {
    setLikert(3);
    setChoice(0);
    setRankPicked([]);
    setRankCursor(0);
    setText("");
  };

  const advance = (recorded: string | number | string[] | undefined): void => {
    if (item) {
      if (recorded !== undefined) answers[item.id] = recorded;
      const line: TrailLine =
        recorded === undefined
          ? { id: item.id, text: `${item.construct}, skipped (no evidence, default will be labeled)`, skipped: true }
          : { id: item.id, text: `${item.construct} ← ${preview(item, sel) || String(recorded)}  · rule ${item.rule}`, skipped: false };
      setTrail((t) => [...t.slice(-4), line]);
      // Persist after every answer, not at the end: an interview abandoned at question 17
      // should not cost the sixteen answers already given.
      props.onProgress?.({ ...answers });
    }
    resetFields();
    if (idx + 1 >= props.items.length) setFinished(true);
    else setIdx(idx + 1);
  };

  /** V7.A4: go back one question and drop what it recorded, so it can be re-answered. */
  const goBack = (): void => {
    if (idx === 0) return;
    const prev = props.items[idx - 1];
    if (prev) delete answers[prev.id];
    setTrail((t) => t.slice(0, -1));
    resetFields();
    setIdx(idx - 1);
  };

  useInput((input, key) => {
    // V7.A4: swallow whatever was already queued when we mounted.
    if (!armed) return;
    if (finished) {
      props.onDone(answers);
      exit();
      return;
    }
    if (!item) return;

    // Esc = "do you want to leave?", answered with y/n. It never skips a question
    // Esc must not silently skip a question; `s` is the only skip.
    if (confirmQuit) {
      if (input === "y" || input === "Y") {
        props.onDone(answers);
        exit();
        return;
      }
      setConfirmQuit(false);
      return;
    }
    if (key.escape) return setConfirmQuit(true);
    // Going back: the left arrow works everywhere it is not already taken (likert uses
    // it to move the scale); `b` is the shortcut ONLY where it cannot be a letter the
    // user meant to type, so a text answer like "bien" still types normally.
    if (key.leftArrow && item.kind !== "likert") return goBack();
    if (input === "b" && item.kind !== "text") return goBack();

    if (item.kind === "likert") {
      // ←/→ belong to the scale here; `b` is the way back (handled above).
      if (key.leftArrow) return setLikert((v) => Math.max(1, v - 1));
      if (key.rightArrow) return setLikert((v) => Math.min(5, v + 1));
      if (/^[1-5]$/.test(input)) return setLikert(Number(input));
      if (input === "s") return advance(undefined);
      if (key.return) return advance(likert);
      return; // every other key is ignored: nothing advances by accident
    }
    if (item.kind === "choice") {
      const n = item.options?.length ?? 0;
      if (key.upArrow) return setChoice((v) => (v + n - 1) % n);
      if (key.downArrow) return setChoice((v) => (v + 1) % n);
      if (/^[1-9]$/.test(input) && Number(input) <= n) return setChoice(Number(input) - 1);
      if (input === "s") return advance(undefined);
      if (key.return) return advance(choice);
      return; // ignored, including digits out of range
    }
    if (item.kind === "rank") {
      const remaining = (item.candidates ?? []).filter((c) => !rankPicked.includes(c));
      if (key.upArrow) return setRankCursor((v) => (v + remaining.length - 1) % Math.max(1, remaining.length));
      if (key.downArrow) return setRankCursor((v) => (v + 1) % Math.max(1, remaining.length));
      if (input === "u" && rankPicked.length) {
        setRankPicked((p) => p.slice(0, -1));
        return setRankCursor(0);
      }
      if (input === "s") return advance(undefined);
      if (key.return) {
        if (remaining.length === 0) return advance(rankPicked);
        const picked = remaining[Math.min(rankCursor, remaining.length - 1)];
        const next = [...rankPicked, picked];
        if (next.length === (item.candidates ?? []).length) return advance(next);
        setRankPicked(next);
        return setRankCursor(0);
      }
      if (input === "d" && rankPicked.length) return advance(rankPicked);
      return;
    }
    // text: everything typable goes into the answer, so `s` alone on an empty field
    // means skip, but "something" keeps its s.
    if (key.return) return advance(text.trim() ? text.trim() : undefined);
    if (key.backspace || key.delete) return setText((t) => t.slice(0, -1));
    if (input === "s" && text.length === 0) return advance(undefined);
    if (input && !key.ctrl && !key.meta) setText((t) => t + input);
  });

  if (finished) {
    const answered = Object.keys(answers).length;
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
        <Text bold>◉ personaxis · Genesis interview, done</Text>
        <Text>
          {"  "}
          <Text color="green">{String(answered)}</Text> answered · <Text dimColor>{String(props.items.length - answered)} skipped (skips become LABELED defaults in the creation report)</Text>
        </Text>
        <Text dimColor>{"  press any key to build the persona"}</Text>
      </Box>
    );
  }
  if (!item) return <Text />;

  const remaining = (item.candidates ?? []).filter((c) => !rankPicked.includes(c));
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Box>
        <Text bold>◉ personaxis · Genesis interview </Text>
        <Text dimColor>
          {progressBar(idx, props.items.length)} {String(idx + 1)}/{String(props.items.length)}
        </Text>
      </Box>
      {trail.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {trail.map((l) => (
            <Text key={l.id} dimColor>
              {"  "}
              {l.skipped ? "○" : "✓"} {l.text}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="cyan" bold>
          {item.question}
        </Text>
      </Box>
      {/* V7.A4: a short example under every question, so nobody has to guess the shape
          of the answer (short example answers shown alongside each question). */}
      {exampleFor(item) ? (
        <Text dimColor>{`  e.g. ${exampleFor(item)}`}</Text>
      ) : null}

      {item.kind === "likert" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {"  "}
            {[1, 2, 3, 4, 5].map((n) => (
              <Text key={n} color={n === likert ? "cyanBright" : undefined} dimColor={n !== likert} bold={n === likert}>
                {n === likert ? ` [${n}] ` : `  ${n}  `}
              </Text>
            ))}
            <Text dimColor> {LIKERT_ANCHORS[likert - 1]}</Text>
          </Text>
        </Box>
      )}
      {item.kind === "choice" && (
        <Box flexDirection="column" marginTop={1}>
          {(item.options ?? []).map((o, i) => (
            <Text key={o} color={i === choice ? "cyanBright" : undefined} dimColor={i !== choice}>
              {"  "}
              {i === choice ? "▸" : " "} {o}
            </Text>
          ))}
        </Box>
      )}
      {item.kind === "rank" && (
        <Box flexDirection="column" marginTop={1}>
          {rankPicked.map((c, i) => (
            <Text key={c} color="green">
              {"  "}
              {String(i + 1)}. {c} <Text dimColor>weight {rankToWeight(i).toFixed(2)}</Text>
            </Text>
          ))}
          {remaining.map((c, i) => (
            <Text key={c} color={i === Math.min(rankCursor, remaining.length - 1) ? "cyanBright" : undefined} dimColor={i !== Math.min(rankCursor, remaining.length - 1)}>
              {"  "}
              {i === Math.min(rankCursor, remaining.length - 1) ? "▸" : " "} {c}
            </Text>
          ))}
        </Box>
      )}
      {item.kind === "text" && (
        <Box marginTop={1}>
          <Text>
            {"  › "}
            {text}
            <Text inverse> </Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {"  → "}
          {item.construct} · rule {item.rule}
          {item.kind === "likert" || item.kind === "rank" ? `  →  ${preview(item, sel)}` : ""}
        </Text>
      </Box>
      <Text dimColor>
        {"  "}
        {confirmQuit
          ? "leave the interview? y = leave (answers so far are kept) · any other key = stay"
          : item.kind === "likert"
            ? "1-5 or ←/→ · Enter confirm · s skip · b back · Esc leave"
            : item.kind === "choice"
              ? "↑/↓ · Enter confirm · s skip · b back · Esc leave"
              : item.kind === "rank"
                ? "↑/↓ · Enter pick next · u undo · d done · s skip · b back · Esc leave"
                : "type your answer · Enter confirm · s (on an empty field) skip · ← back · Esc leave"}
      </Text>
    </Box>
  );
}

/** Render the wizard on the live TTY and resolve with the collected answers. */
/**
 * @param onProgress called after each answer with everything recorded so far. The wizard
 *        stays UI-only: WHERE progress is persisted is the caller's business, and this hook
 *        is what makes a half-finished interview survive an abandoned run.
 */
export async function runInterviewWizard(
  items: InterviewItem[],
  onProgress?: (answers: InterviewAnswers) => void,
): Promise<InterviewAnswers> {
  const { render } = await import("ink");
  let resolved: InterviewAnswers = {};
  const app = render(
    <InterviewWizard
      items={items}
      onProgress={onProgress}
      onDone={(a) => {
        resolved = a;
      }}
    />,
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
  return resolved;
}
