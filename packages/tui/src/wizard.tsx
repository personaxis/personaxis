/**
 * Genesis interview wizard (F6.7b), the Ink front-end over the interview (`@personaxis/core`
 * genesis/interview.ts: a model writes the questions for what the sources leave open). This file owns ONLY
 * the keys and the pixels: one round of questions at a time, each with the line saying why it is asked.
 * Falls back to the CLI's readline path when Ink can't run (no TTY).
 */

import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { InterviewQuestion, Reply } from "@personaxis/core";

/** One answered or skipped question of this round, shown above the current one. */
interface TrailLine {
  id: string;
  text: string;
  skipped: boolean;
}

const short = (s: string, n = 70): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface InterviewWizardProps {
  questions: InterviewQuestion[];
  /** How many questions earlier rounds already asked. */
  asked: number;
  /** The most the whole interview asks. */
  limit: number;
  /** One reply per question reached; a `stop` reply ends the interview. */
  onDone: (replies: Reply[]) => void;
}

export function InterviewWizard(props: InterviewWizardProps): React.JSX.Element {
  const { exit } = useApp();
  const [idx, setIdx] = useState(0);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [trail, setTrail] = useState<TrailLine[]>([]);
  const [choice, setChoice] = useState(0);
  const [text, setText] = useState("");
  // V7.A4: leaving is a decision, never a slip. Esc asks; it never skips.
  const [confirmQuit, setConfirmQuit] = useState(false);
  /**
   * V7.A4: keystrokes already sitting in the buffer when the wizard mounts (the Enter that launched
   * `/create`, a stray key from the parent process) used to be consumed by the first question. Input is
   * ignored for the first beat.
   */
  const [armed, setArmed] = useState(process.env.PERSONAXIS_NO_ANIM === "1");
  useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), 120);
    return () => clearTimeout(t);
  }, [armed]);

  const q = props.questions[idx];
  const options = q?.options ?? [];

  const finish = (all: Reply[]): void => {
    props.onDone(all);
    exit();
  };

  const advance = (reply: Reply): void => {
    if (!q) return;
    const all = [...replies, reply];
    setReplies(all);
    setTrail((t) => [...t.slice(-4), { id: q.id, text: "answer" in reply ? `${short(q.question, 50)} ← ${short(reply.answer, 40)}` : `${short(q.question, 50)}, skipped`, skipped: !("answer" in reply) }]);
    setChoice(0);
    setText("");
    if (idx + 1 >= props.questions.length) finish(all);
    else setIdx(idx + 1);
  };

  /** V7.A4: go back one question and drop what it recorded, so it can be answered again. */
  const goBack = (): void => {
    if (idx === 0) return;
    setReplies((r) => r.slice(0, -1));
    setTrail((t) => t.slice(0, -1));
    setChoice(0);
    setText("");
    setIdx(idx - 1);
  };

  useInput((input, key) => {
    if (!armed || !q) return;
    if (confirmQuit) {
      if (input === "y" || input === "Y") return finish([...replies, { stop: true }]);
      setConfirmQuit(false);
      return;
    }
    if (key.escape) return setConfirmQuit(true);
    const empty = text.length === 0;
    if (key.leftArrow && empty) return goBack();
    // With nothing typed, the options are picked with the arrows or their number; typing writes your own.
    if (empty && options.length) {
      if (key.upArrow) return setChoice((v) => (v + options.length - 1) % options.length);
      if (key.downArrow) return setChoice((v) => (v + 1) % options.length);
      if (/^[1-9]$/.test(input) && Number(input) <= options.length) return setChoice(Number(input) - 1);
    }
    if (key.return) {
      if (!empty && text.trim()) return advance({ answer: text.trim() });
      if (empty && options.length) return advance({ answer: options[choice]! });
      return; // nothing to record: Enter on an empty field never skips by accident
    }
    if (key.backspace || key.delete) return setText((t) => t.slice(0, -1));
    // `s` alone on an empty field skips; "something" keeps its s.
    if (input === "s" && empty) return advance({ skip: true });
    if (input && !key.ctrl && !key.meta) setText((t) => t + input);
  });

  if (!q) return <Text />;
  const number = props.asked + idx + 1;
  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Box>
        <Text bold>◉ personaxis · Genesis interview </Text>
        <Text dimColor>
          question {String(number)}, at most {String(props.limit)} · the model asks only what your sources leave open
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
        <Text dimColor>{`  ${q.why}`}</Text>
      </Box>
      <Text color="cyan" bold>
        {`  ${q.question}`}
      </Text>
      {options.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {options.map((o, i) => (
            <Text key={o} color={text.length === 0 && i === choice ? "cyanBright" : undefined} dimColor={text.length > 0 || i !== choice}>
              {"  "}
              {text.length === 0 && i === choice ? "▸" : " "} {String(i + 1)}. {o}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          {"  › "}
          {text}
          <Text inverse> </Text>
        </Text>
      </Box>
      <Text dimColor>
        {"  "}
        {confirmQuit
          ? "leave the interview? y = leave (answers so far are kept) · any other key = stay"
          : options.length
            ? "↑/↓ or a number picks · or type your own · Enter confirm · s skip · ← back · Esc leave"
            : "type your answer · Enter confirm · s (on an empty field) skip · ← back · Esc leave"}
      </Text>
    </Box>
  );
}

/** Put one round of questions on the live TTY and resolve with one reply per question reached. */
export async function runInterviewWizard(questions: InterviewQuestion[], asked: number, limit: number): Promise<Reply[]> {
  const { render } = await import("ink");
  let resolved: Reply[] = [];
  const app = render(
    <InterviewWizard
      questions={questions}
      asked={asked}
      limit={limit}
      onDone={(r) => {
        resolved = r;
      }}
    />,
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
  return resolved;
}
